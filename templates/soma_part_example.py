"""Пример SOMA-модели под автоподбор параметров (шаблон скила stl-reverse-modeling).

Контракт, который ждёт fit_params.py:
  * каждое число, которое разрешено крутить, объявлено через `param(value, "подпись",
    min=..., max=..., step=..., unit="mm")` — из min/max берутся границы поиска;
  * тело отдаётся через `add_part("Имя", body)` — одно тело, замкнутое;
  * всё остальное — производные выражения, они пересчитываются сами.

Деталь нарочно простая и посторонняя: пластина с бобышкой. Годится как проверка,
что инструмент работает не только на той детали, под которую его писали.
"""
import cadquery as cq

from soma import add_part, param

W = param(30.0, "Ширина пластины", min=10.0, max=60.0, step=0.5, unit="mm")
D = param(20.0, "Глубина пластины", min=8.0, max=60.0, step=0.5, unit="mm")
T = param(4.0, "Толщина пластины", min=1.0, max=12.0, step=0.25, unit="mm")
BOSS_D = param(8.0, "Диаметр бобышки", min=3.0, max=20.0, step=0.25, unit="mm")

BOSS_H = T * 0.8          # высота бобышки — производная, не параметр подбора
BOSS_X = -W * 0.30        # бобышка нарочно НЕ по центру: иначе деталь симметрична
BOSS_Y = D * 0.15         # поворотом на 180° и подбору не за что зацепиться

plate = cq.Workplane("XY").box(W, D, T, centered=(True, True, False))
boss = (cq.Workplane("XY").workplane(offset=T)
        .center(BOSS_X, BOSS_Y).circle(BOSS_D / 2).extrude(BOSS_H))

add_part("Plate", plate.union(boss))
