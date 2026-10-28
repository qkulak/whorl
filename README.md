# Quinvy

A local web app for building `.zwo` workouts and riding them on a smart trainer in ERG mode, with a scrolling workout chart. The chart shows the targets you've ridden and the ones still to come, with your actual power traced over them.

```
Browser (Web Bluetooth) ──FTMS──▶ trainer   (target watts every interval / ramp step)
        │           ◀──────────── power, cadence, speed, HR
        ├── /api/presets  ──▶ server.py ──▶ presets/<collection>/*.zwo
        ├── /api/workouts ──▶ server.py ──▶ workouts/*.zwo
        ├── /api/rides    ──▶ server.py ──▶ rides/*.json
        └── /api/favorites ─▶ server.py ──▶ favorites.json
```

## Run it

```sh
python3 server.py
```

Open http://localhost:8010 in **Chrome or Edge** (Web Bluetooth isn't in Safari/Firefox).

### Beta password (local)

To put a local server behind one shared password (handy on your home network), put it in `beta-password.txt` next to `server.py` (git ignores that file), or start the server with `QUINVY_PASSWORD='your-password' python3 server.py`. The environment variable wins if both are set. Visitors see "Enter password for beta access", a correct password keeps them signed in for 30 days, and changing the password signs everyone out. With neither set, the app is open. The hosted app uses accounts instead (below).

## Deploy (AWS)

```sh
./deploy.sh
```

This runs the app on AWS Lambda behind a public HTTPS Function URL. The same `server.py` code handles requests there through `lambda_function.py`, and the bundled presets ship inside the function.

**Accounts.** Riders sign up with email and password. Accounts live in an Amazon Cognito user pool (`quinvy`, Lite tier: free up to 10,000 monthly active users). Signing up needs the **invite code**, from `invite-code.txt` (git-ignored) or `QUINVY_INVITE_CODE`; deploying without one is refused. Cognito's pre sign-up trigger checks the code, so it can't be skipped by calling Cognito directly. To change the code, edit the file and re-run `./deploy.sh`; existing accounts aren't affected. Cognito emails a code to confirm each new address, and the same flow handles "Forgot password?". Its built-in email sender allows about 50 emails a day, which is enough for a beta. `accounts.py` makes those calls over plain HTTPS, with no AWS SDK.

**Private data.** Each rider's workouts, uploads, favorites and saved rides are stored only for them, in a private, versioned S3 bucket (`quinvy-data-<account-id>`) under `users/<their id>/`. Deleted or overwritten files can be restored for 30 days. The presets are shared and read-only. **Delete account** in the app header asks for the password again, then removes the account and all of its data.

**Re-running.** The first run creates:
- the bucket
- an IAM role limited to that bucket plus logging
- the function and its URL
- the user pool and its app client

Later runs only push new code and settings. They keep the session secret, so nobody gets signed out, and they never touch riders' data. It uses the `quin` AWS profile and `us-east-1` unless `AWS_PROFILE` / `AWS_REGION` say otherwise. Creating the public URL needs AWS CLI support for `--invoked-via-function-url`; the script says so if yours is too old. On AWS the server refuses to run without sign-in configured: it answers 503 rather than opening up. `storage.py` switches between the local folders and S3, based on whether `QUINVY_BUCKET` is set.

## Ride

1. **Connect** your trainer. Smart trainers that speak FTMS get full ERG control. A power-only device still works, but it can't set resistance. Heart rate is optional. No hardware handy? Click **Simulate trainer**.
2. Set your **FTP**. Every target in a `.zwo` is a % of FTP.
3. Pick a workout from **Browse** or **Favorites** and hit **START RIDE**. The clock starts when you start pedaling.

On the ride screen:

| | |
|---|---|
| **− / +** (or `-` / `+` keys) | FTP down/up 5 W. Every target rescales immediately. |
| **space** | pause / resume |
| **Skip interval ⏭** (or `→`) | jump to the next interval |
| **↺ Restart interval** (or `←`) | back to the start of the current interval |
| **MENU** (or `esc`) | ERG on/off, beeps, auto-pause, skip/restart, pause, end ride |

Skip, restart, and end ride all ask "are you sure?" first (`enter` confirms, `esc` cancels). The destination is locked in when you press the button, so an interval that rolls over while the prompt is open won't turn into a double skip.

- **Top left:** 3 s power, average, NP and heart rate, the zone bar, then cadence, speed, and kJ.
- **Top center:** the current target, time left in the interval, how far off target you are, and what's next.
- **Middle:** a rolling 12-minute window of the workout.
- **Bottom (a third of the screen):** the whole workout, with your progress through it. Each upcoming block shows its target watts and length.

Any change in target cadence pops up mid-screen ("Spin up now · 105 RPM", "Slow cadence now", "New cadence"). Changes of 8 rpm or more get a 5-second countdown first.

Auto-pause stops the clock after 3 s of zero power and resumes when you pedal. Beeps count down the last 3 s before the target changes. Free-ride blocks (and ERG off) put the trainer in flat-road simulation instead.

Finished rides can be saved to `rides/` as JSON (per-second power, HR, cadence, and target, plus a summary).

## Browse

**Browse** lists every workout: the presets plus the ones you build (the **My workouts** collection). You can filter by collection and by type (Recovery → Anaerobic, colored by zone), narrow the **Duration** slider to any range (drag either end, in 5-minute steps; the right end means no upper limit), or search. Click anywhere on a card to open its details: the full chart, the description, and **RIDE IT**. Hover over (or tap) any bar in the chart to see its target watts, % FTP, and timing. For ramps it also shows the exact watts at that point.

| Collection | Folder | What it is |
|---|---|---|
| Originals | `presets/originals/` | Workouts built for Quinvy: Z2 Steady Hour, Z2 Steady Build, Z2 Lifts, Z2 Add-On, Sweet Spot Progression 3x13 and Threshold Build 3x15. |
| Featured | `presets/featured/` | 15 named workouts across every intensity, from Rolling Country to Spark Plugs. Each is built to a fixed duration and min/max/average % FTP. |
| Classics | `presets/classics/` | Standard protocols (2×20 sweet spot, Rønnestad 30/15s, 5×4 VO2…) plus the original samples. |
| Z2 Endurance | `presets/endurance/` | Five original zone 2 rides from 1:15 to 2:00 (cadence builder, floats, ladder, waves, long steady). The generator asserts that every main-set target stays in Z2 (56–75% FTP). |
| Training plan | `presets/plan/` | The bike workouts from `trainingplancalc`. |
| My workouts | `workouts/` | Workouts you build or copy & edit (see **Build**). |
| Uploaded | `presets/uploaded/` | Anything you add with **⇪ Upload .zwo** (or by dragging files onto Browse). |

Tap **☆** on any card (or in Details) to star it. Starred workouts are listed on the **Favorites** tab. Favorites are saved by the server in `favorites.json`, so they're the same in any browser that opens the app.

Any folder you add under `presets/` shows up as its own collection. Categories come from a `<category>` element when the file has one; otherwise they're inferred from time spent at each intensity. `python3 scripts/build_presets.py` regenerates the Featured, Classics and Z2 Endurance files and checks each Featured workout against its target numbers.

Workouts in Featured and Training plan don't carry a collection tag on their cards; the filter chips still find them. Titles leave out the ride's length, since the card already shows it.

Only uploads and your own workouts can be deleted. Bundled presets can't.

## Build

Use **+ New workout** on Browse, or **Copy & edit** on any preset (the preset itself is untouched). Saved workouts go in Browse's **My workouts** collection. The builder lets you add Warmup / Steady / Intervals / Ramp / Cooldown / Free-ride blocks, then reorder, duplicate, or delete them. Times are `m:ss`, power is % FTP, and the watts at your current FTP show next to each field. **Save** writes the file to `workouts/`, and **Download .zwo** gives you a file you can use in Zwift, TrainerRoad, etc.

## Notes

- A trainer only allows one controlling connection. If it doesn't show up in the picker, close Zwift or anything else connected to it.
- Text events (`<textevent>`) in a `.zwo` show up as on-screen messages at their time offsets.
- The server accepts connections from other machines (it binds to 0.0.0.0). Set `QUINVY_HOST=127.0.0.1` to keep it on this computer only. It speaks plain HTTP, so put it behind HTTPS before it's on the internet: Web Bluetooth needs HTTPS, and so does sending the beta password safely.
