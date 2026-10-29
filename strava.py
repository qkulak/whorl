"""Posting finished rides to Strava.

A rider connects their Strava account once (OAuth, scope activity:write); the
tokens Strava hands back are kept with the rider's other files. Each saved ride
is turned into a TCX file (per-second power, heart rate and cadence) and sent to
Strava's upload API, marked as a trainer ride. Plain HTTPS, no dependencies.

The Strava API application's id and secret come from WHORL_STRAVA_CLIENT_ID and
WHORL_STRAVA_CLIENT_SECRET, or locally from strava-app.json (git-ignored):
    {"client_id": "12345", "client_secret": "..."}
Without them the Strava option is hidden.
"""
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

API = "https://www.strava.com/api/v3"
AUTHORIZE = "https://www.strava.com/oauth/authorize"
TOKEN = "https://www.strava.com/oauth/token"
DEAUTHORIZE = "https://www.strava.com/oauth/deauthorize"
APP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "strava-app.json")


class StravaError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.message = message
        self.status = status


def load_app():
    """(client_id, client_secret), or None when Strava isn't set up."""
    cid, secret = os.environ.get("WHORL_STRAVA_CLIENT_ID"), os.environ.get("WHORL_STRAVA_CLIENT_SECRET")
    if not (cid and secret):
        try:
            with open(APP_FILE, encoding="utf-8") as f:
                app = json.load(f)
            cid, secret = str(app.get("client_id", "")), str(app.get("client_secret", ""))
        except (OSError, ValueError):
            return None
    return (cid.strip(), secret.strip()) if cid and secret else None


def _request(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"strava {method or ('POST' if data else 'GET')} {url.split('?')[0]}: HTTP {e.code}: {body[:300]}")
        if e.code == 401:
            raise StravaError("Strava didn't accept the connection. Reconnect Strava in Settings.", 401) from None
        if e.code == 429:
            raise StravaError("Strava is busy (rate limit). Try again in a few minutes.", 429) from None
        raise StravaError("Strava couldn't take that request. Try again.", e.code) from None
    except urllib.error.URLError:
        raise StravaError("Couldn't reach Strava. Check the connection and try again.") from None


class Strava:
    def __init__(self, client_id, client_secret):
        self.client_id = client_id
        self.client_secret = client_secret

    # ---- connecting an account ----

    @staticmethod
    def new_state():
        return secrets.token_urlsafe(24)

    def authorize_url(self, redirect_uri, state):
        return AUTHORIZE + "?" + urllib.parse.urlencode({
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "approval_prompt": "auto",
            "scope": "activity:write",
            "state": state,
        })

    def _token(self, **params):
        data = urllib.parse.urlencode({"client_id": self.client_id, "client_secret": self.client_secret, **params}).encode()
        out = _request(TOKEN, data, {"Content-Type": "application/x-www-form-urlencoded"})
        return {k: out[k] for k in ("access_token", "refresh_token", "expires_at")} | (
            {"athlete": _athlete(out["athlete"])} if out.get("athlete") else {}
        )

    def exchange(self, code):
        """Tokens (and who the athlete is) for the code Strava sent back."""
        return self._token(code=code, grant_type="authorization_code")

    def fresh(self, tokens):
        """tokens, refreshed if the access token is (nearly) expired. The second
        value says whether they changed and need saving."""
        if int(tokens.get("expires_at", 0)) > time.time() + 120:
            return tokens, False
        new = self._token(refresh_token=tokens["refresh_token"], grant_type="refresh_token")
        return {**tokens, **new}, True

    def disconnect(self, tokens):
        try:
            _request(DEAUTHORIZE, urllib.parse.urlencode({"access_token": tokens["access_token"]}).encode())
        except StravaError:
            pass  # forgetting the tokens here is what matters

    # ---- uploading a ride ----

    def upload(self, tokens, ride, external_id):
        """Starts the upload; Strava processes it in the background. Returns the
        upload id to check on with upload_status."""
        fields = {
            "data_type": "tcx",
            "name": f"Whorl - {ride.get('workout') or 'Ride'}",
            "description": describe(ride),
            "trainer": "1",
            "external_id": external_id,
        }
        boundary = "whorl" + secrets.token_hex(12)
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()
        ]
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{external_id}.tcx"\r\n'
            "Content-Type: application/xml\r\n\r\n".encode() + to_tcx(ride).encode() + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode())
        out = _request(f"{API}/uploads", b"".join(parts), {
            "Authorization": f"Bearer {tokens['access_token']}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })
        return status_of(out)

    def upload_status(self, tokens, upload_id):
        out = _request(f"{API}/uploads/{int(upload_id)}", headers={"Authorization": f"Bearer {tokens['access_token']}"})
        return status_of(out)


def _athlete(a):
    return {"id": a.get("id"), "name": " ".join(x for x in (a.get("firstname"), a.get("lastname")) if x)}


def status_of(upload):
    """Strava's upload record, reduced to what the app shows: "processing",
    "done" (with activity_id), or "error" (with a message). A ride Strava
    already has counts as done, pointing at the activity it already has."""
    out = {"upload_id": upload.get("id")}
    if upload.get("activity_id"):
        return {**out, "state": "done", "activity_id": upload["activity_id"]}
    error = upload.get("error")
    if error:
        dup = re.search(r"duplicate of .*?activities/(\d+)", error)
        if dup:
            return {**out, "state": "done", "activity_id": int(dup.group(1))}
        return {**out, "state": "error", "error": re.sub(r"<[^>]+>", "", error)}
    return {**out, "state": "processing"}


def describe(ride):
    s = ride.get("summary") or {}
    bits = [f"NP {s['np']} W" if s.get("np") else None,
            f"IF {s['if']:.2f}" if s.get("if") else None,
            f"TSS {s['tss']}" if s.get("tss") else None,
            f"FTP {ride['ftp']} W" if ride.get("ftp") else None]
    return " · ".join(b for b in bits if b) + "\n\nRidden on Whorl"


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def to_tcx(ride):
    """The ride as a TCX activity: one trackpoint per riding second, with power
    in the ActivityExtension that Strava reads."""
    try:
        start = datetime.fromisoformat(str(ride.get("started_at")).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        start = datetime.now(timezone.utc)
    start = start.replace(microsecond=0)
    samples = ride.get("samples") or []
    s = ride.get("summary") or {}
    points, dist = [], 0.0
    for i, smp in enumerate(samples):
        p = [f"<Time>{_iso(start + timedelta(seconds=i))}</Time>"]
        if smp.get("spd") is not None:
            dist += float(smp["spd"]) / 3.6  # km/h for one second
            p.append(f"<DistanceMeters>{dist:.1f}</DistanceMeters>")
        if smp.get("hr"):
            p.append(f"<HeartRateBpm><Value>{int(smp['hr'])}</Value></HeartRateBpm>")
        if smp.get("cad") is not None:
            p.append(f"<Cadence>{int(smp['cad'])}</Cadence>")
        p.append(f"<Extensions><ns3:TPX><ns3:Watts>{int(smp.get('w') or 0)}</ns3:Watts></ns3:TPX></Extensions>")
        points.append("<Trackpoint>" + "".join(p) + "</Trackpoint>")
    lap = [f"<TotalTimeSeconds>{len(samples)}</TotalTimeSeconds>", f"<DistanceMeters>{dist:.1f}</DistanceMeters>",
           f"<Calories>{int(s.get('kj') or 0)}</Calories>"]  # kJ of work ≈ kcal burned on a bike
    if s.get("avg_hr"):
        lap.append(f"<AverageHeartRateBpm><Value>{int(s['avg_hr'])}</Value></AverageHeartRateBpm>")
    lap += ["<Intensity>Active</Intensity>", "<TriggerMethod>Manual</TriggerMethod>"]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" '
        'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">'
        f'<Activities><Activity Sport="Biking"><Id>{_iso(start)}</Id>'
        f'<Lap StartTime="{_iso(start)}">' + "".join(lap) + "<Track>" + "".join(points) + "</Track></Lap>"
        f"<Notes>{escape(ride.get('workout') or '')}</Notes>"
        "</Activity></Activities></TrainingCenterDatabase>\n"
    )
