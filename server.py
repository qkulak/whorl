"""Whorl — workout library API + static file server. Zero dependencies — python3 server.py

The same Handler also runs on AWS Lambda (see lambda_function.py), where the
files riders change live in S3 instead of the project folder (see storage.py).

Who can get in, in order of precedence:
  accounts  WHORL_COGNITO_POOL + WHORL_COGNITO_CLIENT set: riders sign in with
            email and password (accounts.py), and each one's workouts, uploads,
            favorites and rides are private, under users/<id>/ in the store.
  password  WHORL_PASSWORD or beta-password.txt: one shared password, one
            shared library.
  open      neither: anyone who can reach the server, one shared library.
            Never on AWS (WHORL_BUCKET set): there it's "closed" instead, and
            every request gets a 503 until sign-in is configured.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlsplit

from accounts import AccountError, Accounts
from storage import open_store
from strava import Strava, StravaError, load_app

ROOT = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(ROOT, "presets")  # bundled, read-only
# Everything riders change, as store keys (folders locally, S3 on Lambda). In
# accounts mode each key is further prefixed with the rider's users/<id>/.
STORE = open_store(ROOT)
WORKOUTS = "workouts/"
UPLOADS = "presets/uploaded/"
RIDES = "rides/"
RIDE_INDEX = "ride-index.json"  # each ride's summary, so History doesn't read every full ride
FAVORITES = "favorites.json"
STRAVA_TOKENS = "strava-token.json"  # the rider's connected Strava account
PORT = int(os.environ.get("WHORL_PORT", 8010))
# 0.0.0.0 accepts connections from other machines; WHORL_HOST=127.0.0.1 keeps it local.
HOST = os.environ.get("WHORL_HOST", "0.0.0.0")

PASSWORD_FILE = os.path.join(ROOT, "beta-password.txt")


def load_password():
    if os.environ.get("WHORL_PASSWORD"):
        return os.environ["WHORL_PASSWORD"]
    try:
        with open(PASSWORD_FILE, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


ACCOUNTS = None
if os.environ.get("WHORL_COGNITO_POOL") and os.environ.get("WHORL_COGNITO_CLIENT"):
    ACCOUNTS = Accounts(os.environ["WHORL_COGNITO_POOL"], os.environ["WHORL_COGNITO_CLIENT"])
    MODE = "accounts"
    PASSWORD = None
    SESSION_KEY = os.environ.get("WHORL_SESSION_SECRET", "").encode()
    if len(SESSION_KEY) < 32:
        raise SystemExit("WHORL_SESSION_SECRET must be set (32+ characters) when accounts are on")
else:
    PASSWORD = load_password()
    MODE = "password" if PASSWORD else "closed" if os.environ.get("WHORL_BUCKET") else "open"
    # Signed with the password, so changing the password signs everyone out.
    SESSION_KEY = (PASSWORD or "").encode()

_strava_app = load_app()
STRAVA = Strava(*_strava_app) if _strava_app else None
STRAVA_STATE_COOKIE = "whorl_strava_state"

SESSION_COOKIE = "whorl_session"
SESSION_DAYS = 30
PAGES = {"password": "login.html", "accounts": "signin.html"}
PUBLIC_FILES = {"/brand/whorl-logo-cream.png", "/brand/whorl-app-icon.png"}  # served before sign-in
USER_ID = re.compile(r"^[0-9a-f-]{36}$")  # Cognito sub
PUBLIC_ACTIONS = {"signin", "signup", "confirm", "resend", "forgot", "reset"}  # /auth/<action> before signing in


def slugify(name):
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return slug or "workout"


def safe_name(file_id):
    """A file id reduced to a bare .zwo file name, or None if nothing is left."""
    name = os.path.basename(unquote(file_id).replace("\\", "/"))
    if not name or name.startswith("."):
        return None
    return name if name.lower().endswith(".zwo") else name + ".zwo"


def unique_name(prefix, stem):
    name, n = f"{stem}.zwo", 2
    while STORE.exists(prefix + name):
        name, n = f"{stem}-{n}.zwo", n + 1
    return name


def read_zwo(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def list_workouts(space):
    names = [n for n in STORE.list(space + WORKOUTS) if n.lower().endswith(".zwo")]
    return [{"id": n, "xml": STORE.read(space + WORKOUTS + n) or ""} for n in names]


def list_presets(space):
    """Every .zwo under presets/<collection>/ — the collection is the folder name.
    Uploads come from the store, since that's the one collection riders change."""
    out = []
    for collection in sorted(os.listdir(PRESET_DIR)):
        folder = os.path.join(PRESET_DIR, collection)
        if collection == "uploaded" or not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if name.lower().endswith(".zwo"):
                out.append(
                    {"id": f"{collection}/{name}", "collection": collection, "xml": read_zwo(os.path.join(folder, name))}
                )
    for name in STORE.list(space + UPLOADS):
        if name.lower().endswith(".zwo"):
            out.append({"id": f"uploaded/{name}", "collection": "uploaded", "xml": STORE.read(space + UPLOADS + name) or ""})
    return out


def safe_ride_name(file_id):
    """A ride id reduced to a bare .json file name, or None."""
    name = os.path.basename(unquote(file_id).replace("\\", "/"))
    return name if name.endswith(".json") and not name.startswith(".") else None


def ride_summary(name, ride):
    return {
        "id": name,
        "workout": ride.get("workout") or "Ride",
        "workout_key": ride.get("workout_key"),
        "workout_file": ride.get("workout_file"),
        "started_at": ride.get("started_at"),
        "finished_at": ride.get("finished_at"),
        "ftp": ride.get("ftp"),
        **(ride.get("summary") or {}),
    }


def list_rides(space):
    """Ride summaries, newest first. The index repairs itself: rides it doesn't
    know yet are read once and added, and deleted rides drop out."""
    names = {n for n in STORE.list(space + RIDES) if n.endswith(".json")}
    try:
        index = json.loads(STORE.read(space + RIDE_INDEX) or "{}")
    except json.JSONDecodeError:
        index = {}
    if not isinstance(index, dict):
        index = {}
    changed = False
    for name in names - set(index):
        try:
            index[name] = ride_summary(name, json.loads(STORE.read(space + RIDES + name) or "{}"))
        except json.JSONDecodeError:
            continue
        changed = True
    for name in set(index) - names:
        del index[name]
        changed = True
    if changed:
        STORE.write(space + RIDE_INDEX, json.dumps(index))
    return sorted(index.values(), key=lambda r: r.get("started_at") or r["id"], reverse=True)


def read_favorites(space):
    """Starred workouts, as library keys like "mine:z2-steady-hour.zwo"."""
    try:
        keys = json.loads(STORE.read(space + FAVORITES) or "[]")
    except json.JSONDecodeError:
        return []
    return [k for k in keys if isinstance(k, str)] if isinstance(keys, list) else []


def read_json(key):
    try:
        data = json.loads(STORE.read(key) or "null")
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def strava_tokens(space):
    """The rider's Strava tokens, refreshed (and saved) if they'd expired, or
    None when they haven't connected Strava."""
    tokens = read_json(space + STRAVA_TOKENS)
    if not STRAVA or not tokens or not tokens.get("refresh_token"):
        return None
    tokens, changed = STRAVA.fresh(tokens)
    if changed:
        STORE.write(space + STRAVA_TOKENS, json.dumps(tokens))
    return tokens


# ---- session cookie: who is signed in, signed so it can't be forged ----


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_session(user, expires):
    payload = _b64(json.dumps({**user, "exp": expires}, separators=(",", ":")).encode())
    sig = hmac.new(SESSION_KEY, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def read_session(token):
    """The signed-in user ({"sub", "email"}, empty in password mode), or None."""
    payload, _, sig = (token or "").partition(".")
    want = hmac.new(SESSION_KEY, payload.encode(), hashlib.sha256).hexdigest()
    if not payload or not hmac.compare_digest(sig, want):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except ValueError:
        return None
    if not isinstance(data, dict) or int(data.get("exp", 0)) < time.time():
        return None
    if MODE == "accounts" and not USER_ID.match(str(data.get("sub", ""))):
        return None
    return {k: data[k] for k in ("sub", "email") if k in data}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(ROOT, "public"), **kwargs)

    def end_headers(self):
        # Dev server: never let the browser cache app files, otherwise an edit
        # appears to have no effect.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, code, obj, cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    # ---- who's asking ----

    def _route(self):
        return urlsplit(self.path).path

    def _session_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        return read_session(cookie[SESSION_COOKIE].value) if SESSION_COOKIE in cookie else None

    def _session_cookie(self, user):
        expires = int(time.time()) + SESSION_DAYS * 86400
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"{SESSION_COOKIE}={make_session(user, expires)}; Path=/; Max-Age={SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax{secure}"

    CLEAR_COOKIE = f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"

    def _redirect(self, location, cookie=None):
        self.send_response(303)
        self.send_header("Location", location)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _page(self, name):
        with open(os.path.join(ROOT, "public", name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(body)

    def _gate(self):
        """Answer the request here if it isn't allowed through; True when handled.
        Otherwise sets self.user and self.space (the rider's key prefix)."""
        route = self._route()
        self.user, self.space = {}, ""
        if MODE == "closed":
            self._json(503, {"error": "Whorl is being set up. Try again in a minute."})
            return True
        if MODE == "open":
            if route in ("/login", "/logout"):
                self._redirect("/")
                return True
            return False
        if route == "/logout":
            self._redirect("/login", self.CLEAR_COOKIE)
            return True
        if route in PUBLIC_FILES and self.command in ("GET", "HEAD"):
            return False  # logos, so the sign-in page can show them
        user = self._session_user()
        if user is not None:
            if route == "/login":
                self._redirect("/")
                return True
            self.user = user
            self.space = f"users/{user['sub']}/" if MODE == "accounts" else ""
            return False
        if route == "/login" and self.command in ("GET", "HEAD"):
            self._page(PAGES[MODE])
        elif route == "/login" and self.command == "POST" and MODE == "password":
            length = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
            given = form.get("password", [""])[0]
            if hmac.compare_digest(given.encode(), PASSWORD.encode()):
                self._redirect("/", self._session_cookie({}))
            else:
                time.sleep(1)  # slows down guessing
                self._redirect("/login?error=1")
        elif MODE == "accounts" and self.command == "POST" and route.startswith("/auth/") and route[len("/auth/"):] in PUBLIC_ACTIONS:
            self._account_action(route[len("/auth/"):])
        elif route.startswith("/api/") or route.startswith("/auth/"):
            self._json(401, {"error": "sign in first"})
        else:
            self._redirect("/login")
        return True

    # ---- accounts: sign up, confirm, sign in, reset (all before signing in) ----

    def _account_action(self, action):
        try:
            data = self._body()
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        code = re.sub(r"\s+", "", str(data.get("code", "")))
        try:
            if action == "signin":
                try:
                    user = ACCOUNTS.sign_in(email, password)
                except AccountError as e:
                    if e.code == "UserNotConfirmedException":
                        ACCOUNTS.resend(email)
                    raise
                return self._json(200, {"ok": True}, self._session_cookie({"sub": user["sub"], "email": user["email"]}))
            if action == "signup":
                ACCOUNTS.sign_up(email, password, str(data.get("inviteCode", "")))
            elif action == "confirm":
                ACCOUNTS.confirm(email, code)
            elif action == "resend":
                ACCOUNTS.resend(email)
            elif action == "forgot":
                ACCOUNTS.forgot(email)
            elif action == "reset":
                ACCOUNTS.reset(email, code, password)
        except AccountError as e:
            return self._json(400, {"error": e.message, "code": e.code})
        self._json(200, {"ok": True})

    def _delete_account(self):
        # Asks for the password again, and Cognito only deletes the account the
        # password signs into, so a stolen session cookie can't delete anyone.
        try:
            password = str(self._body().get("password", ""))
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        try:
            user = ACCOUNTS.sign_in(self.user["email"], password)
            if user["sub"] != self.user["sub"]:
                return self._json(400, {"error": "Incorrect email or password."})
            ACCOUNTS.delete(user["access_token"])
        except AccountError as e:
            return self._json(400, {"error": e.message, "code": e.code})
        tokens = read_json(self.space + STRAVA_TOKENS)
        if tokens and STRAVA:
            STRAVA.disconnect(tokens)
        STORE.delete_tree(self.space)
        self._json(200, {"ok": True}, self.CLEAR_COOKIE)

    # ---- Strava: connect an account, post rides to it ----

    def _origin(self):
        proto = self.headers.get("X-Forwarded-Proto") or "http"
        return f"{proto}://{self.headers.get('Host', f'localhost:{PORT}')}"

    def _strava_connect(self):
        state = Strava.new_state()
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        cookie = f"{STRAVA_STATE_COOKIE}={state}; Path=/strava; Max-Age=600; HttpOnly; SameSite=Lax{secure}"
        self._redirect(STRAVA.authorize_url(self._origin() + "/strava/callback", state), cookie)

    def _strava_callback(self):
        query = parse_qs(urlsplit(self.path).query)
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        want = cookie[STRAVA_STATE_COOKIE].value if STRAVA_STATE_COOKIE in cookie else ""
        state = query.get("state", [""])[0]
        clear = f"{STRAVA_STATE_COOKIE}=; Path=/strava; Max-Age=0; HttpOnly; SameSite=Lax"
        if not want or not hmac.compare_digest(state, want):
            return self._redirect("/?strava=error", clear)
        if "error" in query or "activity:write" not in query.get("scope", [""])[0]:
            # Denied, or allowed without permission to upload.
            return self._redirect("/?strava=denied", clear)
        try:
            tokens = STRAVA.exchange(query.get("code", [""])[0])
        except StravaError:
            return self._redirect("/?strava=error", clear)
        STORE.write(self.space + STRAVA_TOKENS, json.dumps(tokens))
        self._redirect("/?strava=connected", clear)

    def _strava_post(self, name):
        """Upload the saved ride; the ride file remembers the upload."""
        key = self.space + RIDES + name
        ride = read_json(key)
        if ride is None:
            return self._json(404, {"error": "not found"})
        try:
            tokens = strava_tokens(self.space)
            if not tokens:
                return self._json(400, {"error": "Connect Strava in Settings first."})
            done = (ride.get("strava") or {}).get("activity_id")
            status = {"state": "done", "activity_id": done} if done else STRAVA.upload(tokens, ride, name[: -len(".json")])
        except StravaError as e:
            return self._json(502, {"error": e.message})
        return self._json(200, self._strava_record(key, ride, status))

    def _strava_check(self, name):
        key = self.space + RIDES + name
        ride = read_json(key)
        status = (ride or {}).get("strava")
        if not status:
            return self._json(404, {"error": "not posted to Strava"})
        if status.get("state") == "processing" and status.get("upload_id"):
            try:
                tokens = strava_tokens(self.space)
                if tokens:
                    status = self._strava_record(key, ride, STRAVA.upload_status(tokens, status["upload_id"]))
            except StravaError as e:
                return self._json(502, {"error": e.message})
        self._json(200, status)

    @staticmethod
    def _strava_record(key, ride, status):
        status = {k: v for k, v in status.items() if v is not None}
        if ride.get("strava") != status:
            ride["strava"] = status
            STORE.write(key, json.dumps(ride))
        return status

    # ---- requests from a signed-in rider ----

    def do_HEAD(self):
        if not self._gate():
            super().do_HEAD()

    def do_GET(self):
        if self._gate():
            return
        route = self._route()
        if route == "/strava/connect" and STRAVA:
            self._strava_connect()
        elif route == "/strava/callback" and STRAVA:
            self._strava_callback()
        elif self.path == "/api/strava":
            tokens = read_json(self.space + STRAVA_TOKENS) if STRAVA else None
            self._json(200, {"available": bool(STRAVA), "connected": bool(tokens),
                             "athlete": (tokens or {}).get("athlete")})
        elif self.path.startswith("/api/rides/") and self.path.endswith("/strava"):
            name = safe_ride_name(self.path[len("/api/rides/"):-len("/strava")])
            self._strava_check(name) if name else self._json(404, {"error": "not found"})
        elif self.path == "/api/workouts":
            self._json(200, list_workouts(self.space))
        elif self.path == "/api/presets":
            self._json(200, list_presets(self.space))
        elif self.path == "/api/favorites":
            self._json(200, read_favorites(self.space))
        elif self.path == "/api/rides":
            self._json(200, list_rides(self.space))
        elif self.path.startswith("/api/rides/"):
            name = safe_ride_name(self.path[len("/api/rides/"):])
            data = name and STORE.read(self.space + RIDES + name)
            if data:
                body = data.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self._json(404, {"error": "not found"})
        elif self.path == "/auth/me":
            self._json(200, {"mode": MODE, "email": self.user.get("email")})
        else:
            super().do_GET()

    def do_POST(self):
        if self._gate():
            return
        if self.path == "/auth/delete-account" and MODE == "accounts":
            return self._delete_account()
        if self.path.startswith("/api/rides/") and self.path.endswith("/strava") and STRAVA:
            name = safe_ride_name(self.path[len("/api/rides/"):-len("/strava")])
            return self._strava_post(name) if name else self._json(404, {"error": "not found"})
        try:
            payload = self._body()
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        space = self.space

        if self.path == "/api/workouts":
            # Save. An explicit id overwrites that file; otherwise the file name
            # comes from the workout name, suffixed so nothing is clobbered.
            xml = payload.get("xml", "")
            if "<workout_file" not in xml:
                self._json(400, {"error": "not a zwo file"})
                return
            name = safe_name(payload.get("id") or unique_name(space + WORKOUTS, slugify(payload.get("name", "workout"))))
            if not name:
                self._json(400, {"error": "bad id"})
                return
            STORE.write(space + WORKOUTS + name, xml)
            self._json(200, {"ok": True, "id": name})

        elif self.path == "/api/presets":
            # Upload into the browse library. Never overwrites: a second file
            # with the same name gets a suffix.
            xml = payload.get("xml", "")
            if "<workout_file" not in xml:
                self._json(400, {"error": "not a zwo file"})
                return
            stem = slugify(os.path.splitext(os.path.basename(payload.get("filename") or "workout"))[0])
            name = unique_name(space + UPLOADS, stem)
            STORE.write(space + UPLOADS + name, xml)
            self._json(200, {"ok": True, "id": f"uploaded/{name}"})

        elif self.path == "/api/favorites":
            # The whole list is sent each time; it's small.
            keys = payload.get("keys")
            if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
                self._json(400, {"error": "keys must be a list of strings"})
                return
            STORE.write(space + FAVORITES, json.dumps(sorted(set(keys)), indent=2))
            self._json(200, {"ok": True})

        elif self.path == "/api/rides":
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
            name = f"{stamp}-{slugify(payload.get('workout', 'ride'))}.json"
            STORE.write(space + RIDES + name, json.dumps(payload))
            self._json(200, {"ok": True, "file": name})

        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if self._gate():
            return
        # Only files the rider made or uploaded can be deleted; bundled presets can't.
        key = None
        if self.path == "/api/strava":
            tokens = read_json(self.space + STRAVA_TOKENS)
            if tokens and STRAVA:
                STRAVA.disconnect(tokens)
            STORE.delete(self.space + STRAVA_TOKENS)
            return self._json(200, {"ok": True})
        if self.path.startswith("/api/workouts/"):
            name = safe_name(self.path[len("/api/workouts/"):])
            key = name and self.space + WORKOUTS + name
        elif self.path.startswith("/api/presets/uploaded/"):
            name = safe_name(self.path[len("/api/presets/uploaded/"):])
            key = name and self.space + UPLOADS + name
        elif self.path.startswith("/api/rides/"):
            name = safe_ride_name(self.path[len("/api/rides/"):])
            key = name and self.space + RIDES + name
        if key and STORE.delete(key):
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, format, *args):
        # only log API traffic, not static file requests
        if args and any(p in str(args[0]) for p in ("/api/", "/auth/", "/strava/")):
            super().log_message(format, *args)


if __name__ == "__main__":
    print(f"Whorl — http://localhost:{PORT}" + (" (also reachable from other machines)" if HOST == "0.0.0.0" else ""))
    where = f"s3://{STORE.bucket}/" if hasattr(STORE, "bucket") else ROOT + "/"
    print(f"Workouts → {where}{'users/<id>/' if MODE == 'accounts' else ''}{WORKOUTS}")
    print(f"Presets  → {PRESET_DIR}/")
    print(
        {
            "accounts": "Sign-in → accounts (Cognito)",
            "password": "Sign-in → shared beta password",
            "open": "Sign-in → off (set WHORL_PASSWORD or beta-password.txt to require a password)",
        }[MODE]
    )
    print("Strava   → " + ("on" if STRAVA else "off (add strava-app.json to turn it on)"))
    HTTPServer((HOST, PORT), Handler).serve_forever()
