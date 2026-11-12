"""Workouts in Python: read and write .zwo files, check workouts that agents
send, and work out the numbers the library shows (duration, IF, TSS, category).

It mirrors public/zwo.js, so a file written here looks the same in the app as
one saved from the builder. A workout is a dict:

    {"name", "author", "description", "category", "tags": [...], "blocks": [...]}

Blocks use the app's own model. Power is a fraction of FTP (0.75 = 75%) and
durations are seconds:

    steady    {duration, power}
    warmup    {duration, powerLow, powerHigh}   ramps low -> high
    cooldown  {duration, powerLow, powerHigh}   ramps high -> low
    ramp      {duration, powerLow, powerHigh}
    intervals {repeat, onDuration, offDuration, onPower, offPower, cadenceResting?}
    free      {duration}                         no target, trainer in sim mode

Any block may carry cadence and textevents [{offset, message}].

Agents (mcp.py) speak a friendlier dialect: snake_case names and power in % of
FTP. from_agent() and to_agent() convert between the two.
"""
import xml.etree.ElementTree as ET

CATEGORIES = ["Recovery", "Endurance", "Tempo", "Sweet Spot", "Threshold", "VO2 Max", "Anaerobic"]
BLOCK_TYPES = ("warmup", "steady", "intervals", "ramp", "cooldown", "free")

# What an agent may send. Generous enough for any real workout, small enough
# that nobody fills a rider's library with junk.
MAX_TOTAL = 6 * 3600
MAX_BLOCKS = 300
MAX_REPEAT = 100
MAX_EVENTS = 50
POWER_RANGE = (0, 300)  # % FTP
CADENCE_RANGE = (40, 150)


class WorkoutError(ValueError):
    """A workout that can't be saved; the message says what to fix."""


# ---------- reading .zwo ----------


def _num(el, *names):
    for n in names:
        v = el.get(n)
        if v not in (None, ""):
            try:
                return float(v)
            except ValueError:
                return None
    return None


def _int(x):
    return int(x) if x is not None and float(x).is_integer() else x


def parse(xml):
    """A .zwo file as a workout dict. Unknown elements are skipped, like the app does."""
    head = xml[:2000].lower()
    if "<!doctype" in head or "<!entity" in head:
        raise WorkoutError("DOCTYPE and ENTITY declarations aren't allowed")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        raise WorkoutError(f"not valid XML ({e})")
    if root.tag.lower() != "workout_file":
        raise WorkoutError("no <workout_file> element")

    def text(tag):
        el = next((c for c in root if c.tag.lower() == tag), None)
        return (el.text or "").strip() if el is not None else ""

    workout_el = next((c for c in root if c.tag.lower() == "workout"), None)
    if workout_el is None:
        raise WorkoutError("no <workout> element")

    blocks = []
    for el in workout_el:
        tag = el.tag.lower()
        duration = _int(_num(el, "Duration"))
        if tag in ("steadystate", "solidstate"):
            p = _num(el, "Power", "PowerLow")
            b = {"type": "steady", "duration": duration, "power": 0.5 if p is None else p}
        elif tag in ("warmup", "ramp", "cooldown"):
            lo = _num(el, "PowerLow", "Power")
            lo = 0.5 if lo is None else lo
            hi = _num(el, "PowerHigh", "Power")
            b = {"type": tag, "duration": duration, "powerLow": lo, "powerHigh": lo if hi is None else hi}
        elif tag == "intervalst":
            on_p = _num(el, "OnPower", "PowerOnHigh", "PowerOnLow")
            off_p = _num(el, "OffPower", "PowerOffLow", "PowerOffHigh")
            b = {
                "type": "intervals",
                "repeat": _int(_num(el, "Repeat") or 1),
                "onDuration": _int(_num(el, "OnDuration") or 60),
                "offDuration": _int(_num(el, "OffDuration") or 60),
                "onPower": 1 if on_p is None else on_p,
                "offPower": 0.5 if off_p is None else off_p,
            }
            cr = _num(el, "CadenceResting")
            if cr:
                b["cadenceResting"] = _int(cr)
        elif tag in ("freeride", "maxeffort"):
            b = {"type": "free", "duration": duration}
        else:
            continue
        cad = _num(el, "Cadence")
        if cad:
            b["cadence"] = _int(cad)
        events = [
            {"offset": _int(_num(t, "timeoffset", "TimeOffset") or 0), "message": t.get("message") or t.get("Message") or ""}
            for t in el
            if t.tag.lower() == "textevent"
        ]
        if events:
            b["textevents"] = events
        if b["type"] != "intervals" and not (b.get("duration") or 0) > 0:
            continue
        blocks.append(b)

    tags_el = next((c for c in root if c.tag.lower() == "tags"), None)
    tags = [t.get("name") for t in tags_el if t.tag.lower() == "tag" and t.get("name")] if tags_el is not None else []
    return {
        "name": text("name") or "Untitled workout",
        "author": text("author"),
        "description": text("description"),
        "category": text("category"),
        "tags": tags,
        "blocks": blocks,
    }


# ---------- writing .zwo (same output as serializeZwo in zwo.js) ----------


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _f(x):
    """A number the way JS would print it: 0.75, 1, 120."""
    x = round(x * 1000) / 1000 if isinstance(x, float) else x
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def serialize(w):
    lines = []
    for b in w["blocks"]:
        t = b["type"]
        if t == "steady":
            tag, attrs = "SteadyState", {"Duration": b["duration"], "Power": b["power"]}
        elif t in ("warmup", "ramp", "cooldown"):
            tag = {"warmup": "Warmup", "ramp": "Ramp", "cooldown": "Cooldown"}[t]
            attrs = {"Duration": b["duration"], "PowerLow": b["powerLow"], "PowerHigh": b["powerHigh"]}
        elif t == "intervals":
            tag = "IntervalsT"
            attrs = {
                "Repeat": b["repeat"],
                "OnDuration": b["onDuration"],
                "OffDuration": b["offDuration"],
                "OnPower": b["onPower"],
                "OffPower": b["offPower"],
            }
            if b.get("cadenceResting"):
                attrs["CadenceResting"] = b["cadenceResting"]
        else:
            tag, attrs = "FreeRide", {"Duration": b["duration"], "FlatRoad": 1}
        if b.get("cadence"):
            attrs["Cadence"] = b["cadence"]
        a = " ".join(f'{k}="{_esc(_f(v))}"' for k, v in attrs.items())
        events = b.get("textevents") or []
        if not events:
            lines.append(f"    <{tag} {a}/>")
            continue
        ev = "\n".join(
            f'      <textevent timeoffset="{_f(e["offset"])}" message="{_esc(e["message"])}"/>' for e in events
        )
        lines.append(f"    <{tag} {a}>\n{ev}\n    </{tag}>")
    tags = w.get("tags") or []
    tag_xml = (
        "<tags>\n" + "\n".join(f'        <tag name="{_esc(t)}"/>' for t in tags) + "\n    </tags>" if tags else "<tags/>"
    )
    category = f"    <category>{_esc(w['category'])}</category>\n" if w.get("category") else ""
    return f"""<workout_file>
    <author>{_esc(w.get("author") or "")}</author>
    <name>{_esc(w.get("name") or "Untitled workout")}</name>
    <description>{_esc(w.get("description") or "")}</description>
{category}    <sportType>bike</sportType>
    {tag_xml}
    <workout>
{chr(10).join(lines)}
    </workout>
</workout_file>
"""


# ---------- timeline and numbers (same as expand / stats / categorize in zwo.js) ----------


def segments(w):
    """(duration, from, to, free) for every stretch of the workout, in order."""
    out = []
    for b in w["blocks"]:
        t = b["type"]
        if t == "steady":
            out.append((b["duration"], b["power"], b["power"], False))
        elif t in ("warmup", "ramp"):
            out.append((b["duration"], b["powerLow"], b["powerHigh"], False))
        elif t == "cooldown":
            hi, lo = max(b["powerLow"], b["powerHigh"]), min(b["powerLow"], b["powerHigh"])
            out.append((b["duration"], hi, lo, False))
        elif t == "intervals":
            for _ in range(int(b["repeat"])):
                out.append((b["onDuration"], b["onPower"], b["onPower"], False))
                out.append((b["offDuration"], b["offPower"], b["offPower"], False))
        else:
            out.append((b["duration"], 0.5, 0.5, True))
    return [s for s in out if s[0] > 0]


def block_duration(b):
    if b["type"] == "intervals":
        return int(b["repeat"]) * (b["onDuration"] + b["offDuration"])
    return b["duration"]


def stats(w):
    segs = segments(w)
    sum4 = n = 0
    for d, a, z, free in segs:
        d = int(d)
        for i in range(d):
            f = 0.5 if free else a + (z - a) * (i + 0.5) / d
            sum4 += f**4
            n += 1
    duration = sum(s[0] for s in segs)
    IF = (sum4 / n) ** 0.25 if n else 0
    return {"duration": duration, "IF": IF, "tss": duration * IF * IF * 100 / 3600}


def categorize(w):
    named = next((c for c in CATEGORIES if c.lower() == (w.get("category") or "").lower()), None)
    if named:
        return named
    segs = segments(w)

    def at(lo, hi=float("inf")):
        return sum(d for d, a, z, free in segs if not free and lo <= (a + z) / 2 < hi)

    vo2 = at(1.06)
    if vo2 >= 300:
        return "Anaerobic" if at(1.3) / vo2 > 0.5 else "VO2 Max"
    if at(1.2) >= 30:
        return "Anaerobic"
    if at(0.96, 1.06) >= 360:
        return "Threshold"
    if at(0.88, 0.96) >= 600:
        return "Sweet Spot"
    if at(0.76, 0.88) >= 600:
        return "Tempo"
    return "Recovery" if stats(w)["IF"] < 0.6 else "Endurance"


def summary(w):
    s = stats(w)
    return {
        "duration_s": int(s["duration"]),
        "category": categorize(w),
        "intensity_factor": round(s["IF"], 2),
        "tss": round(s["tss"]),
    }


# ---------- the workout as text, for places that can't show a picture ----------

# Zone tops (as in ZONES in zwo.js) and the emoji square for each zone's colour.
ZONE_TOPS = (0.6, 0.76, 0.9, 1.05, 1.18, float("inf"))
ZONE_SQUARES = ("⬜", "🟦", "🟩", "🟨", "🟧", "🟥")
BLANK = "　"  # ideographic space: as wide as an emoji, so columns line up


def _zone(f):
    return next(i for i, top in enumerate(ZONE_TOPS) if f < top)


def chart_levels(w, cols):
    """One target per column. A column takes the hardest target that fills at
    least half of it, so rests between efforts still show; failing that, the
    target it spends longest at."""
    segs = segments(w)
    total = sum(s[0] for s in segs)
    if not total:
        return []
    levels = []
    for c in range(cols):
        a, b = c * total / cols, (c + 1) * total / cols
        t, parts = 0.0, []
        for d, lo, hi, free in segs:
            s0, s1 = max(a, t), min(b, t + d)
            if s1 > s0:
                mid = ((s0 + s1) / 2 - t) / d
                parts.append((s1 - s0, 0.5 if free else lo + (hi - lo) * mid))
            t += d
        big = [f for d, f in parts if d >= (b - a) / 2]
        levels.append(max(big) if big else max(parts)[1])
    return levels


def text_chart(w, cols=15, rows=5, floor=0.35):
    """The workout's bar chart drawn with zone-coloured emoji squares, for a
    Strava description. 15 columns fit on a phone without wrapping. Bar heights
    run from `floor` (% FTP as a fraction) to the workout's hardest column."""
    levels = chart_levels(w, cols)
    if not levels:
        return ""
    span = max(max(levels) - floor, 1e-9)
    heights = [max(1, min(rows, round((f - floor) / span * rows))) for f in levels]
    return "\n".join(
        "".join(ZONE_SQUARES[_zone(f)] if h >= r else BLANK for f, h in zip(levels, heights))
        for r in range(rows, 0, -1)
    )


# ---------- the agent dialect: snake_case, power in % FTP ----------

_PCT = lambda f: round(f * 1000) / 10  # 0.755 -> 75.5


def to_agent(w):
    """A workout as agents see it from get_workout."""
    blocks = []
    for b in w["blocks"]:
        t = b["type"]
        out = {"type": t}
        if t == "steady":
            out.update(duration=b["duration"], power=_PCT(b["power"]))
        elif t in ("warmup", "ramp", "cooldown"):
            out.update(duration=b["duration"], power_low=_PCT(b["powerLow"]), power_high=_PCT(b["powerHigh"]))
        elif t == "intervals":
            out.update(
                repeat=b["repeat"],
                on_duration=b["onDuration"],
                on_power=_PCT(b["onPower"]),
                off_duration=b["offDuration"],
                off_power=_PCT(b["offPower"]),
            )
            if b.get("cadenceResting"):
                out["cadence_resting"] = b["cadenceResting"]
        else:
            out["duration"] = b["duration"]
        if b.get("cadence"):
            out["cadence"] = b["cadence"]
        if b.get("textevents"):
            out["text_events"] = [{"offset": e["offset"], "message": e["message"]} for e in b["textevents"]]
        blocks.append(out)
    return {
        "name": w["name"],
        "description": w.get("description") or "",
        "category": w.get("category") or "",
        "tags": w.get("tags") or [],
        "blocks": blocks,
    }


def _need(cond, msg):
    if not cond:
        raise WorkoutError(msg)


def _number(b, key, where, lo, hi, integer=False):
    v = b.get(key)
    _need(isinstance(v, (int, float)) and not isinstance(v, bool), f"{where}: {key} is required and must be a number")
    _need(lo <= v <= hi, f"{where}: {key} {v:g} is outside {lo}-{hi}")
    if integer:
        _need(float(v).is_integer(), f"{where}: {key} must be a whole number")
        return int(v)
    return v


def _text(v, where, limit, required=False):
    if v is None:
        v = ""
    _need(isinstance(v, str), f"{where} must be text")
    v = v.strip()
    _need(v or not required, f"{where} is required")
    _need(len(v) <= limit, f"{where} is longer than {limit} characters")
    return v


ALLOWED = {
    "steady": {"duration", "power"},
    "warmup": {"duration", "power_low", "power_high"},
    "cooldown": {"duration", "power_low", "power_high"},
    "ramp": {"duration", "power_low", "power_high"},
    "intervals": {"repeat", "on_duration", "on_power", "off_duration", "off_power", "cadence_resting"},
    "free": {"duration"},
}


def from_agent(data, author):
    """Check a workout an agent sent and turn it into the app's model.
    Raises WorkoutError naming the first problem."""
    _need(isinstance(data, dict), "the workout must be an object")
    name = _text(data.get("name"), "name", 80, required=True)
    description = _text(data.get("description"), "description", 2000)
    category = _text(data.get("category"), "category", 30)
    if category:
        match = next((c for c in CATEGORIES if c.lower() == category.lower()), None)
        _need(match, f"category must be one of: {', '.join(CATEGORIES)}")
        category = match
    tags = data.get("tags") or []
    _need(isinstance(tags, list) and len(tags) <= 10, "tags must be a list of at most 10")
    tags = [_text(t, "each tag", 30, required=True) for t in tags]

    raw = data.get("blocks")
    _need(isinstance(raw, list) and raw, "blocks must be a non-empty list")
    _need(len(raw) <= MAX_BLOCKS, f"at most {MAX_BLOCKS} blocks")
    blocks = []
    for i, rb in enumerate(raw, 1):
        _need(isinstance(rb, dict), f"block {i} must be an object")
        t = rb.get("type")
        where = f"block {i} ({t})"
        _need(t in BLOCK_TYPES, f"block {i}: type must be one of {', '.join(BLOCK_TYPES)}")
        extra = set(rb) - ALLOWED[t] - {"type", "cadence", "text_events"}
        _need(not extra, f"{where}: unknown field(s) {', '.join(sorted(extra))}")
        pct = lambda k: _number(rb, k, where, *POWER_RANGE) / 100
        secs = lambda k: _number(rb, k, where, 1, MAX_TOTAL, integer=True)
        if t == "steady":
            b = {"type": t, "duration": secs("duration"), "power": pct("power")}
        elif t in ("warmup", "ramp", "cooldown"):
            b = {"type": t, "duration": secs("duration"), "powerLow": pct("power_low"), "powerHigh": pct("power_high")}
        elif t == "intervals":
            b = {
                "type": t,
                "repeat": _number(rb, "repeat", where, 1, MAX_REPEAT, integer=True),
                "onDuration": secs("on_duration"),
                "offDuration": secs("off_duration"),
                "onPower": pct("on_power"),
                "offPower": pct("off_power"),
            }
            if rb.get("cadence_resting") is not None:
                b["cadenceResting"] = _number(rb, "cadence_resting", where, *CADENCE_RANGE, integer=True)
        else:
            b = {"type": t, "duration": secs("duration")}
        if rb.get("cadence") is not None:
            b["cadence"] = _number(rb, "cadence", where, *CADENCE_RANGE, integer=True)
        events = rb.get("text_events") or []
        _need(isinstance(events, list) and len(events) <= MAX_EVENTS, f"{where}: text_events must be a list of at most {MAX_EVENTS}")
        length = block_duration(b)
        out = []
        for e in events:
            _need(isinstance(e, dict), f"{where}: each text event must be an object")
            offset = _number(e, "offset", f"{where} text event", 0, max(0, length - 1), integer=True)
            out.append({"offset": offset, "message": _text(e.get("message"), f"{where} text event message", 200, required=True)})
        if out:
            b["textevents"] = sorted(out, key=lambda e: e["offset"])
        blocks.append(b)

    w = {"name": name, "author": author, "description": description, "category": category, "tags": tags, "blocks": blocks}
    total = sum(block_duration(b) for b in blocks)
    _need(total <= MAX_TOTAL, f"the workout is {total // 60} minutes; the limit is {MAX_TOTAL // 3600} hours")
    return w
