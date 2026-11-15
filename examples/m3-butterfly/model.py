"""Гайка-барашек M3 (butterfly / wing nut) — восстановлена по M3_Butterfly.STL.

Кадр детали: Z — ось отверстия, X — размах крыльев, Y — толщина.
Все числа — из замера сетки (section_probe + срезы, скрипты probe*.py рядом).

Печать: дном на стол (z=0), поддержки не нужны — крылья поднимаются под 45°
от низа, самый крутой наклон в профиле крыла не превышает 63° от горизонтали,
но он идёт «внутрь» детали, а не нависает.
"""
import math

import cadquery as cq

from soma import add_part, param

# --- что крутит пользователь --------------------------------------------------------------
SPAN = param(22.83, "Размах крыльев", min=16.0, max=32.0, step=0.5, unit="mm")
WIDTH = param(10.60, "Ширина (толщина) тела", min=6.0, max=16.0, step=0.2, unit="mm")
HEIGHT = param(11.02, "Высота", min=6.0, max=18.0, step=0.2, unit="mm")
HUB_H = param(4.85, "Высота ступицы", min=2.0, max=10.0, step=0.2, unit="mm")
BORE_D = param(3.40, "Отверстие под винт", min=2.0, max=6.0, step=0.1, unit="mm")
BORE_LEN = param(2.50, "Длина резьбовой части", min=1.0, max=8.0, step=0.1, unit="mm")
NUT_AF = param(5.65, "Гайка M3: размер под ключ (5.50 = впритык по сетке, 5.65 = с зазором под печать)",
               min=4.0, max=8.0, step=0.05, unit="mm")
NUT_DEPTH = param(2.35, "Глубина посадки гайки", min=1.0, max=6.0, step=0.05, unit="mm")
NUT_ROT = param(23.0, "Поворот шестигранника", min=0.0, max=60.0, step=1.0, unit="deg")
WING_T = param(2.82, "Толщина крыла", min=1.6, max=6.0, step=0.1, unit="mm")
WING_Y0 = param(-2.7, "Смещение крыла по Y", min=-5.0, max=0.0, step=0.1, unit="mm")
ROUND_TIP = param(True, "Скруглять носок крыла")
ROOT_FILLET = param(0.0, "Скругление у корня крыла", min=0.0, max=1.5, step=0.1, unit="mm")

# --- замеренный профиль крыла (XZ, +X сторона), мм ----------------------------------------
# низ: 45° от (5.40, 0) к носку; верх: сплайн по 14 точкам; корень уходит в ступицу
PROFILE_LOW = [(2.00, 0.00), (5.40, 0.00), (10.50, 5.10), (11.42, 7.66)]
PROFILE_TOP = [(11.42, 7.66), (11.10, 8.95), (10.50, 9.86), (9.90, 10.39), (9.00, 10.84),
               (8.10, 11.01), (7.80, 11.02), (6.90, 10.94), (6.00, 10.64), (5.40, 10.24),
               (4.80, 9.62), (4.20, 8.54), (3.60, 7.24), (3.00, 5.95), (2.60, 5.10),
               (2.00, 5.10)]

# масштаб замеренного профиля под текущие параметры
SX = SPAN / 22.83
SZ = HEIGHT / 11.02


def sc(pts):
    return [(x * SX, z * SZ) for x, z in pts]


# --- ступица ------------------------------------------------------------------------------
body = (
    cq.Workplane("XY")
    .circle(WIDTH / 2)
    .extrude(HUB_H)
)

# --- два крыла: пластина в плоскости XZ, зеркально через 180° -----------------------------
for turn in (0, 180):
    pts = sc(PROFILE_LOW)
    top = sc(PROFILE_TOP)
    w = cq.Workplane("XZ").polyline(pts[:3])
    if ROUND_TIP:
        w = w.threePointArc(pts[3], top[1])
    else:
        w = w.lineTo(*pts[3]).lineTo(*top[1])
    wing = (
        w.spline(top[2:], includeCurrent=True)
        .lineTo(*sc([(2.00, 0.00)])[0])
        .close()
        .extrude(WING_T)
        .translate((0, WING_Y0 + WING_T, 0))
    )
    body = body.union(wing if turn == 0 else wing.rotate((0, 0, 0), (0, 0, 1), 180))

# --- отверстие под винт и шестигранное гнездо под гайку M3 --------------------------------
# гнездо: стандартная гайка M3 (5.5 под ключ = 6.35 по углам), глубина 2.35 = высота гайки
body = body.cut(
    cq.Workplane("XY").workplane(offset=-1.0).circle(BORE_D / 2).extrude(BORE_LEN + 1.0)
)
NUT_AC = NUT_AF / math.cos(math.pi / 6)
body = body.cut(
    cq.Workplane("XY")
    .workplane(offset=HUB_H - NUT_DEPTH)
    .polygon(6, NUT_AC)
    .extrude(HEIGHT)
    .rotate((0, 0, 0), (0, 0, 1), NUT_ROT)
)

if ROOT_FILLET > 0:
    sel = cq.selectors.BoxSelector((-3.6, -2.6, 4.9), (3.6, 2.6, 10.6))
    try:
        body = body.edges(sel).fillet(ROOT_FILLET)
    except Exception:
        pass  # OCCT часто не берёт это скругление; при 0.0 блок не выполняется

add_part("WingNut", body)
