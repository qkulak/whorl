# ZWO Ride

A local web app for building `.zwo` workouts and riding them on a smart trainer in ERG mode, with a scrolling workout chart. The chart shows the targets you've ridden and the ones still to come, with your actual power traced over them.

```
Browser (Web Bluetooth) ──FTMS──▶ trainer   (target watts every interval / ramp step)
        │           ◀──────────── power, cadence, speed, HR
        └── /api/workouts ──▶ server.py ──▶ workouts/*.zwo
            /api/rides    ──▶ server.py ──▶ rides/*.json
```

## Run it

```sh
python3 server.py
```

Open http://localhost:8010 in **Chrome or Edge** (Web Bluetooth isn't in Safari/Firefox).

## Ride

1. **Connect** your trainer. Smart trainers that speak FTMS get full ERG control. A power-only device still works, but it can't set resistance. Heart rate is optional. No hardware handy? Click **Simulate trainer**.
2. Set your **FTP**. Every target in a `.zwo` is a % of FTP.
3. Pick a workout and hit **START RIDE**. The clock starts when you start pedaling.

On the ride screen:

| | |
|---|---|
| **− / +** (or `-` / `+` keys) | FTP down/up 5 W. Every target rescales immediately. |
| **space** | pause / resume |
| **→ / ←** | skip to next interval / back to start of this one |
| **MENU** (or `esc`) | ERG on/off, beeps, auto-pause, skip, pause, end ride |

- **Top left:** 3 s power, average, NP, the zone bar, then cadence, HR, speed, and kJ.
- **Top center:** the current target, time left in the interval, how far off target you are, and what's next.
- **Middle:** a rolling 12-minute window of the workout.
- **Bottom:** the whole workout, with your progress through it.

Auto-pause stops the clock after 3 s of zero power and resumes when you pedal. Beeps count down the last 3 s before the target changes. Free-ride blocks (and ERG off) put the trainer in flat-road simulation instead.

Finished rides can be saved to `rides/` as JSON (per-second power, HR, cadence, and target, plus a summary).

## Build

**+ New workout** or **Edit** on any card opens the builder. You can add Warmup / Steady / Intervals / Ramp / Cooldown / Free-ride blocks, then reorder, duplicate, or delete them. Times are `m:ss`, power is % FTP, and the watts at your current FTP show next to each field. **Save** writes the file to `workouts/`, and **Download .zwo** gives you a file you can use in Zwift, TrainerRoad, etc.

To import `.zwo` files, use **Import .zwo** or drag them onto the library. You can also drop files straight into `workouts/`.

## Notes

- A trainer only allows one controlling connection. If it doesn't show up in the picker, close Zwift or anything else connected to it.
- Text events (`<textevent>`) in a `.zwo` show up as on-screen messages at their time offsets.
- The server binds to 127.0.0.1 only.
