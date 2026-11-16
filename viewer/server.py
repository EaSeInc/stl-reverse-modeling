"""Локальный сервер просмотрщика STL: файлы, сравнение сеток, задачи для агента.

Запуск:
    python viewer/server.py                 # http://127.0.0.1:9131
    python viewer/server.py --open          # то же + окно браузера без панелей
    python viewer/server.py --port 9131 --root C:/Users/boot8/cad

Сервер на стандартной библиотеке: смотреть сетки и мерить можно вообще без
зависимостей. Trimesh нужен только кнопке «сравнить» — она считает расстояние
вершин моей модели до эталонной поверхности и отдаёт массив для раскраски.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import posixpath
import shutil
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WEB = REPO / "web"
UPLOADS = HERE / "uploads"
TASKS = REPO / "tasks"
ROOTS = [REPO]                      # где искать .stl для списка файлов
PORT = 9131

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("model/stl", ".stl")
mimetypes.add_type("application/javascript", ".mjs")


def safe_path(raw: str) -> Path | None:
    """Путь только из разрешённых каталогов: без .. и без чужих дисков."""
    if not raw:
        return None
    p = Path(urllib.parse.unquote(raw))
    if not p.is_absolute():
        p = REPO / p
    try:
        p = p.resolve()
    except OSError:
        return None
    for root in ROOTS:
        try:
            p.relative_to(root.resolve())
            return p
        except ValueError:
            continue
    return None


def list_meshes() -> list[dict]:
    """STL под всеми корнями, без повторов, когда один корень лежит внутри другого."""
    seen: dict[str, dict] = {}
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__", "node_modules", "venv", ".venv")]
            for name in filenames:
                if not name.lower().endswith(".stl"):     # остальные форматы грузятся перетаскиванием
                    continue
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                    key = str(p.resolve())
                except OSError:
                    continue
                rel = str(p.relative_to(root)).replace("\\", "/")
                if key in seen:
                    if len(rel) < len(seen[key]["rel"]):
                        seen[key]["rel"] = rel
                    continue
                seen[key] = {
                    "path": str(p).replace("\\", "/"),
                    "name": name,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                    "rel": rel,
                }
    out = list(seen.values())
    out.sort(key=lambda r: (-r["mtime"], r["name"].lower()))
    return out


def compare(mine_path: Path, ref_path: Path, max_points: int = 30000, align: bool = True) -> dict:
    """Знаковое расстояние вершин моей модели до поверхности эталона.

    Поза совмещается автоматически (`rigid_align` из `scripts/fit_params.py`): эталон из
    чужой библиотеки почти всегда лежит в других координатах, и без совмещения
    «отклонение» получается 5.98 мм там, где формы отличаются на 0.1 — это не форма,
    а поворот. Если поза уже верная, матрица близка к единичной и цифры не меняются.
    """
    import sys
    import numpy as np
    import trimesh

    mine = trimesh.load(str(mine_path), force="mesh")
    ref = trimesh.load(str(ref_path), force="mesh")
    if isinstance(mine, trimesh.Scene):
        mine = trimesh.util.concatenate(tuple(mine.dump()))
    if isinstance(ref, trimesh.Scene):
        ref = trimesh.util.concatenate(tuple(ref.dump()))

    verts = np.asarray(mine.vertices, dtype=float)
    if len(verts) > max_points:
        idx = np.linspace(0, len(verts) - 1, max_points).astype(int)
        pts = verts[idx]
    else:
        pts = verts

    t0 = time.time()
    align_info = {"done": False}
    if align and len(mine.vertices) <= 400000:
        scripts = str(REPO / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        try:
            import fit_params as F

            before = float(np.sqrt(np.mean(
                np.abs(trimesh.proximity.ProximityQuery(ref).on_surface(pts)[1]) ** 2)))
            M = F.rigid_align(mine, ref)                      # src -> dst, без масштаба
            pts = pts @ M[:3, :3].T + M[:3, 3]
            align_info = {"done": True, "rms_before": round(before, 3)}
        except Exception as e:                             # noqa: BLE001 — сравнение важнее позы
            align_info = {"done": False, "error": "%s: %s" % (type(e).__name__, e)}

    closest, dist, tri = trimesh.proximity.ProximityQuery(ref).on_surface(pts)
    normals = ref.face_normals[np.asarray(tri, dtype=int)]
    sign = np.sign(np.einsum("ij,ij->i", pts - closest, normals))
    signed = (dist * sign).astype(np.float32)
    ad = np.abs(signed)

    return {
        "n": int(len(signed)),
        "seconds": round(time.time() - t0, 2),
        "stats": {
            "rms": float(np.sqrt(np.mean(ad ** 2))),
            "mean": float(ad.mean()),
            "median": float(np.median(ad)),
            "p95": float(np.percentile(ad, 95)),
            "max": float(ad.max()),
            "signed_mean": float(signed.mean()),
        },
        "distances": base64.b64encode(signed.tobytes()).decode("ascii"),
        "mine_vertices": int(len(mine.vertices)),
        "subsampled": bool(len(mine.vertices) > max_points),
        "align": align_info,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):        # тише: только ошибки
        if str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- отдача файлов ----------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/api/"):
            return self.api_get(u.path, q)
        return self.static(u.path)

    def static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else posixpath.normpath(path.lstrip("/"))
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self.send_text(403, "нельзя")
        if not target.is_file():
            return self.send_text(404, "нет такого файла: " + rel)
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def api_get(self, path: str, q: dict) -> None:
        if path == "/api/files":
            return self.send_json({"files": list_meshes(), "roots": [str(r).replace("\\", "/") for r in ROOTS]})
        if path == "/api/mesh":
            p = safe_path(q.get("path", [""])[0])
            if not p or not p.is_file():
                return self.send_text(404, "нет файла")
            body = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "model/stl")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/task/latest":
            files = sorted(TASKS.glob("*.json"))
            if not files:
                return self.send_json({"task": None})
            return self.send_json({"task": json.loads(files[-1].read_text(encoding="utf-8")), "file": str(files[-1])})
        return self.send_text(404, "нет такого эндпоинта")

    # ---------- загрузка и вычисления ----------
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if u.path == "/api/upload":
            name = os.path.basename(q.get("name", ["model.stl"])[0]) or "model.stl"
            UPLOADS.mkdir(parents=True, exist_ok=True)
            dst = UPLOADS / name
            dst.write_bytes(raw)
            return self.send_json({"path": str(dst).replace("\\", "/"), "bytes": len(raw)})

        if u.path == "/api/compare":
            try:
                qs = urllib.parse.parse_qs(raw.decode("utf-8"))
                mine = safe_path(qs.get("mine", [""])[0])
                ref = safe_path(qs.get("ref", [""])[0])
                if not mine or not ref or not mine.is_file() or not ref.is_file():
                    return self.send_json({"error": "нужны два пути к файлам внутри проекта"}, 400)
                return self.send_json(compare(mine, ref))
            except ImportError:
                return self.send_json({"error": "trimesh не установлен в этом питоне: запусти сервер через venv"}, 503)
            except Exception as e:                     # noqa: BLE001 — показать текст в интерфейсе
                return self.send_json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

        if u.path == "/api/task":
            try:
                task = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                return self.send_json({"error": "битый JSON: %s" % e}, 400)
            TASKS.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            dst = TASKS / ("task-%s.json" % stamp)
            task["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            dst.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
            return self.send_json({"file": str(dst), "rel": str(dst.relative_to(REPO)).replace("\\", "/")})

        return self.send_text(404, "нет такого эндпоинта")

    # ---------- помощники ----------
    def send_json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, code: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def open_app_window(url: str) -> None:
    """Окно без адресной строки: ближайшее к «отдельному приложению» без Electron."""
    candidates = [
        r"C:/Program Files/Google/Chrome/Application/chrome.exe",
        r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ]
    for exe in candidates:
        if Path(exe).is_file():
            prof = HERE / ".browser-profile"
            subprocess.Popen([exe, "--app=%s" % url, "--user-data-dir=%s" % prof,
                              "--window-size=1500,950"])
            return
    print("Chrome и Edge не найдены — открой адрес руками:", url)


def main() -> None:
    global PORT, ROOTS
    ap = argparse.ArgumentParser(description="Просмотрщик STL: мерить, вращать, отмечать, отдавать задачу агенту")
    ap.add_argument("--port", type=int, default=9131)
    ap.add_argument("--root", action="append", default=[], help="каталог, где искать модели (можно несколько)")
    ap.add_argument("--open", action="store_true", help="открыть окно браузера в режиме приложения")
    a = ap.parse_args()
    PORT = a.port
    if a.root:
        ROOTS = [Path(r).resolve() for r in a.root]
    url = "http://127.0.0.1:%d/" % PORT
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("просмотрщик:", url)
    print("модели ищу в:", ", ".join(str(r) for r in ROOTS))
    print("задачи пишу в:", TASKS)
    if a.open:
        open_app_window(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nстоп")


if __name__ == "__main__":
    main()
