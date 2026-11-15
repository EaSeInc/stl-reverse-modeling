#!/usr/bin/env python
"""Самотест универсальности fit_params.py: деталь посторонняя, истина известна.

Скил не имеет права требовать конкретную деталь. Тест делает всё сам:
  1) берёт шаблон templates/soma_part_example.py (пластина с бобышкой) в %TEMP%;
  2) собирает эталон из известных TRUTH, возвращает модель на место;
  3) гоняет подбор как отдельный процесс;
  4) проверяет промахи (по допуску на параметр), rms и неизменность файла модели;
  5) отдельно проверяет второй контракт — обычный CadQuery-скрипт с build().

Любая провалившаяся проверка — exit 1. Запуск: python test_fit_universal.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
FIT = os.path.join(HERE, "fit_params.py")
TEMPLATE = os.path.join(SKILL, "templates", "soma_part_example.py")
PY = sys.executable

TRUTH = {"W": 32.0, "D": 22.0, "T": 4.6, "BOSS_D": 9.2}
# Допуск на параметр — по его доле поверхности: плоские грани держатся точно,
# цилиндр бобышки (~5 % площади) — хуже.
TOL = {"W": 0.08, "D": 0.08, "T": 0.06, "BOSS_D": 0.15}
RMS_MAX = 0.03      # мм; потолок выставляется после первого замера

sys.path.insert(0, HERE)
import fit_params as F


def md5(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


work = tempfile.mkdtemp(prefix="fit_universal_")
model = os.path.join(work, "model.py")
shutil.copyfile(TEMPLATE, model)

# --- эталон из известных чисел ------------------------------------------------
keep = model + ".keep"
shutil.copyfile(model, keep)
try:
    F.write_params(model, TRUTH)
    ref = F.build_stl(model, os.path.join(work, "ref.stl"))
    print("эталон собран из", TRUTH, "->", ref, flush=True)
finally:
    shutil.copyfile(keep, model)
    before = md5(model)

# --- подбор -------------------------------------------------------------------
cmd = [PY, FIT, "--model", model, "--ref", ref, "--params", ",".join(TRUTH),
       "--mode", "both", "--npts", "5", "--outer", "2", "--samples", "1400", "--maxfev", "80",
       "--csv", os.path.join(work, "fit.csv"), "--json", os.path.join(work, "fit.json")]
print(" ".join(cmd), flush=True)
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
print(r.stdout[-2500:], flush=True)
bad = []
if r.returncode:
    print("ПАДЕНИЕ подбора, код", r.returncode, "\n", r.stderr[-2000:], file=sys.stderr)
    bad.append("подбор завершился с кодом %d" % r.returncode)
else:
    rep = json.load(open(os.path.join(work, "fit.json"), encoding="utf-8"))
    print("\nпараметр      истина     подбор   промах   допуск")
    for n, v in zip(rep["names"], rep["x"]):
        t, tol = TRUTH[n], TOL[n]
        d = abs(v - t)
        print("%-12s %8.3f  %8.3f  %7.3f  %6.3f%s" % (n, t, v, d, tol,
              "" if d <= tol else "  <- ПРОВАЛ"))
        if d > tol:
            bad.append("%s промах %.3f > %.3f" % (n, d, tol))
    rms = rep.get("rms_after")
    print("rms %.4f  (потолок %.4f)" % (rms, RMS_MAX))
    if rms > RMS_MAX:
        bad.append("rms %.4f > %.4f" % (rms, RMS_MAX))

# --- модель не тронута ---------------------------------------------------------
print("model.py: %s" % ("не тронут" if md5(model) == before else "ИЗМЕНЁН"))
if md5(model) != before:
    bad.append("подбор изменил файл модели без --apply")

# --- второй контракт: обычный CadQuery-скрипт с build() ------------------------
plain = os.path.join(work, "plain.py")
open(plain, "w", encoding="utf-8").write(
    "import cadquery as cq\n"
    "def build():\n"
    "    return cq.Workplane('XY').box(20, 12, 6, centered=(True, True, False))\n")
try:
    out = F.build_stl(plain, os.path.join(work, "plain.stl"))
    size = os.path.getsize(out)
    print("\nконтракт build(): %s, %d байт" % (os.path.basename(out), size))
    if size <= 84:
        bad.append("build()-модель дала пустой STL")
except Exception as e:
    print("контракт build(): ПАДЕНИЕ — %s" % e, file=sys.stderr)
    bad.append("build()-модель не собралась: %s" % e)

if bad:
    print("\nПАДЕНИЕ: " + "; ".join(bad), file=sys.stderr)
    sys.exit(1)
print("\nОК: посторонняя деталь подобрана в допусках, оба контракта работают, файл модели цел")
