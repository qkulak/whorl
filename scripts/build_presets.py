"""Generate the bundled preset workouts in presets/featured, presets/classics
and presets/endurance.

    python3 scripts/build_presets.py

Featured collection
    Named workouts, each built to a fixed duration and average / min / max
    %FTP. The script asserts those numbers, so a tweak that drifts from them
    fails loudly.

Z2 Endurance collection
    Original zone 2 rides from 75 min to 2 h, each with a different structure.
    Main-set targets are asserted to stay inside zone 2.

Classics collection
    Standard training protocols (sweet spot, VO2 max). Each is defined by its
    main set, so warmup and cooldown are added and noted.
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
# Featured — each built to a fixed duration and AVG / MIN / MAX %FTP
# ======================================================================

FEATURED = [
    # name, target (duration_s, avg, min, max) with None for "don't check", purpose, blocks
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

# ======================================================================
# Classics — standard protocols, main set as usually prescribed
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



# ======================================================================
# Z2 Endurance — original zone 2 rides, 75 min to 2 h
# ======================================================================
#
# Every main-set target stays inside zone 2 (56-75% FTP); only the warmup
# and cooldown may dip to 50%. Variety comes from structure and cadence, not
# from leaving the zone.

Z2_LO, Z2_HI, EASY = 0.56, 0.75, 0.5


def cadence_round(n):
    return (
        S(480, 0.68, cad=88, ev=((0, f"Round {n} of 5: settle at 85-90 rpm"),)),
        S(120, 0.68, cad=100, ev=((0, "Spin up: 100+ rpm, same watts, smooth hips"),)),
        S(120, 0.7, cad=70, ev=((0, "Torque: drop to ~70 rpm, seated, push through the whole stroke"),)),
    )


ENDURANCE = [
    (
        "Z2 Cadence Builder",
        "75 minutes of steady zone 2 where the power hardly moves but the cadence does. Each round is 8 min cruising at 85-90 rpm, 2 min spinning at 100+ and 2 min grinding at ~70. It's good for pedaling efficiency and keeps the time moving.",
        [
            W(600, 0.5, 0.65, cad=85, ev=((10, "Easy start. Five cadence rounds after this"),)),
            *[b for n in range(1, 6) for b in cadence_round(n)],
            C(300, 0.62, 0.5, cad=85),
        ],
    ),
    (
        "Z2 Floats",
        "Floating between the top and bottom of zone 2: 4 min at 74%, then 4 min at 60%, seven times. The easy halves aren't recovery. They're still aerobic work, just lighter.",
        [
            W(600, 0.5, 0.65),
            *[
                b
                for n in range(1, 8)
                for b in (
                    S(240, 0.74, ev=((0, f"Float {n} of 7: top of Z2, steady breathing, could still talk"),)),
                    S(240, 0.6),
                )
            ],
            S(360, 0.66, ev=((0, "Middle of Z2 to finish the main set"),)),
            C(480, 0.62, 0.5),
        ],
    ),
    (
        "Z2 Ladder",
        "A 70-minute ladder through zone 2: 10-minute steps climb 62 → 66 → 70 → 74%, then come back down. Each step is small enough that the top still feels controlled.",
        [
            W(600, 0.5, 0.62),
            S(600, 0.62, ev=((0, "Ladder up: 4 steps, 10 min each"),)),
            S(600, 0.66),
            S(600, 0.7),
            S(600, 0.74, ev=((0, "Top step: upper Z2. Smooth, not straining"),)),
            S(600, 0.7, ev=((0, "Halfway. Back down the ladder"),)),
            S(600, 0.66),
            S(600, 0.62),
            C(600, 0.6, 0.5),
        ],
    ),
    (
        "Z2 Waves",
        "Long, gentle rollers: power ramps from 60% up to 74% over 6 minutes and back down over 6, six times, with 3 easy-Z2 minutes between. It rides like rolling terrain without ever leaving zone 2.",
        [
            W(600, 0.5, 0.62),
            *[
                b
                for n in range(1, 7)
                for b in (
                    R(360, 0.6, 0.74, ev=((0, f"Wave {n} of 6: climb gradually"),)),
                    R(360, 0.74, 0.6),
                    S(180, 0.64),
                )
            ],
            C(300, 0.6, 0.5),
        ],
    ),
    (
        "Z2 Long Steady",
        "Two hours of classic long-ride zone 2: three 25-minute blocks that progress 68 → 70 → 72%, with 5 easy minutes between to stand, stretch and eat. Fueling cues every 20 minutes. Aim for 60-90 g of carbs an hour.",
        [
            W(1200, 0.5, 0.66, ev=((10, "2 hours of Z2. Bottles and food within reach?"),)),
            S(1500, 0.68, ev=((0, "Block 1 of 3: 68%. Settle in"), (600, "Fuel: drink + 20-30 g carbs"), (1200, "Fuel again"))),
            S(300, 0.6, ev=((0, "Easy 5: stand for 30 s, stretch, eat"),)),
            S(1500, 0.7, ev=((0, "Block 2 of 3: 70%"), (300, "Fuel: drink + carbs"), (1500 - 300, "Fuel"))),
            S(300, 0.6, ev=((0, "Easy 5: stand, stretch, eat"),)),
            S(1500, 0.72, ev=((0, "Block 3 of 3: 72%. Stay smooth as fatigue builds"), (600, "Fuel"), (1200, "Last fuel. Finish strong but in control"))),
            C(900, 0.64, 0.5),
        ],
    ),
]


def check_z2(name, blocks):
    """Main-set targets must sit in Z2; warmup/cooldown may go down to EASY."""
    for b in blocks:
        kind = b[0]
        if kind == "IntervalsT":
            powers = (b[3], b[5])
            floor = Z2_LO
        else:
            powers = (b[2], b[3])
            floor = EASY if kind in ("Warmup", "Cooldown") else Z2_LO
        for p in powers:
            assert floor <= p <= Z2_HI, f"{name}: {kind} at {p:.0%} is outside Z2"


def main():
    global AUTHOR
    AUTHOR = "Whorl"

    os.makedirs(os.path.join(OUT, "featured"), exist_ok=True)
    for name, target, purpose, blocks in FEATURED:
        dur, avg, lo, hi = summary(blocks)
        want_dur, want_avg, want_lo, want_hi = target
        checks = [("duration", dur, want_dur), ("avg", avg, want_avg), ("min", lo, want_lo), ("max", hi, want_hi)]
        for label, got, want in checks:
            assert want is None or got == want, f"{name}: {label} {got} != target {want}"
        with open(os.path.join(OUT, "featured", slug(name) + ".zwo"), "w") as f:
            f.write(to_xml(name, purpose, blocks, [], CATEGORY[name]))
        print(f"featured  {name:32} {dur // 60:>3} min  avg {avg}%  {lo}-{hi}%")

    for name, purpose, blocks in CLASSICS:
        dur, avg, lo, hi = summary(blocks)
        with open(os.path.join(OUT, "classics", slug(name) + ".zwo"), "w") as f:
            f.write(to_xml(name, purpose + ADDED, blocks, ["classic"], CATEGORY[name]))
        print(f"classics  {name:32} {dur // 60:>3} min  avg {avg}%  {lo}-{hi}%")

    os.makedirs(os.path.join(OUT, "endurance"), exist_ok=True)
    lengths = {"Z2 Cadence Builder": 75, "Z2 Floats": 80, "Z2 Ladder": 90, "Z2 Waves": 105, "Z2 Long Steady": 120}
    for name, purpose, blocks in ENDURANCE:
        check_z2(name, blocks)
        dur, avg, lo, hi = summary(blocks)
        assert dur == lengths[name] * 60, f"{name}: {dur / 60:g} min, expected {lengths[name]}"
        with open(os.path.join(OUT, "endurance", slug(name) + ".zwo"), "w") as f:
            f.write(to_xml(name, purpose, blocks, ["endurance", "z2"], "Endurance"))
        print(f"endurance {name:32} {dur // 60:>3} min  avg {avg}%  {lo}-{hi}%")


if __name__ == "__main__":
    main()
