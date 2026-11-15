#!/usr/bin/env python
"""mesh_report.py — разбор STL/3MF без ручных проб.

Заменяет probe1..21 + compare.py: один прогон даёт все числа, которые нужны
для реверса детали, плюс метрику качества, если дать вторую сетку.

  python mesh_report.py part.stl
  python mesh_report.py part.stl --compare model.stl --png diff.png --json out.json
  python mesh_report.py part.stl --levels 1,2,3,4.85 --ransac

Зависимости: trimesh, shapely, networkx (сечения), pyransac3d (цилиндры),
matplotlib (картинки). Ставятся в отдельный venv, SOMA трогать не надо.
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np
import trimesh

COS30 = math.cos(math.pi / 6)


# ---------------------------------------------------------------- загрузка

def load(path):
    m = trimesh.load_mesh(path, force="mesh")
    if isinstance(m, trimesh.Scene):
        m = trimesh.util.concatenate([g for g in m.geometry.values()])
    m.merge_vertices()
    m.fix_normals(multibody=True)
    return m


def mesh_stats(m):
    ext = m.bounding_box.extents
    stats = {
        "triangles": int(len(m.faces)),
        "vertices": int(len(m.vertices)),
        "watertight": bool(m.is_watertight),
        "winding_consistent": bool(m.is_winding_consistent),
        "euler": int(m.euler_number),
        "volume_mm3": round(float(m.volume), 4),
        "area_mm2": round(float(m.area), 4),
        "bbox_raw": [round(float(x), 4) for x in ext],
        "bbox_main_axes": [round(float(x), 4) for x in m.bounding_box_oriented.primitive.extents],
        "bodies": int(len(m.split(only_watertight=False))),
        "principal_axes": [[round(float(v), 6) for v in row] for row in m.principal_inertia_vectors],
        "note": "bbox_raw — габарит как в файле; bbox_main_axes — по главным осям",
    }
    if m.is_watertight:
        stats["center_mass"] = [round(float(x), 4) for x in m.center_mass]
    return stats


# ---------------------------------------------------------------- плоскости

def planes(m, top=14, merge_tol=0.02):
    """Сначала связные плоские пятна (facets), потом их склейка по (нормаль, отступ)."""
    patches = []
    for area, nrm, org, idx in zip(m.facets_area, m.facets_normal, m.facets_origin, m.facets):
        patches.append({
            "area": float(area),
            "normal": np.round(nrm, 3),
            "offset": float(np.dot(nrm, org)),
            "triangles": int(len(idx)),
        })
    patches.sort(key=lambda p: -p["area"])
    merged = {}
    for p in patches:
        key = (tuple(p["normal"]), round(p["offset"] / merge_tol) * merge_tol)
        if key in merged:
            merged[key]["area"] += p["area"]
            merged[key]["patches"] += 1
        else:
            merged[key] = {"area": p["area"], "normal": p["normal"].tolist(),
                           "offset": key[1], "patches": 1}
    flat = sorted(merged.values(), key=lambda p: -p["area"])[:top]
    for p in flat:
        p["area"] = round(p["area"], 3)
        p["offset"] = round(p["offset"], 3)
    return flat


# ---------------------------------------------------------------- кольца

def _circle_fit(pts):
    """Алгебраическая подгонка круга: x^2 + y^2 = 2*cx*x + 2*cy*y + c."""
    A = np.c_[2 * pts[:, 0], 2 * pts[:, 1], np.ones(len(pts))]
    b = (pts ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = float(sol[0]), float(sol[1])
    r = math.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0))
    resid = float(np.abs(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy) - r).max())
    return cx, cy, r, resid


def _ring_class(coords, dir_tol=4.0):
    """Кольцо -> круг, шестиугольник или квадрат с размерами.

    Ключевое: AF — это расстояние между плоскостями, а не радиус вершины.
    У гнезда с округлёнными рёбрами на плоскостях вершин нет вообще, и замер
    по вершинам даёт бред (круг вместо гекса). Поэтому считаются расстояния
    от центра до каждой кромки, а AF = 2 * min(d). AC = 2 * max|вершина|.
    """
    pts = np.asarray(coords, dtype=float)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    n = len(pts)
    if n < 6:
        return None
    c = pts.mean(axis=0)
    rel = pts - c
    r = np.hypot(rel[:, 0], rel[:, 1])
    r_max = float(r.max())
    if r_max <= 0:
        return None

    # кромки: смещение центра кромки от центра + нормаль кромки
    nxt = np.roll(pts, -1, axis=0)
    e = nxt - pts
    L = np.hypot(e[:, 0], e[:, 1])
    ok = L > 1e-9
    if ok.sum() < 5:
        return None
    e, mid, L = e[ok], (pts[ok] + nxt[ok]) / 2, L[ok]
    nrm = np.c_[-e[:, 1], e[:, 0]] / L[:, None]
    d = np.abs(np.einsum("ij,ij->i", nrm, mid - c))     # расстояние центр -> кромка
    ang = np.degrees(np.arctan2(nrm[:, 1], nrm[:, 0])) % 180.0

    d_min = float(d.min())
    ratio = d_min / r_max                                    # круг: 1.0, гекс: 0.866

    # сколько разных направлений дают минимальное расстояние
    near = d <= d_min * 1.02
    dirs = []
    for a in ang[near]:
        if not any(min(abs(a - b), 180 - abs(a - b)) < dir_tol for b in dirs):
            dirs.append(a)
    k = len(dirs)

    # Круг от многоугольника отличаем по ЧИСЛУ плоскостей, а не по допуску на
    # отношение: 12-гранная тесселяция отверстия даёт ratio 0.966 — как у
    # настоящего 12-угольника, и по ratio её от «poly6» не отличить.
    if k >= 5 or ratio > 0.985:                               # круг
        r_med = float(np.median(r))
        return {"kind": "circle", "D": round(2 * r_med, 3),
                "D_in": round(2 * float(r.min()), 3),
                "D_out": round(2 * r_max, 3),
                "center": [round(float(x), 3) for x in c],
                "verts": n, "edges": int(len(d)), "planes": k}
    if ratio < 0.60:
        return None                                           # не правильный многоугольник
    if k not in (2, 3):
        return None
    kind = "hex" if k == 3 else "square"
    # поворот: угол нормали первой плоскости (для шестигранника +30° = угол вершины)
    rot = dirs[0]
    return {"kind": kind,
            "AF": round(2 * d_min, 3), "AC": round(2 * r_max, 3),
            "ratio": round(ratio, 4),
            "rot_deg": round(float(rot), 2),
            "rot_vertex_deg": round(float((rot + 30) % 60), 2) if kind == "hex" else None,
            "center": [round(float(x), 3) for x in c],
            "verts": n, "edges": int(len(d)), "planes": k}


def sections(m, levels):
    """Площадь (shapely, дырки вычитаются) и классифицированные внутренние кольца."""
    out = []
    for z in levels:
        sec = m.section(plane_normal=[0, 0, 1], plane_origin=[0, 0, z])
        if sec is None:
            out.append({"z": round(float(z), 4), "net_area": 0.0, "polys": 0})
            continue
        p2, _ = sec.to_2D()
        polys = list(p2.polygons_full)
        rec = {
            "z": round(float(z), 4),
            "net_area": round(float(sum(p.area for p in polys)), 4),
            "polys": len(polys),
            "holes": int(sum(len(p.interiors) for p in polys)),
        }
        if polys:
            allpts = np.vstack([np.asarray(p.exterior.coords) for p in polys])
            rec["bbox_xy"] = [round(float(v), 3) for v in np.ptp(allpts, axis=0)]
            found, unknown = [], []
            for p in polys:
                for ring in p.interiors:
                    cls = _ring_class(ring.coords)
                    if cls:
                        found.append(cls)
                    else:
                        # контур есть, но это не круг/гекс/квадрат: гравюра,
                        # паз, выборка сложной формы. Молча терять нельзя —
                        # человек должен увидеть, что инструмент тут не понял
                        q = np.asarray(ring.coords)[:-1]
                        c0 = q.mean(axis=0)
                        r0 = np.hypot(q[:, 0] - c0[0], q[:, 1] - c0[1])
                        qn = np.roll(q, -1, axis=0)
                        enclosed = 0.5 * abs(float(np.sum(q[:, 0] * qn[:, 1] - qn[:, 0] * q[:, 1])))
                        unknown.append({"z": round(float(z), 3), "verts": int(len(q)),
                                        "area": round(enclosed, 3),
                                        "r_min": round(float(r0.min()), 3),
                                        "r_max": round(float(r0.max()), 3),
                                        "center": [round(float(c0[0]), 2), round(float(c0[1]), 2)]})
            if found:
                rec["rings"] = found
            if unknown:
                rec["unknown"] = unknown
        out.append(rec)
    return out


def features(sect_list, tol_d=0.05, tol_c=0.35):
    """Склейка одинаковых колец по уровням -> отверстия и гнёзда с границами по Z."""
    groups = []
    for s in sect_list:
        for r in s.get("rings", []):
            size = r["D"] if r["kind"] == "circle" else r["AC"]
            hit = None
            for g in groups:
                if g["kind"] != r["kind"]:
                    continue
                if abs(size - g["size"]) <= max(tol_d, 0.03 * g["size"]) and \
                        math.dist(r["center"], g["center"]) <= tol_c:
                    hit = g
                    break
            if hit is None:
                hit = {"kind": r["kind"], "size": size, "center": r["center"],
                       "zs": [], "samples": []}
                groups.append(hit)
            hit["zs"].append(s["z"])
            hit["samples"].append(r)

    out = []
    dropped = 0
    for g in groups:
        zs = sorted(g["zs"])
        smp = g["samples"]
        rec = {"kind": g["kind"], "center": g["center"],
               "z_from": round(min(zs), 3), "z_to": round(max(zs), 3),
               "depth": round(max(zs) - min(zs), 3), "levels": len(zs)}
        if g["kind"] == "circle":
            rec["D"] = round(float(np.median([s["D"] for s in smp])), 3)
            rec["D_min"] = round(min(s["D"] for s in smp), 3)
            rec["D_max"] = round(max(s["D"] for s in smp), 3)
            rec["D_in"] = round(min(s["D_in"] for s in smp), 3)
            rec["D_out"] = round(max(s["D_out"] for s in smp), 3)
            rec["label"] = "круглое отверстие/расточка"
        else:
            rec["AF"] = round(float(np.median([s["AF"] for s in smp])), 3)
            rec["AC"] = round(float(np.median([s["AC"] for s in smp])), 3)
            rec["rot_deg_plane"] = round(float(np.median([s["rot_deg"] for s in smp])), 2)
            if g["kind"] == "hex":
                rec["rot_deg_vertex"] = round(float(np.median(
                    [s["rot_vertex_deg"] for s in smp if s.get("rot_vertex_deg") is not None])), 2)
            rec["label"] = {"hex": "шестигранное гнездо", "square": "квадратное гнездо"}[g["kind"]]
        out.append(rec)
    # кольцо, которое живёт меньше 0.4 мм по высоте — это расширение у входа
    # в гнездо или скругление кромки, а не самостоятельная фича
    out = [r for r in out if r["depth"] >= 0.4]
    out.sort(key=lambda r: (r["kind"] != "hex", -r["depth"]))
    return out


def unknown_rings(sect_list, tol=0.6):
    """Нераспознанные контуры: где, на какой высоте, сколько вершин."""
    groups = []
    for s in sect_list:
        for u in s.get("unknown", []):
            hit = None
            for g in groups:
                if abs(u["r_max"] - g["r_max"]) <= tol and abs(u["verts"] - g["verts"]) <= 2 * max(1, u["verts"] // 10):
                    hit = g
                    break
            if hit is None:
                hit = {"verts": u["verts"], "r_min": u["r_min"], "r_max": u["r_max"],
                       "area": u["area"], "zs": [], "center": u["center"]}
                groups.append(hit)
            hit["zs"].append(u["z"])
            hit["area"] = max(hit["area"], u["area"])
    out = []
    dropped = 0
    for g in groups:
        # сечение, прошедшее ровно по грани, даёт вырожденный контур нулевой
        # площади: это артефакт среза, а не фича детали. Ноль в отчёте пугает
        # зря ("нераспознанный контур!"), поэтому такие группы отбрасываем.
        if g["area"] < 0.05:
            dropped += 1
            continue
        zs = sorted(g["zs"])
        out.append({"verts": g["verts"], "r_min": g["r_min"], "r_max": g["r_max"],
                    "area": g["area"], "z_from": round(min(zs), 2), "z_to": round(max(zs), 2),
                    "levels": len(zs), "center": g["center"]})
    out.sort(key=lambda g: -g["area"])
    return out, dropped


def jumps(sect_list, tol=0.10):
    """Где площадь скачет — там ступенька, конец фаски, начало гнезда."""
    out = []
    prev = None
    mx = max([s.get("net_area") or 0 for s in sect_list] + [1e-9])
    for s in sect_list:
        if prev and prev["net_area"]:
            pct = 100 * (s["net_area"] - prev["net_area"]) / prev["net_area"]
            # процент имеет смысл только когда база не сопоставима с нулём:
            # у кольца площадь на уровне 0.02 близка к 0 и даёт «+5158 %»
            if abs(pct) > 100 * tol:
                out.append({"z_from": prev["z"], "z_to": s["z"],
                            "dA": round(s["net_area"] - prev["net_area"], 3),
                            "area_from": round(prev["net_area"], 3),
                            "pct": round(pct, 1) if prev["net_area"] > 0.05 * mx else None})
        prev = s
    return out


# ---------------------------------------------------------------- цилиндры

def _angular_coverage(pts, axis, center, bins=36):
    """Какая доля окружности заполнена точками. Плоскость даёт 1-3 бина из 36."""
    a = axis / (np.linalg.norm(axis) or 1.0)
    ref = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(a, ref)
    u /= np.linalg.norm(u) or 1.0
    v = np.cross(a, u)
    rel = pts - center
    ang = np.arctan2(rel @ v, rel @ u)
    occ = np.zeros(bins, dtype=bool)
    occ[np.clip(((ang + np.pi) / (2 * np.pi) * bins).astype(int) % bins, 0, bins - 1)] = True
    return float(occ.mean())


def cylinders(m, thresh=0.02, min_points=24, max_k=8, min_cover=0.45):
    """RANSAC по вершинам с фильтром по покрытию: без него плоскость сойдёт за цилиндр."""
    from pyransac3d import Cylinder

    work = np.asarray(m.vertices, dtype=np.float64)
    size = float(m.scale)
    found = []
    for _ in range(max_k):
        if len(work) < min_points:
            break
        res = Cylinder().fit(work, thresh=thresh, maxIteration=3000)
        if res is None or not getattr(res, "radius", None):
            break
        inl = np.asarray(res.inliers, dtype=int)
        if len(inl) < min_points:
            break
        axis = np.asarray(res.axis, dtype=float)
        axis /= np.linalg.norm(axis) or 1.0
        center = np.asarray(res.center, dtype=float)
        cover = _angular_coverage(work[inl], axis, center)
        span = work[inl] @ axis
        keep = np.ones(len(work), dtype=bool)
        keep[inl] = False
        work = work[keep]
        d = 2 * float(res.radius)
        if d > size * 1.2 or cover < min_cover:
            continue  # пятно плоскости, подогнанное под огромный радиус
        found.append({
            "diameter": round(d, 3),
            "axis": [round(float(x), 3) for x in axis],
            "center": [round(float(x), 3) for x in center],
            "points": int(len(inl)),
            "coverage": round(cover, 3),
            "span_along_axis": round(float(span.max() - span.min()), 3),
        })

    uniq = []
    for c in found:
        if not any(
            abs(c["diameter"] - u["diameter"]) < 0.05 * u["diameter"]
            and abs(abs(np.dot(c["axis"], u["axis"])) - 1) < 0.02
            and math.dist(c["center"], u["center"]) < 1.0
            for u in uniq
        ):
            uniq.append(c)
    uniq.sort(key=lambda c: -c["points"])
    return uniq


# ---------------------------------------------------------------- сверка

def _pca_frame(mesh, n=6000, seed=0):
    """Центр масс + главные оси по облаку точек поверхности."""
    pts, _ = trimesh.sample.sample_surface(mesh, n, seed=seed)
    c = pts.mean(axis=0)
    w, V = np.linalg.eigh(np.cov((pts - c).T))
    order = np.argsort(w)[::-1]
    return c, V[:, order]


def align_to(mine, ref, iterations=40):
    """Совместить модель с эталоном: главные оси + подбор знаков + ICP.

    Без этого сверка бессмысленна: у STL из интернета своя система координат,
    и любая модель получит «среднее 6 мм» просто из-за поворота.
    """
    c_ref, A_ref = _pca_frame(ref, seed=0)
    c_min, A_min = _pca_frame(mine, seed=1)
    pts, _ = trimesh.sample.sample_surface(mine, 3000, seed=2)

    best = None
    for sx in (1, -1):
        for sy in (1, -1):
            for sz in (1, -1):
                S = np.diag([sx, sy, sz])
                R = A_ref @ S @ A_min.T
                if np.linalg.det(R) < 0:
                    continue
                q = (pts - c_min) @ R.T + c_ref
                _, d, _ = trimesh.proximity.closest_point(ref, q)
                score = float(np.median(d))
                if best is None or score < best[0]:
                    best = (score, R)
    _, R = best
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = c_ref - R @ c_min
    mine_a = mine.copy()
    mine_a.apply_transform(M)

    # ICP в trimesh 5.x оценивает similarity-преобразование и подтягивает МАСШТАБ
    # (на тестовой детали — 0.987 по каждой оси, объём уезжал на 4 %). Для сверки
    # размеров масштаб надо жёстко выкидывать, иначе «модель меньше эталона»
    # будет артефактом совмещения, а не ошибкой модели.
    icp_err = None
    for _ in range(2 if iterations else 0):
        try:
            T = trimesh.registration.icp(
                np.asarray(mine_a.vertices), ref,
                initial=np.eye(4), max_iterations=iterations, threshold=2.0)[0]
            s_icp = np.cbrt(np.linalg.det(T[:3, :3]))
            if not np.isfinite(s_icp) or s_icp <= 0:
                break
            T[:3, :3] /= s_icp
            U, _, Vt = np.linalg.svd(T[:3, :3])                  # обратно в SO(3)
            T[:3, :3] = U @ Vt
            M = T @ M
            mine_a.apply_transform(T)
            _, d_now, _ = trimesh.proximity.closest_point(
                ref, trimesh.sample.sample_surface(mine_a, 3000, seed=3)[0])
            icp_err = round(float(np.median(d_now)), 4)
        except Exception as e:                                  # ICP не обязателен
            icp_err = "icp failed: %s" % e
            break
    return mine_a, M, icp_err


def compare(ref, mine, samples=20000, png=None, align=True):
    """Расстояние между поверхностями в обе стороны — настоящий гейт качества."""
    icp_err = None
    vol_before = float(mine.volume)
    if align:
        mine, M, icp_err = align_to(mine, ref)
    a, _ = trimesh.sample.sample_surface(mine, samples, seed=1)
    _, d1, _ = trimesh.proximity.closest_point(ref, a)
    b, _ = trimesh.sample.sample_surface(ref, samples, seed=2)
    _, d2, _ = trimesh.proximity.closest_point(mine, b)
    d = np.r_[d1, d2]
    res = {
        "mean": round(float(d.mean()), 4),
        "median": round(float(np.median(d)), 4),
        "p95": round(float(np.percentile(d, 95)), 4),
        "max": round(float(d.max()), 4),
        "pct_gt_0.1": round(float(100 * (d > 0.1).mean()), 2),
        "pct_gt_0.4": round(float(100 * (d > 0.4).mean()), 2),
        "volume_ref": round(float(ref.volume), 3),
        "volume_mine": round(vol_before, 3),
        "volume_aligned": round(float(mine.volume), 3),
        "volume_pct": round(100 * vol_before / float(ref.volume), 2),
        "euler_ref": int(ref.euler_number),
        "euler_mine": int(mine.euler_number),
        "watertight_ref": bool(ref.is_watertight),
        "watertight_mine": bool(mine.is_watertight),
        "aligned": bool(align),
        "icp_cost": icp_err,
    }
    worst = np.argsort(d1)[::-1][:5]
    res["worst_points_on_model"] = [
        {"d": round(float(d1[i]), 3), "p": [round(float(v), 2) for v in a[i]]} for i in worst
    ]
    if png:
        _render_diff(ref, mine, a, d1, png)
        res["png"] = png
    return res


def _render_diff(ref, mine, pts, dist, png):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(13, 5.2), dpi=130)
    ax = fig.add_subplot(1, 2, 1)
    ax.hist(dist, bins=60, color="#d81b60", alpha=0.85)
    ax.set_xlabel("расстояние до эталона, мм")
    ax.set_ylabel("точек")
    ax.set_title("распределение расхождения")
    ax.grid(alpha=0.25)

    ax = fig.add_subplot(1, 2, 2)
    sc = ax.scatter(pts[:, 0], pts[:, 1], c=dist, s=3, cmap="inferno",
                    vmax=float(np.percentile(dist, 99)))
    fig.colorbar(sc, ax=ax, label="мм")
    ax.set_aspect("equal")
    ax.set_title("где именно наврал (вид сверху)")
    ax.set_xlabel("X, мм")
    ax.set_ylabel("Y, мм")
    fig.tight_layout()
    fig.savefig(png)
    plt.close(fig)


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description="Разбор STL: числа для реверса + гейт качества")
    ap.add_argument("stl")
    ap.add_argument("--compare", help="вторая сетка (модель) для сверки")
    ap.add_argument("--levels", help="уровни сечений по Z через запятую")
    ap.add_argument("--step", type=float, default=0.25, help="шаг сканирования по Z, мм")
    ap.add_argument("--ransac", action="store_true", help="искать цилиндры RANSAC")
    ap.add_argument("--json", dest="json_path")
    ap.add_argument("--png")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    m = load(args.stl)
    rep = {"file": args.stl, "mesh": mesh_stats(m)}

    zmin, zmax = float(m.bounds[0][2]), float(m.bounds[1][2])
    if args.levels:
        levels = [float(x) for x in args.levels.split(",")]
    else:
        levels = list(np.arange(zmin + 0.02, zmax - 0.01, max(args.step, 0.05)))

    rep["planes"] = planes(m)
    rep["sections"] = sections(m, levels)
    rep["jumps"] = jumps(rep["sections"])
    rep["features"] = features(rep["sections"])
    rep["unknown_rings"], rep["unknown_dropped"] = unknown_rings(rep["sections"])
    if args.ransac:
        rep["cylinders"] = cylinders(m)
    if args.compare:
        rep["compare"] = compare(m, load(args.compare), png=args.png)

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        if not args.quiet:
            print("json:", args.json_path)

    if args.quiet:
        return 0

    s = rep["mesh"]
    print("%s\n  %d треугольников, %d вершин, watertight=%s, euler=%d, тел %d"
          % (args.stl, s["triangles"], s["vertices"], s["watertight"], s["euler"], s["bodies"]))
    print("  габарит в файле %.3f x %.3f x %.3f мм | по главным осям %.3f x %.3f x %.3f мм"
          % (*s["bbox_raw"], *s["bbox_main_axes"]))
    print("  объём %.2f мм³, площадь %.1f мм²" % (s["volume_mm3"], s["area_mm2"]))

    print("\nплоскости (площадь, нормаль, отступ от начала):")
    for q in rep["planes"][:8]:
        print("  %7.2f мм²  n=%-24s d=%7.2f  пятен %d"
              % (q["area"], str(q["normal"]), q["offset"], q["patches"]))

    print("\nфичи из сечений:")
    if not rep["features"]:
        print("  (внутренних колец не найдено)")
    for f in rep["features"]:
        if f["kind"] == "circle":
            print("  круг Ø%-7.3f (%.3f…%.3f)  z %.2f…%.2f  глубина %.2f  центр %s"
                  % (f["D"], f["D_min"], f["D_max"], f["z_from"], f["z_to"],
                     f["depth"], f["center"]))
        else:
            print("  %s AF %-6.3f AC %-6.3f  z %.2f…%.2f  глубина %.2f  центр %s"
                  % (f.get("label", f["kind"]), f["AF"], f["AC"], f["z_from"], f["z_to"],
                     f["depth"], f["center"]))

    if rep.get("unknown_dropped"):
        print("\nвырожденных срезов пропущено: %d (площадь ~0: сечение прошло по грани)"
              % rep["unknown_dropped"])
    if rep.get("unknown_rings"):
        print("\nнераспознанные контуры (%d) — инструмент их видит, но не называет:" % len(rep["unknown_rings"]))
        for u in rep["unknown_rings"][:6]:
            print("  %d вершин, r %.2f…%.2f, площадь %.2f мм², z %.2f…%.2f, уровней %d, центр %s"
                  % (u["verts"], u["r_min"], u["r_max"], u["area"],
                     u["z_from"], u["z_to"], u["levels"], u["center"]))

    if rep["jumps"]:
        print("\nскачки площади (ступеньки по Z):")
        for jj in rep["jumps"][:10]:
            print("  %.2f -> %.2f: dA %+8.2f мм²%s"
                  % (jj["z_from"], jj["z_to"], jj["dA"],
                     "" if jj.get("pct") is None else " (%+.1f%%)" % jj["pct"]))

    if "cylinders" in rep:
        print("\nцилиндры (RANSAC, покрытие по углу):")
        for c in rep["cylinders"]:
            print("  Ø%-7.3f длина %-6.2f покрытие %-5.2f ось %s центр %s точек %d"
                  % (c["diameter"], c["span_along_axis"], c["coverage"],
                     c["axis"], c["center"], c["points"]))

    if "compare" in rep:
        c = rep["compare"]
        print("\nсверка с %s:" % args.compare)
        print("  объём до/после совмещения: %.2f / %.2f мм³ (масштаб не трогаем)"
              % (c["volume_mine"], c.get("volume_aligned", 0)))
        print("  совмещение: %s (ICP медиана %s мм)"
              % ("главные оси + ICP" if c.get("aligned") else "выключено",
                 c.get("icp_cost")))
        print("  объём модели %.2f %% эталона (%.2f / %.2f мм³), герметична: %s"
              % (c["volume_pct"], c["volume_mine"], c["volume_ref"], c["watertight_mine"]))
        print("  нечётных рёбер: модель euler=%d, эталон euler=%d"
              % (c["euler_mine"], c["euler_ref"]))
        print("  расхождение поверхностей: среднее %.3f, медиана %.3f, p95 %.3f, max %.3f мм"
              % (c["mean"], c["median"], c["p95"], c["max"]))
        print("  точек > 0.1 мм: %.1f %%, > 0.4 мм: %.1f %%"
              % (c["pct_gt_0.1"], c["pct_gt_0.4"]))
        for w in c["worst_points_on_model"][:3]:
            print("  худшая точка %s -> %.3f мм" % (w["p"], w["d"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
