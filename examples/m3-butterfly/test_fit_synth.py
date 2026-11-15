"""Тест автоподбора на искусственном эталоне: истина известна, старт — мои ручные числа.

Проверяется три вещи, и любая провалившаяся — падение с кодом 1:
  1) каждый параметр вернулся в пределах TOL от истины;
  2) итоговый rms не хуже RMS_MAX (иначе поиск сел в мелкую яму совмещения);
  3) model.py после прогона побайтово тот же (фиттер не имеет права его трогать).
"""
import hashlib
import json
import shutil
import subprocess
import os
import sys

V = sys.executable
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "fit_params.py")
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = HERE + "/model.py"
REF = HERE + "/ref_truth.stl"
TRUTH = {"HUB_H": 5.20, "NUT_AF": 5.45, "NUT_DEPTH": 2.10, "WING_Y0": -2.40}
# Допуск на параметр — по его чувствительности, а не один на всех: гекс занимает
# ~8 % поверхности, поэтому NUT_DEPTH держится хуже остальных (замеры 0.050 при
# 7 точках на параметр и 0.071 при 5). Допуски ставим с запасом над замерами,
# чтобы гейт ловил регресс, а не шум сетки.
TOL = {"HUB_H": 0.06, "NUT_AF": 0.04, "NUT_DEPTH": 0.09, "WING_Y0": 0.06}
RMS_MAX = 0.025     # мм, лучший замер 0.0149
JOURNAL = HERE + "/fit_synth_gate.json"

sys.path.insert(0, os.path.join(ROOT, "scripts"))
import fit_params as F


def md5(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


before = md5(MODEL)
shutil.copyfile(MODEL, MODEL + ".truthbak")
try:
    F.write_params(MODEL, TRUTH)
    F.build_stl(MODEL, REF)
    print("эталон собран из", TRUTH, flush=True)
finally:
    shutil.copyfile(MODEL + ".truthbak", MODEL)

cmd = [V, SCRIPT, "--model", MODEL, "--ref", REF,
       "--params", ",".join(TRUTH), "--mode", "sweep", "--npts", "5", "--outer", "3",
       "--samples", "2200", "--csv", HERE + "/fit_synth_gate.csv", "--json", JOURNAL]
print(" ".join(cmd), flush=True)
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
print(r.stdout[-3000:], flush=True)
if r.returncode:
    print("ПАДЕНИЕ, код", r.returncode, "\n", r.stderr[-2000:], file=sys.stderr)
    sys.exit(1)

rep = json.load(open(JOURNAL, encoding="utf-8"))
names, fit = rep["names"], rep["x"]
print("\nпараметр      истина     подбор   промах   допуск")
bad = []
for n, v, t in zip(names, fit, [TRUTH[k] for k in names]):
    d = abs(v - t)
    tol = TOL[n]
    flag = "" if d <= tol else "  <- ПРОВАЛ"
    print("%-12s %8.3f  %8.3f  %7.3f  %6.3f%s" % (n, t, v, d, tol, flag))
    if d > tol:
        bad.append("%s промах %.3f > %.3f" % (n, d, tol))

rms = rep.get("rms_after")
if rms is None:
    print("в журнале нет rms_after — проверять нечего", file=sys.stderr)
    sys.exit(1)
print("rms %.4f  (потолок %.4f)" % (rms, RMS_MAX))
if rms > RMS_MAX:
    bad.append("rms %.4f > %.4f" % (rms, RMS_MAX))

after = md5(MODEL)
print("model.py: %s" % ("не тронут" if before == after else "ИЗМЕНЁН"))
if before != after:
    bad.append("фиттер изменил model.py")

if bad:
    print("\nПАДЕНИЕ: " + "; ".join(bad), file=sys.stderr)
    sys.exit(1)
print("\nОК: все параметры в своих допусках, rms в потолке, model.py не тронут")
