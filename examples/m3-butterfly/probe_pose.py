"""Диагностика совмещения: поза отстаёт от параметров или ICP садится не туда?

Три замера на одних и тех же параметрах:
1) как фит закончил (поза снята на предыдущем значении x, потом x уехал);
2) поза пересчитана с нуля на этих же x;
3) поза пересчитана с нуля + мелкое шевеление (сетка поворотов и сдвигов),
   чтобы поймать локальный минимум ICP.
"""
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import fit_params as F

MODEL = os.path.join(HERE, "model.py")
REF = os.path.join(HERE, "ref_truth.stl")
NAMES = ["HUB_H", "NUT_AF", "NUT_DEPTH", "WING_Y0"]
TRUTH = np.array([5.20, 5.45, 2.10, -2.40])
FIT = np.array([5.185, 5.430, 2.129, -2.550])


def rms_at(fit, x):
    r = fit._eval(np.asarray(x, float))
    return float("inf") if r is None else float(np.sqrt(np.mean(r ** 2)))


fit = F.Fit(MODEL, REF, NAMES, samples=2200)

fit.x_last = FIT.copy()
fit.align_now()
frozen = rms_at(fit, FIT)
print("1) поза с нуля на фите, x=фит:            rms %.4f" % frozen)
print("   та же поза, x=истина:                    rms %.4f" % rms_at(fit, TRUTH))

# поза с нуля уже на ИСТИНЕ
fit.x_last = TRUTH.copy()
fit.align_now()
print("2) поза с нуля на истине, x=истина:         rms %.4f" % rms_at(fit, TRUTH))
print("   та же поза, x=фит:                      rms %.4f" % rms_at(fit, FIT))

# шевеление позы: ищем, не сидит ли ICP в локальном минимуме
best = (frozen, "нет шевеления")
base_M = fit.align_M.copy()
for ang in (0.0, 0.15, -0.15):
    for dz in (0.0, 0.08, -0.08):
        for dy in (0.0, 0.08, -0.08):
            rad = np.radians(ang)
            R = np.array([[1, 0, 0],
                          [0, np.cos(rad), -np.sin(rad)],
                          [0, np.sin(rad), np.cos(rad)]])
            T = np.eye(4)
            T[:3, :3] = R
            T[:3, 3] = [0.0, dy, dz]
            fit.align_M = T @ base_M
            fit.ref_aligned = fit.ref.copy()
            fit.ref_aligned.apply_transform(np.linalg.inv(fit.align_M))
            r = rms_at(fit, FIT)
            if r < best[0] - 1e-4:
                best = (r, "поворот %.2f°, dy %.2f, dz %.2f" % (ang, dy, dz))
print("3) лучшее шевеление: %.4f  (%s)" % best)
