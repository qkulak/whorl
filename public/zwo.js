// ZWO — parse / serialize Zwift workout files and expand them into a timeline.
//
// A workout is { name, author, description, blocks[] }. Blocks mirror the ZWO
// elements one-to-one so a file round-trips through the builder unchanged.
// Power is always a fraction of FTP (0.75 = 75%), durations are seconds.
//
//   steady    { duration, power }
//   warmup    { duration, powerLow, powerHigh }   ramps low → high
//   cooldown  { duration, powerLow, powerHigh }   ramps high → low
//   ramp      { duration, powerLow, powerHigh }   ramps low → high (either direction)
//   intervals { repeat, onDuration, offDuration, onPower, offPower }
//   free      { duration }                         no target — trainer in sim mode
//
// Any block may carry cadence and textevents [{ offset, message }].

export const BLOCK_TYPES = {
  warmup: "Warmup",
  steady: "Steady",
  intervals: "Intervals",
  ramp: "Ramp",
  cooldown: "Cooldown",
  free: "Free ride",
};

const num = (el, ...names) => {
  for (const n of names) {
    const v = el.getAttribute(n);
    if (v !== null && v !== "") return Number(v);
  }
  return null;
};

export function parseZwo(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not valid XML");
  const root = doc.querySelector("workout_file");
  if (!root) throw new Error("no <workout_file> element");
  const text = (sel) => root.querySelector(sel)?.textContent.trim() || "";
  const workoutEl = root.querySelector("workout");
  if (!workoutEl) throw new Error("no <workout> element");

  const blocks = [];
  for (const el of workoutEl.children) {
    const tag = el.tagName.toLowerCase();
    const b = {};
    const duration = num(el, "Duration");
    if (tag === "steadystate" || tag === "solidstate") {
      Object.assign(b, { type: "steady", duration, power: num(el, "Power", "PowerLow") ?? 0.5 });
    } else if (tag === "warmup" || tag === "ramp" || tag === "cooldown") {
      let lo = num(el, "PowerLow", "Power") ?? 0.5;
      let hi = num(el, "PowerHigh", "Power") ?? lo;
      Object.assign(b, { type: tag, duration, powerLow: lo, powerHigh: hi });
    } else if (tag === "intervalst") {
      Object.assign(b, {
        type: "intervals",
        repeat: num(el, "Repeat") ?? 1,
        onDuration: num(el, "OnDuration") ?? 60,
        offDuration: num(el, "OffDuration") ?? 60,
        onPower: num(el, "OnPower", "PowerOnHigh", "PowerOnLow") ?? 1,
        offPower: num(el, "OffPower", "PowerOffLow", "PowerOffHigh") ?? 0.5,
      });
      const cr = num(el, "CadenceResting");
      if (cr) b.cadenceResting = cr;
    } else if (tag === "freeride" || tag === "maxeffort") {
      Object.assign(b, { type: "free", duration });
    } else {
      continue; // unknown element — skip rather than fail the whole file
    }
    const cad = num(el, "Cadence");
    if (cad) b.cadence = cad;
    const events = [...el.querySelectorAll("textevent, TextEvent")].map((t) => ({
      offset: num(t, "timeoffset", "TimeOffset") ?? 0,
      message: t.getAttribute("message") || t.getAttribute("Message") || "",
    }));
    if (events.length) b.textevents = events;
    if (b.type !== "intervals" && !(b.duration > 0)) continue;
    blocks.push(b);
  }
  return {
    name: text("name") || "Untitled workout",
    author: text("author"),
    description: text("description"),
    category: text("category"),
    tags: [...root.querySelectorAll("tags > tag")].map((t) => t.getAttribute("name")).filter(Boolean),
    blocks,
  };
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f2 = (x) => String(Math.round(x * 1000) / 1000);

export function serializeZwo(w) {
  const lines = w.blocks.map((b) => {
    let tag, attrs;
    switch (b.type) {
      case "steady":
        tag = "SteadyState";
        attrs = { Duration: b.duration, Power: f2(b.power) };
        break;
      case "warmup":
      case "ramp":
      case "cooldown":
        tag = { warmup: "Warmup", ramp: "Ramp", cooldown: "Cooldown" }[b.type];
        attrs = { Duration: b.duration, PowerLow: f2(b.powerLow), PowerHigh: f2(b.powerHigh) };
        break;
      case "intervals":
        tag = "IntervalsT";
        attrs = {
          Repeat: b.repeat,
          OnDuration: b.onDuration,
          OffDuration: b.offDuration,
          OnPower: f2(b.onPower),
          OffPower: f2(b.offPower),
        };
        if (b.cadenceResting) attrs.CadenceResting = b.cadenceResting;
        break;
      case "free":
        tag = "FreeRide";
        attrs = { Duration: b.duration, FlatRoad: 1 };
        break;
    }
    if (b.cadence) attrs.Cadence = b.cadence;
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
    if (!b.textevents?.length) return `    <${tag} ${a}/>`;
    const ev = b.textevents
      .map((t) => `      <textevent timeoffset="${t.offset}" message="${esc(t.message)}"/>`)
      .join("\n");
    return `    <${tag} ${a}>\n${ev}\n    </${tag}>`;
  });
  return `<workout_file>
    <author>${esc(w.author || "")}</author>
    <name>${esc(w.name || "Untitled workout")}</name>
    <description>${esc(w.description || "")}</description>
${w.category ? `    <category>${esc(w.category)}</category>\n` : ""}    <sportType>bike</sportType>
    ${w.tags?.length ? `<tags>\n${w.tags.map((t) => `        <tag name="${esc(t)}"/>`).join("\n")}\n    </tags>` : "<tags/>"}
    <workout>
${lines.join("\n")}
    </workout>
</workout_file>
`;
}

// Flatten blocks into segments on an absolute timeline:
//   { start, duration, from, to, free, cadence, blockIndex, label }
// Power `from`/`to` are FTP fractions; a steady segment has from === to.
export function expand(w) {
  const segs = [];
  const events = [];
  let t = 0;
  const push = (duration, from, to, extra) => {
    if (!(duration > 0)) return;
    segs.push({ start: t, duration, from, to, free: false, ...extra });
    t += duration;
  };
  w.blocks.forEach((b, i) => {
    const blockStart = t;
    const base = { blockIndex: i, cadence: b.cadence || null };
    switch (b.type) {
      case "steady":
        push(b.duration, b.power, b.power, base);
        break;
      case "warmup":
      case "ramp":
        push(b.duration, b.powerLow, b.powerHigh, base);
        break;
      case "cooldown": {
        // Cooldowns always descend. Files disagree on attribute order, so
        // take the larger value as the start.
        const hi = Math.max(b.powerLow, b.powerHigh);
        const lo = Math.min(b.powerLow, b.powerHigh);
        push(b.duration, hi, lo, base);
        break;
      }
      case "intervals":
        for (let r = 0; r < b.repeat; r++) {
          push(b.onDuration, b.onPower, b.onPower, { ...base, rep: r + 1, reps: b.repeat, on: true });
          push(b.offDuration, b.offPower, b.offPower, {
            ...base,
            cadence: b.cadenceResting || null,
            rep: r + 1,
            reps: b.repeat,
            on: false,
          });
        }
        break;
      case "free":
        push(b.duration, 0.5, 0.5, { ...base, free: true });
        break;
    }
    for (const ev of b.textevents || []) events.push({ t: blockStart + ev.offset, message: ev.message });
  });
  return { segments: segs, events: events.sort((a, b) => a.t - b.t), duration: t };
}

export function segmentAt(timeline, t) {
  const segs = timeline.segments;
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].start + segs[i].duration) return i;
  }
  return -1;
}

// Target as FTP fraction at time t within a segment (null for free ride).
export function fractionAt(seg, t) {
  if (!seg || seg.free) return null;
  const p = Math.min(1, Math.max(0, (t - seg.start) / seg.duration));
  return seg.from + (seg.to - seg.from) * p;
}

// ---------- zones (Coggan, as used by Zwift colouring) ----------

export const ZONES = [
  { max: 0.6, name: "Z1", color: "#8a8f98" },
  { max: 0.76, name: "Z2", color: "#2f8cff" },
  { max: 0.9, name: "Z3", color: "#2fc26b" },
  { max: 1.05, name: "Z4", color: "#f5c518" },
  { max: 1.18, name: "Z5", color: "#ff7a1a" },
  { max: Infinity, name: "Z6", color: "#ff3b3b" },
];

export function zoneFor(fraction) {
  return ZONES.find((z) => fraction < z.max) || ZONES[ZONES.length - 1];
}

// ---------- categories ----------

export const CATEGORIES = ["Recovery", "Endurance", "Tempo", "Sweet Spot", "Threshold", "VO2 Max", "Anaerobic"];

// What a workout trains, judged by how long it spends at each intensity.
// An explicit <category> in the file wins if it names one of ours.
export function categorize(workout, timeline) {
  const named = CATEGORIES.find((c) => c.toLowerCase() === (workout.category || "").toLowerCase());
  if (named) return named;
  const at = (lo, hi = Infinity) => {
    let t = 0;
    for (const s of timeline.segments) {
      if (s.free) continue;
      const f = (s.from + s.to) / 2;
      if (f >= lo && f < hi) t += s.duration;
    }
    return t;
  };
  // Bands overlap the zone edges on purpose: 105% is still threshold work,
  // 95% is still sweet spot.
  const vo2 = at(1.06);
  if (vo2 >= 300) return at(1.3) / vo2 > 0.5 ? "Anaerobic" : "VO2 Max";
  if (at(1.2) >= 30) return "Anaerobic";
  if (at(0.96, 1.06) >= 360) return "Threshold";
  if (at(0.88, 0.96) >= 600) return "Sweet Spot";
  if (at(0.76, 0.88) >= 600) return "Tempo";
  return stats(timeline).IF < 0.6 ? "Recovery" : "Endurance";
}

// ---------- summary numbers ----------

// Normalized-power style intensity from the planned targets (free ride counted
// at 50%), sampled per second — close enough for a library card.
export function stats(timeline) {
  let sum4 = 0;
  let n = 0;
  for (const s of timeline.segments) {
    for (let i = 0; i < s.duration; i++) {
      const f = s.free ? 0.5 : s.from + ((s.to - s.from) * (i + 0.5)) / s.duration;
      sum4 += f ** 4;
      n++;
    }
  }
  const IF = n ? (sum4 / n) ** 0.25 : 0;
  const tss = (timeline.duration * IF * IF * 100) / 3600;
  return { duration: timeline.duration, IF, tss };
}

export function fmtTime(s, { hours = false } = {}) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  if (h || hours) return `${h}:${String(m).padStart(2, "0")}:${sec}`;
  return `${m}:${sec}`;
}

// "5:00", "90", "1:30:00" → seconds
export function parseTime(str) {
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
