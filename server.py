"""ZWO Ride — workout library API + static file server. Zero dependencies — python3 server.py"""
import json
import os
import re
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKOUT_DIR = os.path.join(ROOT, "workouts")
PRESET_DIR = os.path.join(ROOT, "presets")
UPLOAD_DIR = os.path.join(PRESET_DIR, "uploaded")
RIDE_DIR = os.path.join(ROOT, "rides")
PORT = 8010


def slugify(name):
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return slug or "workout"


def safe_path(directory, file_id):
    """Resolve a file id to a .zwo path directly inside directory, or None if it escapes."""
    name = os.path.basename(unquote(file_id))
    if not name.lower().endswith(".zwo"):
        name += ".zwo"
    path = os.path.join(directory, name)
    return path if os.path.dirname(path) == directory else None


def unique_name(directory, stem):
    name, n = f"{stem}.zwo", 2
    while os.path.exists(os.path.join(directory, name)):
        name, n = f"{stem}-{n}.zwo", n + 1
    return name


def read_zwo(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def list_workouts():
    return [
        {"id": name, "xml": read_zwo(os.path.join(WORKOUT_DIR, name))}
        for name in sorted(os.listdir(WORKOUT_DIR))
        if name.lower().endswith(".zwo")
    ]


def list_presets():
    """Every .zwo under presets/<collection>/ — the collection is the folder name."""
    out = []
    for collection in sorted(os.listdir(PRESET_DIR)):
        folder = os.path.join(PRESET_DIR, collection)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if name.lower().endswith(".zwo"):
                out.append(
                    {"id": f"{collection}/{name}", "collection": collection, "xml": read_zwo(os.path.join(folder, name))}
                )
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(ROOT, "public"), **kwargs)

    def end_headers(self):
        # Dev server: never let the browser cache app files, otherwise an edit
        # appears to have no effect.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/api/workouts":
            self._json(200, list_workouts())
        elif self.path == "/api/presets":
            self._json(200, list_presets())
        else:
            super().do_GET()

    def do_POST(self):
        try:
            payload = self._body()
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        if self.path == "/api/workouts":
            # Save. An explicit id overwrites that file; otherwise the file name
            # comes from the workout name, suffixed so nothing is clobbered.
            xml = payload.get("xml", "")
            if "<workout_file" not in xml:
                self._json(400, {"error": "not a zwo file"})
                return
            file_id = payload.get("id") or unique_name(WORKOUT_DIR, slugify(payload.get("name", "workout")))
            path = safe_path(WORKOUT_DIR, file_id)
            if not path:
                self._json(400, {"error": "bad id"})
                return
            with open(path, "w", encoding="utf-8") as f:
                f.write(xml)
            self._json(200, {"ok": True, "id": os.path.basename(path)})

        elif self.path == "/api/presets":
            # Upload into the browse library. Never overwrites: a second file
            # with the same name gets a suffix.
            xml = payload.get("xml", "")
            if "<workout_file" not in xml:
                self._json(400, {"error": "not a zwo file"})
                return
            stem = slugify(os.path.splitext(os.path.basename(payload.get("filename") or "workout"))[0])
            name = unique_name(UPLOAD_DIR, stem)
            with open(os.path.join(UPLOAD_DIR, name), "w", encoding="utf-8") as f:
                f.write(xml)
            self._json(200, {"ok": True, "id": f"uploaded/{name}"})

        elif self.path == "/api/rides":
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
            name = f"{stamp}-{slugify(payload.get('workout', 'ride'))}.json"
            with open(os.path.join(RIDE_DIR, name), "w") as f:
                json.dump(payload, f)
            self._json(200, {"ok": True, "file": name})

        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        # Only files the rider made or uploaded can be deleted; bundled presets can't.
        path = None
        if self.path.startswith("/api/workouts/"):
            path = safe_path(WORKOUT_DIR, self.path[len("/api/workouts/"):])
        elif self.path.startswith("/api/presets/uploaded/"):
            path = safe_path(UPLOAD_DIR, self.path[len("/api/presets/uploaded/"):])
        if path and os.path.exists(path):
            os.remove(path)
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, format, *args):
        # only log API traffic, not static file requests
        if args and "/api/" in str(args[0]):
            super().log_message(format, *args)


if __name__ == "__main__":
    os.makedirs(WORKOUT_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(RIDE_DIR, exist_ok=True)
    print(f"ZWO Ride — http://localhost:{PORT}")
    print(f"Workouts → {WORKOUT_DIR}")
    print(f"Presets  → {PRESET_DIR}")
    print(f"Rides    → {RIDE_DIR}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
