"""Автоподбор параметров модели по эталонному STL. Деталь — любая.

Зачем: параметры детали иначе подгоняются руками — пересобрал, посмотрел сечения,
поправил, пересобрал. Это машинная работа: `scipy.optimize.least_squares` делает её
по расстоянию поверхностей, а не по объёму (объём — слепая метрика: 99.7 % объёма
при 14 % поверхности дальше 0.4 мм).

Контракт модели (подходит любой из трёх, см. templates/soma_part_example.py):

  * SOMA-скрипт: `from soma import param, add_part`; каждое крутимое число —
    `param(<значение>, "подпись", min=..., max=...)`, тело — `add_part("Имя", body)`;
  * обычный CadQuery-скрипт с функцией `build()` (или `make()`/`model()`);
  * переменная модуля `BODY` / `SHAPE` / `PART` / `SOLID`.

Как работает:

1. читает файл модели, находит `NAME = param(<значение>, ...)` и границы min/max
   (нет границ — ±--margin от значения, по умолчанию 2 %);
2. подсовывает заглушку модуля `soma` — модель строится тем же cadquery, но без
   запуска SOMA на каждый шаг (иначе +4 с на итерацию). Сборка идёт с временной
   копии, рабочий файл не трогается до `--apply`;
3. на каждой точке профилирует позу (главные оси + перебор знаков + ICP Kabsch без
   масштаба), а не замораживает её один раз: у симметричных деталей пара
   «параметры + поза» имеет несколько ям, и замороженная поза держит поиск в мелкой;
4. невязки — расстояния между поверхностями в обе стороны (модель→эталон и
   эталон→модель): одна сторона ловит «модель меньше», другая — «модель больше»;
5. least_squares с относительным шагом по параметрам; каждая точка — в CSV;
6. в конце: таблица «было → стало», лучший вариант, худшие точки, и запись значений
   в файл модели только по флагу --apply.

Запуск (нужен py: cadquery + trimesh + scipy + numpy):

    V=C:/Users/boot8/tools/meshrev/venv/Scripts/python.exe
    "$V" fit_params.py --model model.py --ref part.stl \
                       --params W,D,T --mode sweep --csv fit.csv [--apply]

Сначала `--mode sweep` (покоординатная сетка: видно, различается ли параметр вообще),
потом при нужде `--mode both`. Самотест на посторонней детали: test_fit_universal.py.
"""
import argparse
import importlib
import importlib.util
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import types

import numpy as np

# param() может занимать две строки, а в подписи бывают скобки
# («размер под ключ (5.50 = впритык)») — поэтому тело ищем сканером, не регуляркой.
PARAM_RE = re.compile(r"(?m)^([A-Za-z_]\w*)[ \t]*=[ \t]*param\(")
NUM_RE = re.compile(r"-?[0-9]+\.?[0-9]*")


def _param_spans(src):
    """(имя, начало тела, конец тела) для каждого param(...) с учётом скобок и кавычек."""
    for mo in PARAM_RE.finditer(src):
        i, depth, quote = mo.end(), 1, None
        while i < len(src) and depth:
            ch = src[i]
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        yield mo.group(1), mo.end(), i - 1


def read_params(path):
    """{имя: {value, lo, hi}} из `NAME = param(значение, 'подпись', min=.., max=..)`."""
    src = open(path, encoding="utf-8").read()
    out = {}
    for name, a, b in _param_spans(src):
        body = src[a:b]
        mv = NUM_RE.search(body)
        if not mv:
            continue

        def num(key):
            m = re.search(key + r"\s*=\s*(-?[0-9]+\.?[0-9]*)", body)
            return float(m.group(1)) if m else None

        out[name] = {"value": float(mv.group(0)), "lo": num("min"), "hi": num("max")}
    return out


def fmt_num(v):
    """Короткая запись числа без хвостовых нулей: 5.2 вместо 5.2000."""
    t = ("%.4f" % v).rstrip("0").rstrip(".")
    return t if t not in ("", "-") else "0"


def write_params(path, values):
    """Вписать значения в model.py точечно, не трогая остальной файл."""
    src = open(path, encoding="utf-8").read()
    spans = []
    for name, a, b in _param_spans(src):
        if name not in values:
            continue
        mv = NUM_RE.search(src[a:b])
        if mv:
            spans.append((a + mv.start(), a + mv.end(), values[name]))
    for a, b, v in sorted(spans, reverse=True):
        old = src[a:b]
        # то же значение — оставляем исходный текст (иначе подбор «переформатирует»
        # весь файл и в диффе не видно, что реально изменилось)
        if abs(float(old) - float(v)) < 1e-12:
            continue
        src = src[:a] + fmt_num(v) + src[b:]
    open(path, "w", encoding="utf-8", newline="").write(src)


# ------------------------------------------------------------------ сборка модели

def _soma_stub():
    """Заглушка soma: param() отдаёт значение, add_part() складывает тело."""
    mod = types.ModuleType("soma")
    parts = {}
    mod.param = lambda value, *a, **k: value
    mod.add_part = lambda name, body: parts.__setitem__(name, body)
    mod.parts = parts
    return mod, parts


MESH_TOL = {"v": 0.008, "ang": 0.06}


def set_mesh_tol(v=None, ang=None):
    """Допуск мешера. Меняется из CLI; по умолчанию 0.008 мм / 0.06 рад."""
    if v is not None:
        MESH_TOL["v"] = float(v)
    if ang is not None:
        MESH_TOL["ang"] = float(ang)
    return MESH_TOL["v"], MESH_TOL["ang"]


def args_tol():
    return MESH_TOL["v"]


def _collect(res, parts):
    """Сложить тело (Workplane, Shape, список) в parts. Молча пропускает пустое."""
    if res is None:
        return
    if hasattr(res, "val"):
        res = res.val()
    if isinstance(res, (list, tuple)):
        for r in res:
            _collect(r, parts)
        return
    try:
        if hasattr(res, "Volume") and res.Volume() > 1e-6:
            parts["_shape%d" % len(parts)] = res
    except Exception:
        pass


def build_stl(model_path, out_stl, modname="_model_fit"):
    """Собрать model.py в STL одним импортом. Кидает исключение, если тела нет.

    Контракт (первый подходящий):
      1) SOMA: `from soma import param, add_part` + `add_part("Имя", body)`;
      2) обычный CadQuery-скрипт: функция build()/make()/model(), возвращающая тело;
      3) переменная модуля BODY / SHAPE / PART / SOLID / res.
    `param(...)` в SOMA-режиме подменяется заглушкой и отдаёт текущее число из файла.
    """
    root = os.path.dirname(os.path.abspath(model_path))
    if root not in sys.path:
        sys.path.insert(0, root)
    mod, parts = _soma_stub()
    sys.modules["soma"] = mod                     # model.py делает `from soma import ...`
    sys.modules.pop(modname, None)                # чистый повторный импорт
    spec = importlib.util.spec_from_file_location(modname, model_path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[modname] = m
    spec.loader.exec_module(m)
    if not mod.parts:                       # не SOMA-скрипт: пробуем функции и переменные
        for attr in ("build", "make", "model"):
            fn = getattr(m, attr, None)
            if callable(fn):
                try:
                    _collect(fn(), mod.parts)
                except TypeError:
                    continue
                if mod.parts:
                    break
    if not mod.parts:
        for attr in ("BODY", "SHAPE", "PART", "SOLID", "res"):
            if hasattr(m, attr):
                _collect(getattr(m, attr), mod.parts)
                if mod.parts:
                    break
    if not mod.parts:
        raise RuntimeError("модель ничего не построила: нет add_part(), build() и BODY/SHAPE/PART")
    name, body = next(iter(mod.parts.items()))
    import cadquery as cq
    shape = body.val() if hasattr(body, "val") else body
    if shape is None or shape.Volume() <= 1e-6:
        raise RuntimeError("пустое тело %s" % name)
    # Допуск мешера должен быть МЕЛЬЧЕ шага подбора: при tolerance 0.02 разные
    # значения параметра дают буквально одинаковый STL (проверено: WING_Y0 -2.657
    # и -2.613 -> один и тот же объём 650.0629), и оптимизатор видит ступеньки.
    cq.exporters.export(body, out_stl, tolerance=MESH_TOL["v"],
                        angularTolerance=MESH_TOL["ang"])
    return out_stl



# ------------------------------------------------------- расстояния до поверхности

class Surf:
    """Расстояния до поверхности: точные и грубые-но-быстрые.

    Точные (`exact`) — это `trimesh.proximity.closest_point`, по 0.17 мс на точку:
    для отчёта и для цели подбора годится, для сотен итераций ICP — нет.
    Грубые (`cloud`) — KD-дерево по плотному облаку точек поверхности: 2400 точек
    за 4 мс вместо 470. Ошибка ≤ половины шага облака (~0.07 мм при 120k точек),
    этого хватает, чтобы поставить позу, а точную доводку делает `exact`.
    """

    def __init__(self, mesh, n=120000):
        import scipy.spatial as sp
        import trimesh
        self.mesh = mesh
        pts, _ = trimesh.sample.sample_surface(mesh, n, seed=3)
        self.cloud = np.asarray(pts, dtype=np.float64)
        self.tree = sp.cKDTree(self.cloud)

    def cloud_dist(self, pts):
        """Быстрое расстояние до облака точек поверхности (миллисекунды)."""
        return self.tree.query(np.asarray(pts, dtype=np.float64), k=1, workers=-1)[0]

    def exact(self, pts):
        """Точное расстояние до поверхности (0.17 мс на точку)."""
        import trimesh
        return trimesh.proximity.closest_point(self.mesh, np.asarray(pts, dtype=np.float64))[1]


# ------------------------------------------------------------------ совмещение

def rigid_align(src_mesh, dst_mesh, seed=0, surf=None):
    """Матрица src -> dst (жёсткая, без масштаба): главные оси, знаки, свой ICP.

    Два факта, на которых это держится:
      * `trimesh.registration.icp` на таких деталях врёт — сетку, сдвинутую на 2 мм,
        он «совмещает» на 0.78 мм (rms 0.40), а сетку с самой собой на 178.6°.
        Поэтому шаг ICP свой: ближайшие точки + Kabsch, направление src->dst явно;
      * кандидатов ранжируем односторонним rms, а не медианой: медиана не видит
        мелкие фичи и «побеждает» перевёрнутая поза.
    """
    import trimesh

    def frame(mesh, n=4000, sd=0):
        pts, _ = trimesh.sample.sample_surface(mesh, n, seed=sd)
        c = pts.mean(axis=0)
        w, V = np.linalg.eigh(np.cov((pts - c).T))
        return c, V[:, np.argsort(w)[::-1]]

    def kabsch(p, q):
        """Жёсткое p -> q без масштаба (SVD, отражение отбрасываем)."""
        cp, cq = p.mean(axis=0), q.mean(axis=0)
        u, _, vt = np.linalg.svd((p - cp).T @ (q - cq))
        R = vt.T @ u.T
        if np.linalg.det(R) < 0:
            vt[-1] *= -1.0
            R = vt.T @ u.T
        return R, cq - R @ cp

    surf = surf or Surf(dst_mesh)

    def refine(pts, M, thr, iters, exact_n=0, step_pts=0):
        """ICP: соответствия по облаку (быстро), последние шаги — по точным расстояниям."""
        for i in range(iters):
            if exact_n and i >= iters - exact_n:
                sub = pts if step_pts == 0 else pts[:: max(1, len(pts) // step_pts)]
                d = surf.exact(sub)
                cl = trimesh.proximity.closest_point(surf.mesh, sub)[0]
                pts_use, q = sub, cl
            else:
                d = surf.cloud_dist(pts)
                pts_use = pts
                q = surf.cloud[surf.tree.query(pts, k=1, workers=-1)[1]]
            m = d < thr
            if m.sum() < 50:
                break
            R, t = kabsch(pts_use[m], q[m])
            pts = pts @ R.T + t
            step = np.eye(4)
            step[:3, :3] = R
            step[:3, 3] = t
            M = step @ M
            if np.linalg.norm(t) < 1e-4 and np.abs(R - np.eye(3)).max() < 1e-5:
                break
        return pts, M

    def score(pts, n=800):
        sub = pts[:: max(1, len(pts) // n)]
        return float(np.sqrt(np.mean(surf.exact(sub) ** 2)))

    c_d, A_d = frame(dst_mesh, sd=seed)
    c_s, A_s = frame(src_mesh, sd=seed + 1)
    src_pts, _ = trimesh.sample.sample_surface(src_mesh, 1600, seed=seed + 2)

    # грубо по всем четырём допустимым знакам, тонко — только по двум лучшим:
    # тонкая доводка проигравшего кандидата всё равно не обгоняет лидера.
    cands = []
    for sx in (1, -1):
        for sy in (1, -1):
            for sz in (1, -1):
                R = A_d @ np.diag([sx, sy, sz]) @ A_s.T
                if np.linalg.det(R) < 0:
                    continue
                M = np.eye(4)
                M[:3, :3] = R
                M[:3, 3] = c_d - R @ c_s
                pts, M = refine(src_pts @ R.T + M[:3, 3], M, 4.0, iters=12)
                cands.append([score(pts), M, pts])
    cands.sort(key=lambda t: t[0])
    best = None
    for _, M, pts in cands[:2]:
        for thr in (1.0, 0.4):
            pts, M = refine(pts, M, thr, iters=14, exact_n=2, step_pts=500)
        s = score(pts)
        if best is None or s < best[0]:
            best = (s, M)
    return best[1]


# ------------------------------------------------------------------ невязки

class Fit:
    def __init__(self, model_path, ref_path, names, samples=2200, log_path=None, keep=None,
                 realign=True):
        import trimesh
        self.trimesh = trimesh
        # Собираем с ВРЕМЕННОЙ КОПИИ: подбор пишет значения параметров в файл
        # модели на каждой итерации, и без копии он затирает рабочий model.py
        # промежуточными числами (поймано на себе).
        self.src_path = os.path.abspath(model_path)
        self.model_path = os.path.join(tempfile.gettempdir(),
                                       "fit_model_%d.py" % os.getpid())
        shutil.copyfile(self.src_path, self.model_path)
        self.names = names
        self.samples = samples
        self.realign = realign
        self.log_path = log_path
        self.keep = keep
        self.tmp = os.path.join(tempfile.gettempdir(), "fit_model_%d.stl" % os.getpid())
        self.ref = trimesh.load_mesh(ref_path, force="mesh")
        self.ref.merge_vertices()
        self.ref_surf = Surf(self.ref)      # облако точек + дерево: одно на весь проход
        self.n_evals = 0
        self.history = []
        self.ref_aligned = None
        self.align_M = None
        self.current = None
        self.x_last = None

    def align_now(self):
        """Совмещение с нуля (PCA + 8 знаков + ICP) по текущей геометрии.

        Считать позу один раз по СТАРТОВОЙ детали нельзя: старт заведомо неверный,
        ICP подгоняет эталон под кривую геометрию, и поиск потом идёт к этому
        смещённому положению (на синтетике уводило WING_Y0 на 0.2 мм).
        Копить ICP-поправки на каждой сборке — тоже нельзя: поправки дрейфуют
        по оси симметрии. Поэтому поза пересчитывается с нуля, но между
        пересчётами заморожена — тогда параметры не могут подкупить сдвиг.
        """
        import trimesh
        self.set_params(np.array(self.x_last, dtype=float))
        build_stl(self.model_path, self.tmp)
        mine = trimesh.load_mesh(self.tmp, force="mesh")
        mine.merge_vertices()
        self.align_M = rigid_align(mine.copy(), self.ref, surf=self.ref_surf)
        self.ref_aligned = self.ref.copy()
        self.ref_aligned.apply_transform(np.linalg.inv(self.align_M))
        self.current_aligned = mine
        return mine

    def set_params(self, values):
        write_params(self.model_path, dict(zip(self.names, values)))

    def _eval(self, x, tag=""):
        """Невязки при значении x. realign — поза снимается заново на этой же сборке.

        Профилирование позы (а не фиксация) — ключ к честному ответу: у симметричной
        детали «параметры + поза» имеют две ямы (на синтетике (истина, поза B) даёт
        rms 0.011, а (фит, поза A) — 0.031), и замороженная поза держит поиск в
        мелкой яме. Поза — мешающий параметр, его надо максимизировать, а не
        угадывать один раз.
        """
        import trimesh
        self.set_params(x)
        try:
            build_stl(self.model_path, self.tmp)
            mine = trimesh.load_mesh(self.tmp, force="mesh")
            mine.merge_vertices()
            if mine.is_empty or len(mine.faces) < 4 or abs(mine.volume) < 1e-3:
                raise RuntimeError("пустая сетка")
        except Exception as e:                                  # кривая сборка = штраф
            self.n_evals += 1
            self.history.append({"n": self.n_evals, "ok": 0, "error": str(e)[:80],
                                 "params": dict(zip(self.names, np.round(x, 4).tolist()))})
            return None
        if self.realign:
            self.align_M = rigid_align(mine.copy(), self.ref, surf=self.ref_surf)  # модель -> эталон
            self.ref_aligned = self.ref.copy()
            self.ref_aligned.apply_transform(np.linalg.inv(self.align_M))
        elif self.ref_aligned is None:
            # первичное грубое совмещение: PCA + перебор знаков + ICP
            self.align_M = rigid_align(mine.copy(), self.ref, surf=self.ref_surf)  # модель -> эталон
            self.ref_aligned = self.ref.copy()
            self.ref_aligned.apply_transform(np.linalg.inv(self.align_M))  # эталон -> модель
        self.x_last = np.asarray(x, dtype=float)
        q_m, _ = trimesh.sample.sample_surface(mine, self.samples, seed=11)
        q_r, _ = trimesh.sample.sample_surface(self.ref_aligned, self.samples, seed=12)
        _, d_mr, _ = trimesh.proximity.closest_point(self.ref_aligned, q_m)
        _, d_rm, _ = trimesh.proximity.closest_point(mine, q_r)
        res = np.concatenate([d_mr, d_rm])
        self.n_evals += 1
        rec = {"n": self.n_evals, "ok": 1,
               "params": dict(zip(self.names, np.round(x, 4).tolist())),
               "volume": round(float(mine.volume), 3),
               "mean": round(float(np.mean(res)), 4),
               "median": round(float(np.median(res)), 4),
               "p95": round(float(np.percentile(res, 95)), 4),
               "max": round(float(np.max(res)), 4),
               "rms": round(float(np.sqrt(np.mean(res ** 2))), 4)}
        self.history.append(rec)
        self.current = mine
        if tag:
            print("  %-10s %s  mean %.3f  p95 %.3f  объём %.1f" % (
                tag, " ".join("%s=%.3f" % (k, v) for k, v in rec["params"].items()),
                rec["mean"], rec["p95"], rec["volume"]), flush=True)
        return res

    def residuals(self, x):
        res = self._eval(np.asarray(x, dtype=float))
        if res is None:
            return np.full(2 * self.samples, 5.0)               # штраф за сломанную сборку
        return res



def rms_of(fit, x, tag=""):
    res = fit._eval(np.asarray(x, dtype=float), tag=tag)
    return float("inf") if res is None else float(np.sqrt(np.mean(res ** 2)))


def sweep(fit, x, lo, hi, npts=7, rounds=2, frac=0.10):
    """Покоординатный проход по сетке: по одному параметру, остальные заморожены.

    Почему не least_squares сразу: глобальное расстояние почти не чувствует
    мелкие фичи (гекс под гайку — 8 % поверхности), зато уверенно тянет
    крупные (высота ступицы, смещение крыла). Покоординатный проход даёт
    ещё и кривую «параметр -> расхождение», по которой видно, определяется
    параметр фигурой или направление плоское. Вершина параболы по трём
    точкам вокруг минимума даёт значение точнее узла сетки.
    """
    names = fit.names
    x = np.array(x, dtype=float)
    best_rms = rms_of(fit, x, tag="старт")
    curves = []
    # окно своё у каждого параметра: если минимум на краю сетки — шаг продолжается
    # (минимум дальше), если внутри — окно сжимается. Иначе проход упирается в
    # край и останавливается, не дойдя до настоящего значения.
    half_state = {n: max(frac * (hi[i] - lo[i]) / 2.0, 0.02) for i, n in enumerate(names)}
    for rnd in range(rounds):
        for i, n in enumerate(names):
            half = half_state[n]
            a, b = max(lo[i], x[i] - half), min(hi[i], x[i] + half)
            grid = np.linspace(a, b, npts)
            vals, rs = [], []
            for v in grid:
                x2 = x.copy()
                x2[i] = v
                rr = rms_of(fit, x2, tag="%s=%.3f" % (n, v))
                vals.append(v)
                rs.append(rr)
            rs = np.array(rs)
            k = int(np.argmin(rs))
            at_edge = (k == 0 or k == len(vals) - 1)
            # вершина параболы по трём точкам вокруг минимума
            vmin = vals[k]
            if 0 < k < len(vals) - 1:
                y0, y1, y2 = rs[k - 1], rs[k], rs[k + 1]
                den = (y0 - 2 * y1 + y2)
                if abs(den) > 1e-12:
                    vmin = float(vals[k] + 0.5 * (y0 - y2) / den * (vals[1] - vals[0]))
                    vmin = min(max(vmin, vals[k - 1]), vals[k + 1])
            x2 = x.copy()
            x2[i] = vmin
            rr = rms_of(fit, x2, tag="%s=%.3f*" % (n, vmin))
            if rr <= best_rms + 1e-6:
                x[i], best_rms = vmin, min(rr, best_rms)
            curves.append({"round": rnd + 1, "param": n, "grid": [round(v, 4) for v in vals],
                           "rms": [round(v, 4) for v in rs], "picked": round(float(x[i]), 4),
                           "sensitivity": round(float(np.max(rs) - np.min(rs)), 4)})
            # край сетки -> идём дальше тем же шагом, внутри -> сжимаемся
            half_state[n] = half * (1.6 if at_edge else 0.55)
            print("    %s -> %.4f (rms %.4f, разброс по сетке %.4f%s)" % (
                n, x[i], best_rms, np.max(rs) - np.min(rs),
                ", минимум на краю — шагаю дальше" if at_edge else ""), flush=True)
    return x, best_rms, curves


def main(argv=None):
    ap = argparse.ArgumentParser(description="Подбор параметров модели (SOMA или CadQuery) по эталонному STL")
    ap.add_argument("--model", required=True, help="model.py с param(...)")
    ap.add_argument("--ref", required=True, help="эталонный STL")
    ap.add_argument("--params", required=True, help="через запятую: W,D,T,...")
    ap.add_argument("--mode", choices=("sweep", "ls", "both"), default="sweep",
                    help="sweep — покоординатный проход (по умолчанию), ls — least_squares, both — вместе")
    ap.add_argument("--npts", type=int, default=7, help="точек на параметр в проходе")
    ap.add_argument("--outer", type=int, default=3, help="пар 'поза с нуля -> проход параметров'")
    ap.add_argument("--tol", type=float, default=0.01, help="сдвиг параметров, при котором чередование останавливается, мм")
    ap.add_argument("--rounds", type=int, default=4, help="проходов по всем параметрам")
    ap.add_argument("--frac", type=float, default=0.25, help="ширина окна первого прохода, доля диапазона")
    ap.add_argument("--no-profile", dest="profile", action="store_false", default=True,
                    help="не пересчитывать позу на каждой точке (быстро, но поиск садится "
                         "в мелкую яму пары «параметры+поза»)")
    ap.add_argument("--no-realign", action="store_true",
                    help="не подтягивать позу на каждой сборке (быстрее, но параметры могут подкупать сдвиг)")
    ap.add_argument("--samples", type=int, default=2200, help="точек на поверхность в каждую сторону")
    ap.add_argument("--maxfev", type=int, default=120, help="предел числа сборок")
    ap.add_argument("--diff-step", type=float, default=0.08,
                    help="шаг конечных разностей, доля от значения параметра")
    ap.add_argument("--margin", type=float, default=0.02, help="расширение границ param(), доля диапазона")
    ap.add_argument("--mesh-tol", type=float, default=0.008,
                    help="допуск мешера, мм (обязан быть мельче шага подбора; по умолчанию 0.008)")
    ap.add_argument("--angular-tol", type=float, default=0.06, help="угловой допуск мешера, рад")
    ap.add_argument("--apply", action="store_true", help="записать найденные значения в model.py")
    ap.add_argument("--csv", default=None, help="куда писать журнал итераций")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    from scipy.optimize import least_squares

    set_mesh_tol(args.mesh_tol, args.angular_tol)

    info = read_params(args.model)
    names = [n.strip() for n in args.params.split(",") if n.strip()]
    unknown = [n for n in names if n not in info]
    if unknown:
        raise SystemExit("нет таких параметров в %s: %s" % (args.model, ", ".join(unknown)))
    # у части param() границ нет: берём ±10 % от значения и говорим об этом вслух
    missing = []
    for n in names:
        d = info[n]
        if d["lo"] is None or d["hi"] is None:
            missing.append(n)
            d["lo"], d["hi"] = round(d["value"] * 0.9, 4), round(d["value"] * 1.1, 4)
    if missing:
        print("без min/max в param(), взял ±10 %%: %s" % ", ".join(missing), flush=True)

    x0, lo, hi = [], [], []
    for n in names:
        d = info[n]
        span = d["hi"] - d["lo"]
        x0.append(d["value"])
        lo.append(d["lo"] - args.margin * span)
        hi.append(d["hi"] + args.margin * span)
    x0 = np.array(x0, dtype=float)
    lo = np.array(lo, dtype=float)
    hi = np.array(hi, dtype=float)

    backup = args.model + ".bak"
    shutil.copyfile(args.model, backup)
    print("старт: %s" % "  ".join("%s=%.3f" % (n, v) for n, v in zip(names, x0)), flush=True)
    t0 = time.time()
    fit = Fit(args.model, args.ref, names, samples=args.samples, log_path=args.csv,
              realign=args.profile and not args.no_realign)
    print("поза: %s" % ("профилируется на каждой сборке" if fit.realign
                        else "снимается один раз и заморожена"), flush=True)
    try:
        x = x0.copy()
        curves = []
        if args.mode in ("sweep", "both"):
            print("\nчередование: поза с нуля -> проход параметров (пар %d)" % args.outer, flush=True)
            cost0 = rms_of(fit, x)
            for outer in range(args.outer):
                fit.x_last = x.copy()
                if not fit.realign:
                    fit.align_now()
                prev = x.copy()
                x, cost0, cs = sweep(fit, x, lo, hi, npts=args.npts, rounds=1, frac=args.frac)
                curves += cs
                moved = float(np.max(np.abs(x - prev)))
                print("  пара %d/%d: rms %.4f, сдвиг %.4f мм (%.1f с)" % (
                    outer + 1, args.outer, cost0, moved, time.time() - t0), flush=True)
                if outer and moved < args.tol:
                    print("  параметры встали (< %.3f мм) — дальше не чередую" % args.tol, flush=True)
                    break
        else:
            cost0 = rms_of(fit, x)

        if args.mode in ("ls", "both"):
            from scipy.optimize import least_squares

            print("\nуточнение least_squares (diff_step %.2f):" % args.diff_step, flush=True)
            before = rms_of(fit, x, tag="до ls")
            # diff_step — доля от значения: мельче 5 % разница геометрии тонет в шуме
            # тесселяции (STL перестраивается, точки выборки прыгают на 0.02 мм).
            # soft_l1 — чтобы отсутствующая галтель (выброс ~1 мм) не тянула всё за собой.
            sol = least_squares(fit.residuals, x, bounds=(lo, hi),
                                diff_step=args.diff_step, max_nfev=args.maxfev,
                                x_scale=np.maximum(np.abs(x) * 0.05, 0.05),
                                loss="soft_l1", f_scale=0.25, verbose=1)
            after = rms_of(fit, sol.x)
            if after <= before:
                x = sol.x
            else:
                print("  ls дал хуже (%.4f против %.4f) — оставляю значения прохода" % (after, before))

        best = fit._eval(x, tag="финал")
        cost1 = float(np.sqrt(np.mean(best ** 2))) if best is not None else float("inf")

        print("\nбыло -> стало:")
        for n, a, b in zip(names, x0, x):
            print("  %-10s %8.3f -> %8.3f   (%+.3f)" % (n, a, b, b - a))
        print("\nrms %.4f -> %.4f  (%.1f %% лучше), сборок %d, время %.1f с"
              % (cost0, cost1, 100 * (cost0 - cost1) / max(cost0, 1e-9),
                 fit.n_evals, time.time() - t0))
        if fit.current is not None:
            q, _ = fit.trimesh.sample.sample_surface(fit.current, 4000, seed=21)
            _, d_mr, _ = fit.trimesh.proximity.closest_point(fit.ref_aligned, q)
            qr, _ = fit.trimesh.sample.sample_surface(fit.ref_aligned, 4000, seed=22)
            _, d_rm, _ = fit.trimesh.proximity.closest_point(fit.current, qr)
            print("финал: mean %.3f  median %.3f  p95 %.3f  max %.3f мм"
                  % (np.mean(np.r_[d_mr, d_rm]), np.median(np.r_[d_mr, d_rm]),
                     np.percentile(np.r_[d_mr, d_rm], 95), np.max(np.r_[d_mr, d_rm])))
            print("хуже всего модель->эталон (точка, расстояние):")
            for i in np.argsort(d_mr)[::-1][:5]:
                print("   [%6.2f %6.2f %6.2f]  %.3f" % (*q[i], d_mr[i]))
            print("хуже всего эталон->модель:")
            for i in np.argsort(d_rm)[::-1][:5]:
                print("   [%6.2f %6.2f %6.2f]  %.3f" % (*qr[i], d_rm[i]))

        if args.apply:
            write_params(args.model, dict(zip(names, np.round(x, 4))))
            print("\nзаписано в %s (бэкап %s)" % (args.model, backup))
        else:
            print("\nmodel.py не тронут (без --apply), эталон параметров в %s" % backup)

        if args.csv:
            import csv
            with open(args.csv, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f, delimiter=";")
                head = ["n", "ok"] + names + ["volume", "mean", "median", "p95", "max", "rms", "error"]
                w.writerow(head)
                for h in fit.history:
                    w.writerow([h.get("n"), h.get("ok")] +
                               [h.get("params", {}).get(n, "") for n in names] +
                               [h.get(k, "") for k in ("volume", "mean", "median", "p95", "max", "rms", "error")])
            print("журнал: %s" % args.csv)
        if args.json:
            json.dump({"names": names, "x0": x0.tolist(), "x": x.tolist(), "curves": curves,
                       "bounds": [lo.tolist(), hi.tolist()], "rms_before": cost0,
                       "rms_after": cost1, "evals": fit.n_evals,
                       "history": fit.history}, open(args.json, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
        return 0
    finally:
        if os.path.exists(fit.tmp):
            os.remove(fit.tmp)
        write_params(args.model, dict(zip(names, x0)))          # исходные значения назад
        if not args.apply and os.path.exists(backup):
            shutil.copyfile(backup, args.model)


if __name__ == "__main__":
    sys.exit(main())
