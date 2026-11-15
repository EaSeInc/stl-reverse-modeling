#!/usr/bin/env python3
"""Сверка двух сеток: числа, площади сечений и расстояние между поверхностями.

    python mesh_compare.py ref.stl mine.stl
    python mesh_compare.py ref.stl mine.stl --levels 1,3,5,8 --points 6000 --json out.json
    python mesh_compare.py ref.stl mine.stl --pylib C:/Users/boot8/cad/<проект>/.pylib

Зависимости (ставятся в каталог проекта, установку SOMA не трогают):

    pip install --quiet --target <проект>/.pylib trimesh shapely networkx

Пороги приёмки на детали ~20 мм с сеткой 3-4 тыс. треугольников:
    mean <= 0.10 мм, p95 <= 0.30 мм, max <= 0.60 мм -> ok, иначе exit 1.
Объём может сойтись на 99 % при провале этого гейта: он слепой к галтелям.
"""
import argparse
import json
import sys

import numpy as np


LIMITS = {'среднее': 0.10, 'p95': 0.30, 'max': 0.60}


def die(msg, code=2):
    print('ОШИБКА: ' + msg, file=sys.stderr)
    raise SystemExit(code)


def import_trimesh(pylib):
    if pylib:
        sys.path.append(pylib)  # append, не insert: pip-нумпи не должен перебить numpy окружения
    try:
        import trimesh
    except ImportError:
        die('нет trimesh — pip install --quiet --target <проект>/.pylib '
            'trimesh shapely networkx')
    return trimesh


def stats(trimesh, path):
    m = trimesh.load_mesh(path, force='mesh')
    return m, {
        'файл': path,
        'треугольников': int(len(m.faces)),
        'вершин': int(len(m.vertices)),
        'объём': round(float(m.volume), 3),
        'герметична': bool(m.is_watertight),
        'эйлер': int(m.euler_number),
        'габарит': [round(float(v), 3) for v in m.bounding_box.extents],
    }


def section_areas(mesh, levels):
    import shapely  # noqa: F401 — polygons_full считает дырки через shapely
    out = {}
    for z in levels:
        sec = mesh.section(plane_normal=[0, 0, 1], plane_origin=[0, 0, z])
        if sec is None:
            out[float(z)] = 0.0
            continue
        try:
            p2, _ = sec.to_2D()
            out[float(z)] = round(float(sum(p.area for p in p2.polygons_full)), 4)
        except Exception:
            out[float(z)] = float('nan')
    return out


def surface_distance(trimesh, ref, mine, points):
    pts, _ = trimesh.sample.sample_surface(mine, points, seed=1)
    _, dist, _ = trimesh.proximity.closest_point(ref, pts)
    back, _ = trimesh.sample.sample_surface(ref, points, seed=2)
    _, dist_back, _ = trimesh.proximity.closest_point(mine, back)
    d = np.concatenate([dist, dist_back])
    worst = np.argsort(dist)[::-1][:5]
    return {
        'точек': int(d.size),
        'среднее': round(float(d.mean()), 4),
        'медиана': round(float(np.median(d)), 4),
        'p95': round(float(np.percentile(d, 95)), 4),
        'max': round(float(d.max()), 4),
        'доля>0.2': round(float((d > 0.2).mean()), 3),
        'доля>0.4': round(float((d > 0.4).mean()), 3),
        'доля>0.8': round(float((d > 0.8).mean()), 3),
        'worst': [{'точка_модели': [round(float(v), 2) for v in pts[i]],
                   'd': round(float(dist[i]), 3)} for i in worst],
    }


def main():
    ap = argparse.ArgumentParser(description='сверка двух сеток числами')
    ap.add_argument('ref', help='эталонная сетка (STL/3MF/PLY)')
    ap.add_argument('mine', help='проверяемая сетка')
    ap.add_argument('--levels', default='', help='уровни Z через запятую; пусто — 5 равномерных')
    ap.add_argument('--points', type=int, default=4000, help='точек на поверхность (по умолчанию 4000)')
    ap.add_argument('--pylib', default='', help='каталог с trimesh/shapely')
    ap.add_argument('--json', default='', help='куда положить отчёт')
    a = ap.parse_args()

    trimesh = import_trimesh(a.pylib)
    ref, sref = stats(trimesh, a.ref)
    mine, smine = stats(trimesh, a.mine)

    lo, hi = float(ref.bounds[0][2]), float(ref.bounds[1][2])
    if a.levels:
        levels = [float(x) for x in a.levels.split(',')]
    else:
        levels = [round(lo + (hi - lo) * f, 3) for f in (0.1, 0.3, 0.5, 0.7, 0.9)]

    A = section_areas(ref, levels)
    B = section_areas(mine, levels)
    d = surface_distance(trimesh, ref, mine, a.points)

    keys = ('треугольников', 'объём', 'герметична', 'эйлер')
    print('эталон  ' + str({k: sref[k] for k in keys}))
    print('        габарит %s' % sref['габарит'])
    print('модель  ' + str({k: smine[k] for k in keys}))
    print('        габарит %s' % smine['габарит'])
    if sref['объём']:
        print('объём: %.2f %%' % (100 * smine['объём'] / sref['объём']))

    print('\nz      эталон A    модель A      dA')
    for z in levels:
        print('%-6.2f %-12.3f %-12.3f %+.3f' % (z, A[z], B[z], B[z] - A[z]))

    print('\nрасстояние между поверхностями: %s'
          % {k: d[k] for k in ('среднее', 'медиана', 'p95', 'max')})
    print('доля точек >0.2/0.4/0.8 мм: %.1f / %.1f / %.1f %%'
          % (100 * d['доля>0.2'], 100 * d['доля>0.4'], 100 * d['доля>0.8']))
    print('худшие точки модели:')
    for w in d['worst']:
        print('  %-24s d=%.3f' % (w['точка_модели'], w['d']))

    ok = all(d[k] <= LIMITS[k] for k in LIMITS)
    print('\nвердикт: %s (mean<=0.10, p95<=0.30, max<=0.60 мм)'
          % ('ok' if ok else 'НЕ ПРОШЛО'))

    if a.json:
        payload = {'ref': sref, 'mine': smine, 'уровни': levels,
                   'площади_эталон': A, 'площади_модель': B,
                   'поверхность': d, 'ok': bool(ok)}
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        print('отчёт: %s' % a.json)
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
