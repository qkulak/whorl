# ZWO Ride

A local web app for building `.zwo` workouts and riding them on a smart trainer in ERG mode, with a scrolling workout chart. The chart shows the targets you've ridden and the ones still to come, with your actual power traced over them.

```
Browser (Web Bluetooth) ──FTMS──▶ trainer   (target watts every interval / ramp step)
        │           ◀──────────── power, cadence, speed, HR
        ├── /api/presets  ──▶ server.py ──▶ presets/<collection>/*.zwo
        ├── /api/workouts ──▶ server.py ──▶ workouts/*.zwo
        └── /api/rides    ──▶ server.py ──▶ rides/*.json
```

## Run it

```sh
python3 server.py
```

Open http://localhost:8010 in **Chrome or Edge** (Web Bluetooth isn't in Safari/Firefox).

## Ride

1. **Connect** your trainer. Smart trainers that speak FTMS get full ERG control. A power-only device still works, but it can't set resistance. Heart rate is optional. No hardware handy? Click **Simulate trainer**.
2. Set your **FTP**. Every target in a `.zwo` is a % of FTP.
3. Pick a workout from **Browse** or **My workouts** and hit **START RIDE**. The clock starts when you start pedaling.

On the ride screen:

| | |
|---|---|
| **− / +** (or `-` / `+` keys) | FTP down/up 5 W. Every target rescales immediately. |
| **space** | pause / resume |
| **Skip interval ⏭** (or `→`) | jump to the next interval |
| **↺ Restart interval** (or `←`) | back to the start of the current interval |
| **MENU** (or `esc`) | ERG on/off, beeps, auto-pause, skip/restart, pause, end ride |

Skip, restart, and end ride all ask "are you sure?" first (`enter` confirms, `esc` cancels). The destination is locked in when you press the button, so an interval that rolls over while the prompt is open won't turn into a double skip.

- **Top left:** 3 s power, average, NP, the zone bar, then cadence, HR, speed, and kJ.
- **Top center:** the current target, time left in the interval, how far off target you are, and what's next.
- **Middle:** a rolling 12-minute window of the workout.
- **Bottom:** the whole workout, with your progress through it.

Auto-pause stops the clock after 3 s of zero power and resumes when you pedal. Beeps count down the last 3 s before the target changes. Free-ride blocks (and ERG off) put the trainer in flat-road simulation instead.

Finished rides can be saved to `rides/` as JSON (per-second power, HR, cadence, and target, plus a summary).

## Browse

**Browse** lists every preset workout. You can filter by collection and by type (Recovery → Anaerobic, colored by zone), narrow the **Duration** slider to any range (drag either end, in 5-minute steps; the right end means no upper limit), or search. Click anywhere on a card to open its details: the full chart, the description, and **RIDE IT**. Hover over (or tap) any bar in the chart to see its target watts, % FTP, and timing. For ramps it also shows the exact watts at that point.

| Collection | Folder | What it is |
|---|---|---|
| FEATURED | `presets/featured/` | 14 named workouts, each built to an exact duration and min/max/average % FTP, following any published interval outline. Each description says it's an approximation. |
| Classics | `presets/classics/` | Fully specified protocols from published coaching protocols (2×20 sweet spot, Rønnestad 30/15s, 5×4 VO2…) plus the original samples. |
| Z2 Endurance | `presets/endurance/` | Five original zone 2 rides from 1:15 to 2:00 (cadence builder, floats, ladder, waves, long steady). The generator asserts that every main-set target stays in Z2 (56–75% FTP). |
| Training plan | `presets/plan/` | The bike workouts from `trainingplancalc`, copied as-is. |
| Uploaded | `presets/uploaded/` | Anything you add with **⇪ Upload .zwo** (or by dragging files onto Browse). |

If a workout's description says "Set FTP to 185", Details offers a **Use FTP 185 W** button.

Any folder you add under `presets/` shows up as its own collection. Categories come from a `<category>` element when the file has one; otherwise they're inferred from time spent at each intensity. `python3 scripts/build_presets.py` regenerates the FEATURED, Classics and Z2 Endurance files and checks each FEATURED rebuild against the published numbers.

Only uploads and your own workouts can be deleted. Bundled presets can't.

## Build

**My workouts** holds the workouts you build. Use **+ New workout**, or **Copy & edit** on any preset (the preset itself is untouched). The builder lets you add Warmup / Steady / Intervals / Ramp / Cooldown / Free-ride blocks, then reorder, duplicate, or delete them. Times are `m:ss`, power is % FTP, and the watts at your current FTP show next to each field. **Save** writes the file to `workouts/`, and **Download .zwo** gives you a file you can use in Zwift, TrainerRoad, etc.

## Notes

- A trainer only allows one controlling connection. If it doesn't show up in the picker, close Zwift or anything else connected to it.
- Text events (`<textevent>`) in a `.zwo` show up as on-screen messages at their time offsets.
- The server binds to 127.0.0.1 only.
