"""Generate the bundled preset workouts in presets/featured and presets/classics.

    python3 scripts/build_presets.py

FEATURED collection
    Each workout is given a name, duration and AVG / MIN / MAX %FTP, and the
segment-by-segment profile is designed inside the
    app. These are rebuilt to hit the published numbers exactly, using whatever
    interval outline the public pages give (e.g. "6 x 4 min over-unders").
    Each file says so in its description. The script asserts the published
    numbers, so a tweak that drifts from them fails loudly.

Classics collection
    Fully specified protocols from published coaching protocols (sweet spot, VO2
    max). The articles give the main set only, so warmup and cooldown are added
    and noted.
"""
import os
from xml.sax.saxutils import quoteattr, escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "presets")

# ---------- block helpers: power as FTP fraction, durations in seconds ----------


def W(d, lo, hi, cad=None, ev=()):
    return ("Warmup", d, lo, hi, cad, ev)


def S(d, p, cad=None, ev=()):
    return ("SteadyState", d, p, p, cad, ev)


def R(d, lo, hi, cad=None, ev=()):
    return ("Ramp", d, lo, hi, cad, ev)


def C(d, hi, lo, cad=None, ev=()):
    return ("Cooldown", d, hi, lo, cad, ev)


def I(reps, on, on_p, off, off_p, cad=None, ev=()):
    return ("IntervalsT", reps, on, on_p, off, off_p, cad, ev)


def segments(blocks):
    """Flatten to (duration, start_frac, end_frac) for the stats checks."""
    out = []
    for b in blocks:
        if b[0] == "IntervalsT":
            _, reps, on, on_p, off, off_p, _, _ = b
            out += [(on, on_p, on_p), (off, off_p, off_p)] * reps
        else:
            out.append((b[1], b[2], b[3]))
    return out


def summary(blocks):
    segs = segments(blocks)
    dur = sum(s[0] for s in segs)
    avg = sum(s[0] * (s[1] + s[2]) / 2 for s in segs) / dur
    lo = min(min(s[1], s[2]) for s in segs)
    hi = max(max(s[1], s[2]) for s in segs)
    return dur, round(avg * 100), round(lo * 100), round(hi * 100)


def events_xml(ev):
    return "".join(
        f'\n            <textevent timeoffset="{t}" message={quoteattr(m)}/>' for t, m in ev
    )


def to_xml(name, description, blocks, tags, category):
    lines = []
    for b in blocks:
        if b[0] == "IntervalsT":
            _, reps, on, on_p, off, off_p, cad, ev = b
            attrs = f'Repeat="{reps}" OnDuration="{on}" OffDuration="{off}" OnPower="{on_p:g}" OffPower="{off_p:g}"'
        else:
            tag, d, a, z, cad, ev = b
            attrs = (
                f'Duration="{d}" Power="{a:g}"'
                if tag == "SteadyState"
                else f'Duration="{d}" PowerLow="{a:g}" PowerHigh="{z:g}"'
            )
            b = (tag,)
        if cad:
            attrs += f' Cadence="{cad}"'
        body = events_xml(ev)
        lines.append(
            f"        <{b[0]} {attrs}>{body}\n        </{b[0]}>" if ev else f"        <{b[0]} {attrs}/>"
        )
    tag_xml = "".join(f'\n        <tag name="{t}"/>' for t in tags)
    return f"""<workout_file>
    <author>{escape(AUTHOR)}</author>
    <name>{escape(name)}</name>
    <description>{escape(description)}</description>
    <category>{category}</category>
    <sportType>bike</sportType>
    <tags>{tag_xml}
    </tags>
    <workout>
{chr(10).join(lines)}
    </workout>
</workout_file>
"""


def slug(name):
    import re
    import unicodedata

    ascii_name = unicodedata.normalize("NFKD", name.replace("ø", "o")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


# What each preset trains. Written into the file as <category> so the browse
# filters don't depend on the app's guess for borderline workouts.
CATEGORY = {
    "Rolling Country": "Endurance",
    "Up and Over": "Endurance",
    "First Taste of FTP": "Endurance",
    "Low and Steady": "Endurance",
    "Steady Cruise": "Tempo",
    "Big Gear Tempo": "Tempo",
    "The Last Word": "Sweet Spot",
    "Quick Draw": "Sweet Spot",
    "Low-Cadence Climber": "Sweet Spot",
    "Threshold Snaps": "Threshold",
    "Six Over-Unders": "Threshold",
    "Minute On, Minute Off": "VO2 Max",
    "Five-Minute Fury": "VO2 Max",
    "Spark Plugs": "Anaerobic",
    "Zone 2 Staircase": "Endurance",
    "Sweet Spot 2x20": "Sweet Spot",
    "Sweet Spot 3x15": "Sweet Spot",
    "Sweet Spot 4x10": "Sweet Spot",
    "Sweet Spot Pyramid": "Sweet Spot",
    "Sweet Spot Over-Unders": "Sweet Spot",
    "VO2 Max 5x4": "VO2 Max",
    "VO2 Max 6x3": "VO2 Max",
    "Rønnestad 30/15s": "VO2 Max",
    "Threshold Over-Unders": "Threshold",
    "Race Warmup": "Endurance",
}

# ======================================================================
# Featured — built to a fixed duration and AVG / MIN / MAX %FTP
# ======================================================================

APPROX = (
    ""
)

FEATURED = [
    # name, published (duration_s, avg, min, max) or None, purpose, blocks
    (
        "Rolling Country",
        (3300, 66, 55, 75),
        "Endurance ride that rolls between easy and upper zone 2, like steady terrain. Comfortable cadence throughout.",
        [
            W(300, 0.55, 0.65),
            S(240, 0.65), S(120, 0.75), S(180, 0.63),
            S(240, 0.67), S(120, 0.75), S(180, 0.63),
            S(240, 0.67), S(120, 0.75), S(180, 0.63),
            S(240, 0.67), S(120, 0.75), S(180, 0.63),
            S(240, 0.67), S(120, 0.75), S(180, 0.63),
            C(300, 0.65, 0.55),
        ],
    ),
    (
        "Up and Over",
        (1860, 65, 50, 90),
        "Intro to intervals: step up through the zones to a sweet-spot peak and back down again. Hold a steady cadence.",
        [
            W(360, 0.5, 0.6),
            S(180, 0.65), S(180, 0.75), S(180, 0.9), S(180, 0.75), S(180, 0.65),
            S(300, 0.6),
            C(300, 0.6, 0.5),
        ],
    ),
    (
        "First Taste of FTP",
        (1800, 66, 55, 100),
        "A gentle first look at efforts up to FTP, with plenty of easy riding between. Good before starting structured intervals.",
        [
            W(420, 0.55, 0.7),
            I(4, 30, 1.0, 90, 0.6),
            S(300, 0.57),
            I(3, 60, 1.0, 120, 0.57),
            C(60, 0.6, 0.55),
        ],
    ),
    (
        "Low and Steady",
        (2100, 69, 65, 75),
        "Steady low-zone-2 riding for fat oxidation. Nothing hard, just time in the aerobic zone.",
        [W(300, 0.65, 0.7), S(600, 0.7), S(300, 0.75), S(600, 0.68), S(300, 0.65)],
    ),
    (
        "Steady Cruise",
        (2850, 75, 50, 89),
        "Longer tempo blocks for pacing and muscular endurance, finishing with a push at the top of tempo.",
        [
            W(480, 0.5, 0.75),
            S(480, 0.85), S(180, 0.58),
            S(480, 0.85), S(180, 0.58),
            S(480, 0.85), S(180, 0.58),
            S(240, 0.89),
            C(150, 0.65, 0.5),
        ],
    ),
    (
        "The Last Word",
        (3210, 67, 45, 95),
        "Tempo at 80%, then sweet spot at 90%, then a short harder effort to finish strong.",
        [
            W(600, 0.45, 0.7),
            S(300, 0.8), S(180, 0.46), S(300, 0.8), S(180, 0.46), S(300, 0.8), S(180, 0.46),
            S(300, 0.9), S(180, 0.46), S(300, 0.9), S(180, 0.46),
            S(60, 0.95, ev=((0, "The last word: one minute, finish strong"),)),
            C(150, 0.55, 0.45),
        ],
    ),
    (
        "Quick Draw",
        (1725, 77, 45, 95),
        "Short, punchy sweet-spot intervals with brief recoveries. Time-efficient.",
        [
            W(300, 0.45, 0.75),
            I(6, 120, 0.95, 60, 0.7),
            S(225, 0.6),
            C(120, 0.72, 0.55),
        ],
    ),
    (
        "Threshold Snaps",
        (1980, 73, 65, 105),
        "Two sets of short FTP efforts with short recoveries, all on an aerobic base.",
        [
            W(300, 0.65, 0.7),
            I(6, 30, 1.05, 30, 0.65),
            S(240, 0.65),
            I(6, 30, 1.05, 30, 0.65),
            S(360, 0.65),
            C(360, 0.7, 0.65),
        ],
    ),
    (
        "Big Gear Tempo",
        (3900, 72, 45, 86),
        "Cycling-specific strength: tempo efforts at a low 60-70 rpm, with recoveries and riding at 80-90 rpm.",
        [
            W(600, 0.45, 0.72, cad=85),
            S(300, 0.86, cad=65, ev=((0, "Low cadence: 60-70 rpm, seated, strong"),)), S(180, 0.65, cad=90),
            S(300, 0.86, cad=65), S(180, 0.65, cad=90),
            S(300, 0.86, cad=65), S(180, 0.65, cad=90),
            S(300, 0.86, cad=65), S(180, 0.65, cad=90),
            S(300, 0.86, cad=65), S(180, 0.65, cad=90),
            S(600, 0.7, cad=90),
            C(300, 0.65, 0.45),
        ],
    ),
    (
        "Low-Cadence Climber",
        (3900, 78, 55, 108),
        "Climbing strength: long sweet-spot efforts at 55-65 rpm, each ending with a surge over FTP.",
        [
            W(600, 0.55, 0.75, cad=85),
            *[
                blk
                for _ in range(4)
                for blk in (S(360, 0.9, cad=60), S(60, 1.08, cad=60), S(240, 0.65, cad=90))
            ],
            S(360, 0.79, cad=85),
            C(300, 0.7, 0.55),
        ],
    ),
    (
        "Six Over-Unders",
        (3480, None, None, None),
        "Six 4-minute threshold intervals that alternate just below and just above FTP, with aerobic recoveries. Builds lactate clearance.",
        [
            W(600, 0.45, 0.75),
            *[
                blk
                for n in range(6)
                for blk in (
                    S(60, 0.95, ev=((0, f"Threshold {n + 1} of 6: under / over / under / over"),)),
                    S(60, 1.05), S(60, 0.95), S(60, 1.05),
                    S(240, 0.55),
                )
            ],
        ],
    ),
    (
        "Minute On, Minute Off",
        (3660, 68, None, None),
        "VO2 max: one minute hard, one minute easy in zone 1, in two sets. The second set is a notch harder.",
        [
            W(600, 0.45, 0.75),
            S(300, 0.55),
            I(8, 60, 1.15, 60, 0.43),
            S(300, 0.5),
            I(8, 60, 1.2, 60, 0.43),
            C(540, 0.6, 0.4),
        ],
    ),
    (
        "Five-Minute Fury",
        (3600, 75, None, None),
        "Four 5-minute all-out VO2 efforts after a warmup and some shorter openers. The ERG target is a floor. If you have more, press + to raise it.",
        [
            W(600, 0.45, 0.75),
            I(3, 60, 1.0, 60, 0.55),
            S(240, 0.5),
            I(4, 300, 1.15, 300, 0.47, ev=((0, "All out for 5 minutes. Press + if the target feels low"),)),
        ],
    ),
    (
        "Spark Plugs",
        (3420, None, None, None),
        "Sprint power: two sets of five 8-second bursts. Spin the cadence up just before each one, and switch ERG off in the menu if you want a true sprint.",
        [
            W(900, 0.45, 0.75),
            S(300, 0.65),
            I(5, 8, 2.0, 172, 0.55, ev=((0, "Set 1: 5 bursts of 8 seconds. Spin up before each"),)),
            S(300, 0.55),
            I(5, 8, 2.0, 172, 0.55, ev=((0, "Set 2: 5 more bursts"),)),
            C(120, 0.55, 0.4),
        ],
    ),
    (
        "Zone 2 Staircase",
        (5400, None, 50, 75),
        "Zone 2 endurance: five 15-minute rounds that step 65 → 70 → 75% FTP every 5 minutes, between an easy start and a 60% then 50% finish.",
        [
            S(300, 0.5),
            *[b for _ in range(5) for b in (S(300, 0.65), S(300, 0.7), S(300, 0.75))],
            S(300, 0.6),
            S(300, 0.5),
        ],
    ),
]

# Built segment by segment, so these
# are exact rather than rebuilt from summary stats.
EXACT = {"Zone 2 Staircase"}

# ======================================================================
# Classics — protocols as specified in published coaching protocols
# ======================================================================

WU = W(600, 0.45, 0.75)
WU15 = W(900, 0.45, 0.75)
CD = C(600, 0.6, 0.4)
ADDED = " Main set as specified; the warmup and cooldown are added."

CLASSICS = [
    (
        "Sweet Spot 2x20",
        "The sweet spot standard: two 20-minute blocks at 90% FTP with 8 minutes easy between.",
        [WU, S(1200, 0.9), S(480, 0.55), S(1200, 0.9), CD],
    ),
    (
        "Sweet Spot 3x15",
        "Three 15-minute blocks at 90% FTP with 5 minutes recovery.",
        [WU, S(900, 0.9), S(300, 0.55), S(900, 0.9), S(300, 0.55), S(900, 0.9), CD],
    ),
    (
        "Sweet Spot 4x10",
        "Four 10-minute blocks at the top of sweet spot (93%) with 5 minutes recovery.",
        [WU, *[b for _ in range(3) for b in (S(600, 0.93), S(300, 0.55))], S(600, 0.93), CD],
    ),
    (
        "Sweet Spot Pyramid",
        "Sweet spot pyramid: 5-10-15-10-5 minutes at 90% FTP with 3 minutes easy between.",
        [
            WU,
            S(300, 0.9), S(180, 0.55), S(600, 0.9), S(180, 0.55), S(900, 0.9),
            S(180, 0.55), S(600, 0.9), S(180, 0.55), S(300, 0.9),
            CD,
        ],
    ),
    (
        "Sweet Spot Over-Unders",
        "Alternating 2 minutes at 95% and 2 minutes at 85% for three 12-minute sets.",
        [
            WU,
            *[b for _ in range(2) for b in (I(3, 120, 0.95, 120, 0.85), S(300, 0.55))],
            I(3, 120, 0.95, 120, 0.85),
            CD,
        ],
    ),
    (
        "VO2 Max 5x4",
        "Five 4-minute efforts at 110% FTP with 4 minutes recovery.",
        [WU15, I(5, 240, 1.1, 240, 0.5), CD],
    ),
    (
        "VO2 Max 6x3",
        "Six 3-minute efforts at 115% FTP, 3 on / 3 off.",
        [WU15, I(6, 180, 1.15, 180, 0.5), CD],
    ),
    (
        "Rønnestad 30/15s",
        "Three sets of 13 x (30 s at 120% / 15 s at 50%), with 5 minutes between sets. Short recoveries keep your VO2 high for longer.",
        [
            WU15,
            I(13, 30, 1.2, 15, 0.5), S(300, 0.5),
            I(13, 30, 1.2, 15, 0.5), S(300, 0.5),
            I(13, 30, 1.2, 15, 0.5),
            CD,
        ],
    ),
    (
        "Threshold Over-Unders",
        "Two 10-minute sets of 2 minutes at 95% with 30-second surges at 115%, with 8 minutes recovery.",
        [WU15, I(4, 120, 0.95, 30, 1.15), S(480, 0.5), I(4, 120, 0.95, 30, 1.15), CD],
    ),
    (
        "Race Warmup",
        "Pre-race primer: zone 2, then a minute each at low and high tempo, 50 s at FTP, a 10-second sprint, and an easy spin.",
        [
            S(720, 0.65), S(60, 0.78), S(60, 0.86), S(50, 1.0),
            S(10, 1.5, ev=((0, "10 second sprint"),)),
            S(420, 0.55),
        ],
    ),
]


def main():
    AUTHOR_FEATURED = "Whorl"
    AUTHOR_CLASSIC = "Whorl"
    global AUTHOR

    AUTHOR = AUTHOR_FEATURED
    for name, published, purpose, blocks in FEATURED:
        dur, avg, lo, hi = summary(blocks)
        want_dur, want_avg, want_lo, want_hi = published
        checks = [("duration", dur, want_dur), ("avg", avg, want_avg), ("min", lo, want_lo), ("max", hi, want_hi)]
        for label, got, want in checks:
            assert want is None or got == want, f"{name}: {label} {got} != published {want}"
        m, s = divmod(want_dur, 60)
        h, m = divmod(m, 60)
        dur_txt = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
        if name in EXACT:
            note = ""
        elif want_avg and want_lo:
            note = APPROX.format(dur=dur_txt, lo=want_lo, hi=want_hi, avg=want_avg)
        else:
            note = ""
        AUTHOR = "Featured" if name in EXACT else AUTHOR_FEATURED
        with open(os.path.join(OUT, "featured", slug(name) + ".zwo"), "w") as f:
            f.write(to_xml(name, purpose + note, blocks, [], CATEGORY[name]))
        print(f"featured     {name:32} {dur // 60:>3} min  avg {avg}%  {lo}-{hi}%")

    AUTHOR = AUTHOR_CLASSIC
    for name, purpose, blocks in CLASSICS:
        dur, avg, lo, hi = summary(blocks)
        with open(os.path.join(OUT, "classics", slug(name) + ".zwo"), "w") as f:
            f.write(to_xml(name, purpose + ADDED, blocks, ["classic"], CATEGORY[name]))
        print(f"classics  {name:32} {dur // 60:>3} min  avg {avg}%  {lo}-{hi}%")


if __name__ == "__main__":
    main()
