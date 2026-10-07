// ZWO RIDE — library, builder, and the ride screen.

import {
  BLOCK_TYPES,
  CATEGORIES,
  ZONES,
  categorize,
  parseZwo,
  serializeZwo,
  expand,
  segmentAt,
  fractionAt,
  zoneFor,
  stats,
  fmtTime,
  parseTime,
} from "./zwo.js";
import { drawWorkout } from "./chart.js";
import { Trainer, connectHeartRate } from "./trainer.js";

const $ = (id) => document.getElementById(id);
const FTP_STEP = 5;
const STALE_MS = 3000; // a reading older than this counts as "no data"
const AUTO_PAUSE_S = 3;
const TICK_MS = 250;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`zworide.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`zworide.${k}`, JSON.stringify(v));
    } catch {
      /* private mode — prefs just won't stick */
    }
  },
};

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  requestAnimationFrame(() => {
    if (view === "home") drawLibraryCharts();
    if (view === "builder") renderPreview();
  });
}

const ftpInput = $("ftp");
ftpInput.value = store.get("ftp", 200);
ftpInput.addEventListener("change", () => {
  const v = Math.round(Number(ftpInput.value));
  if (v >= 50 && v <= 600) store.set("ftp", v);
  else ftpInput.value = store.get("ftp", 200);
  drawLibraryCharts();
});
const homeFtp = () => Number(ftpInput.value) || 200;

$("setErg").checked = store.get("erg", true);
$("setBeep").checked = store.get("beep", true);
$("setErg").addEventListener("change", (e) => store.set("erg", e.target.checked));
$("setBeep").addEventListener("change", (e) => store.set("beep", e.target.checked));

// ======================================================================
// Sensors
// ======================================================================

const trainer = new Trainer();
const live = { power: null, cadence: null, speed: null, hr: null, strapHr: null, at: 0, hrAt: 0, powerLog: [] };
let hrStrapConnected = false;

trainer.addEventListener("data", ({ detail: d }) => {
  const now = Date.now();
  if (d.power !== undefined) {
    live.power = d.power;
    live.at = now;
    live.powerLog.push({ t: now, w: d.power });
    while (live.powerLog.length && live.powerLog[0].t < now - 3000) live.powerLog.shift();
  }
  if (d.cadence !== undefined) live.cadence = d.cadence;
  if (d.speed !== undefined) live.speed = d.speed;
  if (d.hr !== undefined && !hrStrapConnected) {
    live.hr = d.hr;
    live.hrAt = now;
  }
});

trainer.addEventListener("status", ({ detail }) => {
  $("trDot").classList.toggle("on", detail.connected);
  $("trName").textContent = detail.connected ? detail.name : "Disconnected";
  $("trSub").textContent = detail.connected
    ? detail.canControl
      ? "ERG control ready"
      : "power only — no ERG control"
    : "FTMS smart trainer or power meter";
  $("btnTrainer").textContent = detail.connected ? "Reconnect" : "Connect";
  $("btnSim").disabled = detail.connected;
  renderErgState();
});
trainer.addEventListener("error", ({ detail }) => toast(`Trainer: ${detail.message}`));

function needBluetooth() {
  if (navigator.bluetooth) return true;
  alert("Web Bluetooth isn't available in this browser — use Chrome or Edge.");
  return false;
}

$("btnTrainer").addEventListener("click", async () => {
  if (!needBluetooth()) return;
  $("trSub").textContent = "connecting…";
  try {
    await trainer.connect();
  } catch (e) {
    $("trSub").textContent = e.name === "NotFoundError" ? "FTMS smart trainer or power meter" : `error: ${e.message}`;
  }
});

$("btnHr").addEventListener("click", async () => {
  if (!needBluetooth()) return;
  try {
    const name = await connectHeartRate(
      (bpm) => {
        live.hr = bpm;
        live.hrAt = Date.now();
      },
      () => {
        hrStrapConnected = false;
        $("hrDot").classList.remove("on");
        $("hrName").textContent = "Disconnected";
      },
    );
    hrStrapConnected = true;
    $("hrDot").classList.add("on");
    $("hrName").textContent = name;
  } catch (e) {
    if (e.name !== "NotFoundError") $("hrName").textContent = `error: ${e.message}`;
  }
});

$("btnSim").addEventListener("click", () => {
  trainer.simulate();
  $("btnSim").disabled = true;
});

function currentPower() {
  if (Date.now() - live.at > STALE_MS) return null;
  return live.power;
}
function power3s() {
  if (currentPower() === null || !live.powerLog.length) return null;
  return Math.round(live.powerLog.reduce((a, s) => a + s.w, 0) / live.powerLog.length);
}
function currentHr() {
  return Date.now() - live.hrAt > 5000 ? null : live.hr;
}

// ======================================================================
// Library — "Browse" (presets/<collection>/) and "My workouts" (workouts/)
// ======================================================================

const COLLECTION_LABELS = {
  mine: "My workouts",
  featured: "Featured",
  classics: "Classics",
  endurance: "Z2 Endurance",
  plan: "Training plan",
  uploaded: "Uploaded",
};
const collectionLabel = (c) => COLLECTION_LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1);

let library = []; // { key, id, collection, workout, timeline, stats, category }
let selectedKey = store.get("selectedKey", null);
const browse = { collection: "all", category: "all", length: "any", q: "" };
let homeTab = store.get("homeTab", "browse");

function toItem(r, collection) {
  const workout = parseZwo(r.xml);
  const timeline = expand(workout);
  return {
    key: `${collection}:${r.id}`,
    id: r.id,
    collection,
    workout,
    timeline,
    stats: stats(timeline),
    category: categorize(workout, timeline),
  };
}

async function loadLibrary() {
  const [mine, presets] = await Promise.all(
    ["/api/workouts", "/api/presets"].map((u) =>
      fetch(u)
        .then((r) => r.json())
        .catch((e) => {
          console.warn(`${u} failed`, e);
          return [];
        }),
    ),
  );
  library = [];
  for (const [r, collection] of [...mine.map((r) => [r, "mine"]), ...presets.map((r) => [r, r.collection])]) {
    try {
      library.push(toItem(r, collection));
    } catch (e) {
      console.warn(`skipping ${r.id}: ${e.message}`);
    }
  }
  library.sort((a, b) => a.workout.name.localeCompare(b.workout.name));
  if (!library.some((w) => w.key === selectedKey)) selectedKey = null;
  renderBrowseFilters();
  renderHome();
}

// ---- tabs ----

function setHomeTab(tab) {
  homeTab = tab;
  store.set("homeTab", tab);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
  $("browsePane").hidden = tab !== "browse";
  $("minePane").hidden = tab !== "mine";
  renderHome();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setHomeTab(t.dataset.tab)));

function renderHome() {
  const presets = library.filter((w) => w.collection !== "mine");
  const mine = library.filter((w) => w.collection === "mine");
  $("tabBrowseCount").textContent = presets.length;
  $("tabMineCount").textContent = mine.length;
  if (homeTab === "browse") {
    const shown = presets.filter(matchesBrowse);
    $("browseCount").textContent = `${shown.length} of ${presets.length} workouts`;
    renderCards($("browseGrid"), shown, "No workouts match these filters.");
  } else {
    renderCards($("mineGrid"), mine, "Nothing here yet. Build one, or copy a workout from Browse to edit it.");
  }
  updateStartBar();
}

// ---- browse filters ----

const LENGTHS = {
  any: ["Any length", () => true],
  short: ["Under 45 min", (s) => s < 45 * 60],
  mid: ["45–75 min", (s) => s >= 45 * 60 && s <= 75 * 60],
  long: ["Over 75 min", (s) => s > 75 * 60],
};

function matchesBrowse(w) {
  if (browse.collection !== "all" && w.collection !== browse.collection) return false;
  if (browse.category !== "all" && w.category !== browse.category) return false;
  if (!LENGTHS[browse.length][1](w.stats.duration)) return false;
  if (browse.q) {
    const hay = `${w.workout.name} ${w.workout.description} ${w.workout.tags.join(" ")}`.toLowerCase();
    if (!browse.q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function chips(el, options, current, onPick) {
  el.innerHTML = "";
  for (const [value, label, count] of options) {
    const b = document.createElement("button");
    b.className = "chip" + (value === current ? " on" : "");
    b.innerHTML = `${label}${count !== undefined ? ` <span>${count}</span>` : ""}`;
    b.addEventListener("click", () => onPick(value));
    el.appendChild(b);
  }
}

function renderBrowseFilters() {
  const presets = library.filter((w) => w.collection !== "mine");
  const collections = [...new Set(presets.map((w) => w.collection))].sort(
    (a, b) => Object.keys(COLLECTION_LABELS).indexOf(a) - Object.keys(COLLECTION_LABELS).indexOf(b),
  );
  if (browse.collection !== "all" && !collections.includes(browse.collection)) browse.collection = "all";
  chips(
    $("fCollection"),
    [["all", "All", presets.length], ...collections.map((c) => [c, collectionLabel(c), presets.filter((w) => w.collection === c).length])],
    browse.collection,
    (v) => {
      browse.collection = v;
      renderBrowseFilters();
      renderHome();
    },
  );
  const cats = CATEGORIES.filter((c) => presets.some((w) => w.category === c));
  chips(
    $("fCategory"),
    [["all", "All types"], ...cats.map((c) => [c, `<i class="cat-dot" style="background:${CATEGORY_COLORS[c]}"></i>${c}`])],
    browse.category,
    (v) => {
      browse.category = v;
      renderBrowseFilters();
      renderHome();
    },
  );
  chips(
    $("fLength"),
    Object.entries(LENGTHS).map(([k, [label]]) => [k, label]),
    browse.length,
    (v) => {
      browse.length = v;
      renderBrowseFilters();
      renderHome();
    },
  );
}

$("fSearch").addEventListener("input", (e) => {
  browse.q = e.target.value.trim().toLowerCase();
  renderHome();
});

// A category's colour is the zone it lives in, so the chips match the charts.
const CATEGORY_COLORS = {
  Recovery: ZONES[0].color,
  Endurance: ZONES[1].color,
  Tempo: ZONES[2].color,
  "Sweet Spot": "#c9d62a",
  Threshold: ZONES[3].color,
  "VO2 Max": ZONES[4].color,
  Anaerobic: ZONES[5].color,
};

// ---- cards ----

function renderCards(el, items, emptyText) {
  el.innerHTML = "";
  if (!items.length) el.innerHTML = `<div class="empty"></div>`;
  if (!items.length) el.firstChild.textContent = emptyText;
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "wo" + (item.key === selectedKey ? " sel" : "");
    card.dataset.key = item.key;
    const s = item.stats;
    const isMine = item.collection === "mine";
    const canDelete = isMine || item.collection === "uploaded";
    card.innerHTML = `
      <div class="wo-badges">
        <span class="badge cat" style="--c:${CATEGORY_COLORS[item.category]}">${item.category}</span>
        ${isMine ? "" : `<span class="badge">${collectionLabel(item.collection)}</span>`}
      </div>
      <div class="wo-title"></div>
      <div class="wo-meta"><span><b>${fmtTime(s.duration)}</b></span><span>TSS <b>${Math.round(s.tss)}</b></span><span>IF <b>${s.IF.toFixed(2)}</b></span></div>
      <canvas></canvas>
      <div class="wo-desc"></div>
      <div class="wo-actions">
        <button class="btn small" data-act="edit">${isMine ? "Edit" : "Copy & edit"}</button>
        ${canDelete ? `<button class="btn small ghost danger" data-act="delete" style="margin-left:auto">Delete</button>` : ""}
      </div>`;
    card.querySelector(".wo-title").textContent = item.workout.name;
    card.querySelector(".wo-desc").textContent = item.workout.description;
    // Anywhere on the card opens its details; only the card's own buttons do something else.
    card.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) return cardAction(item, act);
      selectWorkout(item.key);
      openDetails(item);
    });
    el.appendChild(card);
  }
  requestAnimationFrame(drawLibraryCharts);
}

function cardAction(item, act) {
  if (act === "edit") return openBuilder(item);
  if (act === "download") return downloadZwo(item.workout);
  if (act === "delete") return deleteWorkout(item);
  if (act === "ride") {
    selectWorkout(item.key);
    closeDetails();
    return startRide();
  }
}

function drawLibraryCharts() {
  document.querySelectorAll(".home-grid .wo").forEach((card) => {
    const item = library.find((w) => w.key === card.dataset.key);
    if (item) drawWorkout(card.querySelector("canvas"), { timeline: item.timeline, ftp: homeFtp() });
  });
}

function selectWorkout(key) {
  selectedKey = key;
  store.set("selectedKey", key);
  document.querySelectorAll(".home-grid .wo").forEach((c) => c.classList.toggle("sel", c.dataset.key === key));
  updateStartBar();
}

function selectedItem() {
  return library.find((w) => w.key === selectedKey) || null;
}

function updateStartBar() {
  const item = selectedItem();
  $("selName").textContent = item ? `${item.workout.name} · ${fmtTime(item.stats.duration)}` : "Pick a workout";
  $("btnStart").disabled = !item;
}

// ---- details modal ----

let detailsItem = null;

function openDetails(item) {
  detailsItem = item;
  const w = item.workout;
  const s = item.stats;
  $("dTitle").textContent = w.name;
  $("dBadges").innerHTML = `<span class="badge cat" style="--c:${CATEGORY_COLORS[item.category]}">${item.category}</span><span class="badge">${collectionLabel(item.collection)}</span>`;
  $("dMeta").innerHTML = `<span>Duration <b>${fmtTime(s.duration)}</b></span><span>TSS <b>${Math.round(s.tss)}</b></span><span>IF <b>${s.IF.toFixed(2)}</b></span><span>Author <b class="plain"></b></span>`;
  $("dMeta").querySelector(".plain").textContent = w.author || "—";
  $("dDesc").textContent = w.description || "No description.";
  // Coached files often say "Set FTP to 185" — offer to apply it.
  const wanted = Number(/set ftp to (\d{2,3})/i.exec(w.description)?.[1]);
  $("dFtp").hidden = !wanted || wanted === homeFtp();
  $("dFtp").textContent = `Use FTP ${wanted} W`;
  $("dFtp").dataset.ftp = wanted || "";
  $("dEdit").textContent = item.collection === "mine" ? "Edit" : "Copy & edit";
  $("dDelete").hidden = !(item.collection === "mine" || item.collection === "uploaded");
  $("details").classList.add("show");
  hideTip();
  requestAnimationFrame(() => drawDetails());
}

function closeDetails() {
  $("details").classList.remove("show");
  detailsItem = null;
}

// ---- details chart: hover a bar to see its watts ----

let detailsGeom = null;
let hoverSeg = null;

function drawDetails() {
  if (!detailsItem) return;
  detailsGeom = drawWorkout($("dChart"), {
    timeline: detailsItem.timeline,
    ftp: homeFtp(),
    labels: true,
    hover: hoverSeg,
  });
}

function hideTip() {
  $("dTip").classList.remove("show");
  if (hoverSeg !== null) {
    hoverSeg = null;
    drawDetails();
  }
}

function segmentLabel(seg) {
  if (seg.free) return "Free ride";
  if (seg.rep) return `${seg.on ? "Interval" : "Recovery"} ${seg.rep}/${seg.reps}`;
  if (seg.from !== seg.to) return seg.to > seg.from ? "Ramp up" : "Ramp down";
  return "Steady";
}

function showTip(e) {
  if (!detailsItem || !detailsGeom) return;
  const canvas = $("dChart");
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const t = detailsGeom.timeAt(px);
  const i = segmentAt(detailsItem.timeline, t);
  if (t < 0 || i < 0) return hideTip();
  if (i !== hoverSeg) {
    hoverSeg = i;
    drawDetails();
  }

  const seg = detailsItem.timeline.segments[i];
  const ftp = homeFtp();
  const w = (f) => Math.round(f * ftp);
  const pct = (f) => Math.round(f * 100);
  let watts;
  let sub;
  if (seg.free) {
    watts = "No target";
    sub = "ERG off, ride by feel";
  } else if (seg.from === seg.to) {
    watts = `${w(seg.from)} W`;
    sub = `${pct(seg.from)}% FTP`;
  } else {
    // Ramps: the range, plus the exact target where the pointer is.
    watts = `${w(seg.from)} → ${w(seg.to)} W`;
    sub = `${w(fractionAt(seg, t))} W here · ${pct(seg.from)}–${pct(seg.to)}% FTP`;
  }
  const color = seg.free ? "#8a8f98" : zoneFor(fractionAt(seg, t)).color;
  const tip = $("dTip");
  tip.innerHTML = `
    <div class="tip-head"><i style="background:${color}"></i>${segmentLabel(seg)}${seg.cadence ? ` · ${seg.cadence} rpm` : ""}</div>
    <div class="tip-w">${watts}</div>
    <div class="tip-sub">${sub}</div>
    <div class="tip-sub">${fmtTime(seg.duration)} · ${fmtTime(seg.start)}–${fmtTime(seg.start + seg.duration)}</div>`;
  tip.classList.add("show");

  // Sit just above the bar's top edge, centred on the pointer, kept inside the chart.
  const top = detailsGeom.yAt(seg.free ? 0.5 : Math.max(seg.from, seg.to));
  const left = Math.min(Math.max(px, tip.offsetWidth / 2 + 4), rect.width - tip.offsetWidth / 2 - 4);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(top - 10, tip.offsetHeight + 4)}px`;
}

$("dChart").addEventListener("pointermove", showTip);
$("dChart").addEventListener("pointerdown", showTip);
$("dChart").addEventListener("pointerleave", hideTip);

$("dClose").addEventListener("click", closeDetails);
$("dFtp").addEventListener("click", () => {
  ftpInput.value = $("dFtp").dataset.ftp;
  ftpInput.dispatchEvent(new Event("change"));
  $("dFtp").hidden = true;
  drawDetails();
});
$("details").addEventListener("click", (e) => {
  if (e.target === $("details")) closeDetails();
});
for (const [id, act] of [
  ["dRide", "ride"],
  ["dEdit", "edit"],
  ["dDownload", "download"],
  ["dDelete", "delete"],
]) {
  $(id).addEventListener("click", () => {
    const item = detailsItem;
    if (act !== "download" && act !== "ride") closeDetails();
    cardAction(item, act);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailsItem) closeDetails();
});

// ---- file operations ----

async function deleteWorkout(item) {
  const where = item.collection === "mine" ? "My workouts" : "the uploaded library";
  if (!confirm(`Delete "${item.workout.name}" from ${where}?`)) return;
  const url = item.collection === "mine" ? `/api/workouts/${encodeURIComponent(item.id)}` : `/api/presets/${item.id}`;
  await fetch(url, { method: "DELETE" });
  await loadLibrary();
}

function slug(name) {
  return (name || "workout").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "workout";
}

function downloadZwo(workout) {
  const blob = new Blob([serializeZwo(workout)], { type: "application/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(workout.name)}.zwo`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Uploads land in Browse (presets/uploaded/); imports on My workouts land in workouts/.
async function uploadFiles(files, target) {
  let ok = 0;
  let lastKey = null;
  const failed = [];
  for (const file of files) {
    const xml = await file.text();
    try {
      parseZwo(xml); // validate before it lands in the folder
      const res = await fetch(target === "browse" ? "/api/presets" : "/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          target === "browse" ? { filename: file.name, xml } : { name: file.name.replace(/\.(zwo|xml)$/i, ""), xml },
        ),
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error);
      lastKey = target === "browse" ? `uploaded:${out.id}` : `mine:${out.id}`;
      ok++;
    } catch (e) {
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  if (failed.length) alert(`Couldn't add:\n${failed.join("\n")}`);
  if (!ok) return;
  if (target === "browse") {
    browse.collection = "uploaded";
    browse.category = "all";
  }
  await loadLibrary();
  if (ok === 1) selectWorkout(lastKey);
}

for (const [inputId, target] of [
  ["uploadFile", "browse"],
  ["importFile", "mine"],
]) {
  $(inputId).addEventListener("change", (e) => {
    uploadFiles([...e.target.files], target);
    e.target.value = "";
  });
}
$("home").addEventListener("dragover", (e) => {
  e.preventDefault();
  $("home").classList.add("dropping");
});
$("home").addEventListener("dragleave", (e) => {
  if (!$("home").contains(e.relatedTarget)) $("home").classList.remove("dropping");
});
$("home").addEventListener("drop", (e) => {
  e.preventDefault();
  $("home").classList.remove("dropping");
  uploadFiles(
    [...e.dataTransfer.files].filter((f) => /\.(zwo|xml)$/i.test(f.name)),
    homeTab === "browse" ? "browse" : "mine",
  );
});

$("btnNew").addEventListener("click", () => openBuilder(null));
$("btnStart").addEventListener("click", startRide);
setHomeTab(homeTab);

// ======================================================================
// Builder
// ======================================================================

const DEFAULT_BLOCKS = {
  warmup: { duration: 600, powerLow: 0.4, powerHigh: 0.75 },
  steady: { duration: 300, power: 0.75 },
  intervals: { repeat: 5, onDuration: 60, offDuration: 60, onPower: 1.1, offPower: 0.55 },
  ramp: { duration: 300, powerLow: 0.6, powerHigh: 0.9 },
  cooldown: { duration: 300, powerLow: 0.7, powerHigh: 0.4 },
  free: { duration: 600 },
};

const builder = { id: null, workout: null, selected: null };

function openBuilder(item) {
  // Editing a preset edits a copy — saving puts it in My workouts, the preset stays as it was.
  builder.id = item?.collection === "mine" ? item.id : null;
  builder.workout = item
    ? structuredClone(item.workout)
    : { name: "", author: "", description: "", tags: [], blocks: [{ type: "warmup", ...DEFAULT_BLOCKS.warmup }] };
  builder.selected = null;
  $("bName").value = builder.workout.name;
  $("bDesc").value = builder.workout.description;
  renderBlocks();
  show("builder");
}

$("bName").addEventListener("input", (e) => (builder.workout.name = e.target.value));
$("bDesc").addEventListener("input", (e) => (builder.workout.description = e.target.value));
$("bBack").addEventListener("click", () => show("home"));

document.querySelectorAll("[data-add]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const type = btn.dataset.add;
    const blocks = builder.workout.blocks;
    // New blocks go after the selected one, or at the end — cooldowns always at the end.
    const at = builder.selected !== null && type !== "cooldown" ? builder.selected + 1 : blocks.length;
    blocks.splice(at, 0, { type, ...structuredClone(DEFAULT_BLOCKS[type]) });
    builder.selected = at;
    renderBlocks();
  }),
);

const pct = (f) => Math.round(f * 100);

// Field specs per block type: [key, label, kind]
const FIELDS = {
  steady: [["duration", "Time", "time"], ["power", "Power", "pct"]],
  warmup: [["duration", "Time", "time"], ["powerLow", "From", "pct"], ["powerHigh", "To", "pct"]],
  ramp: [["duration", "Time", "time"], ["powerLow", "From", "pct"], ["powerHigh", "To", "pct"]],
  cooldown: [["duration", "Time", "time"], ["powerLow", "From", "pct"], ["powerHigh", "To", "pct"]],
  intervals: [
    ["repeat", "Reps", "int"],
    ["onDuration", "On", "time"],
    ["onPower", "@", "pct"],
    ["offDuration", "Off", "time"],
    ["offPower", "@", "pct"],
  ],
  free: [["duration", "Time", "time"]],
};

function blockColor(b) {
  if (b.type === "free") return "#8a8f98";
  const peak = b.type === "intervals" ? b.onPower : b.type === "steady" ? b.power : Math.max(b.powerLow, b.powerHigh);
  return zoneFor(peak).color;
}

function renderBlocks() {
  const el = $("blocks");
  el.innerHTML = "";
  builder.workout.blocks.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "block" + (i === builder.selected ? " sel" : "");
    row.style.borderLeftColor = blockColor(b);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = BLOCK_TYPES[b.type];
    row.appendChild(kind);

    for (const [key, label, type] of FIELDS[b.type]) {
      const lab = document.createElement("label");
      lab.append(label + " ");
      const input = document.createElement("input");
      input.value = type === "time" ? fmtTime(b[key]) : type === "pct" ? pct(b[key]) : b[key];
      if (type === "pct") input.className = "pct";
      lab.appendChild(input);
      if (type === "pct") {
        lab.append("%");
        const w = document.createElement("span");
        w.className = "watts";
        w.textContent = `${Math.round(b[key] * homeFtp())}W`;
        lab.appendChild(w);
        input.addEventListener("input", () => {
          const v = Number(input.value);
          if (v > 0 && v < 400) {
            b[key] = v / 100;
            w.textContent = `${Math.round(b[key] * homeFtp())}W`;
            row.style.borderLeftColor = blockColor(b);
            renderPreview();
          }
        });
      } else {
        input.addEventListener("input", () => {
          const v = type === "time" ? parseTime(input.value) : Math.round(Number(input.value));
          if (v > 0) {
            b[key] = v;
            renderPreview();
          }
        });
        // normalise "90" → "1:30" once the rider leaves the field
        if (type === "time") input.addEventListener("blur", () => (input.value = fmtTime(b[key])));
      }
      input.addEventListener("focus", () => selectBlock(i));
      row.appendChild(lab);
    }

    const tools = document.createElement("div");
    tools.className = "tools";
    for (const [act, txt, title] of [
      ["up", "↑", "Move up"],
      ["down", "↓", "Move down"],
      ["dup", "⧉", "Duplicate"],
      ["del", "✕", "Remove"],
    ]) {
      const btn = document.createElement("button");
      btn.textContent = txt;
      btn.title = title;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        blockAction(i, act);
      });
      tools.appendChild(btn);
    }
    row.appendChild(tools);
    row.addEventListener("click", () => selectBlock(i));
    el.appendChild(row);
  });
  renderPreview();
}

function selectBlock(i) {
  if (builder.selected === i) return;
  builder.selected = i;
  document.querySelectorAll("#blocks .block").forEach((r, j) => r.classList.toggle("sel", j === i));
  renderPreview();
}

function blockAction(i, act) {
  const blocks = builder.workout.blocks;
  if (act === "up" && i > 0) {
    [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
    builder.selected = i - 1;
  } else if (act === "down" && i < blocks.length - 1) {
    [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
    builder.selected = i + 1;
  } else if (act === "dup") {
    blocks.splice(i + 1, 0, structuredClone(blocks[i]));
    builder.selected = i + 1;
  } else if (act === "del") {
    blocks.splice(i, 1);
    builder.selected = null;
  }
  renderBlocks();
}

function renderPreview() {
  if (!builder.workout) return;
  const timeline = expand(builder.workout);
  const s = stats(timeline);
  $("bDur").textContent = fmtTime(s.duration);
  $("bTss").textContent = Math.round(s.tss);
  $("bIf").textContent = s.IF.toFixed(2);
  $("bFtpHint").textContent = `watts shown at FTP ${homeFtp()}`;
  if (timeline.duration > 0) {
    drawWorkout($("bChart"), { timeline, ftp: homeFtp(), labels: true, selected: builder.selected });
  } else {
    const c = $("bChart");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
}

$("bDownload").addEventListener("click", () => downloadZwo(builder.workout));
$("bSave").addEventListener("click", async () => {
  const w = builder.workout;
  if (!w.name.trim()) {
    $("bName").focus();
    return alert("Give the workout a name first.");
  }
  if (!w.blocks.length) return alert("Add at least one block.");
  const res = await fetch("/api/workouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: builder.id, name: w.name, xml: serializeZwo(w) }),
  });
  const out = await res.json();
  if (!out.ok) return alert(`Save failed: ${out.error}`);
  await loadLibrary();
  selectWorkout(`mine:${out.id}`);
  setHomeTab("mine");
  show("home");
});

// ======================================================================
// Ride
// ======================================================================

let ride = null;
let tickTimer = null;
let wakeLock = null;
let audioCtx = null;

// ---- audio: short beeps for the last three seconds of an interval ----
function beep(freq = 880, ms = 120) {
  if (!ride?.beep || !audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.18, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + ms / 1000);
}

let toastTimer = null;
function toast(msg, ms = 6000) {
  const el = $("rToast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* not critical */
  }
}
document.addEventListener("visibilitychange", () => {
  if (ride && document.visibilityState === "visible") keepAwake();
});

function startRide() {
  const item = selectedItem();
  if (!item) return;
  if (!trainer.device && !trainer.simulated) {
    if (!confirm("No trainer connected. Start anyway? (Use \"Simulate trainer\" to try it without hardware.)")) return;
  }
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  ride = {
    item,
    timeline: item.timeline,
    ftp: homeFtp(),
    erg: $("setErg").checked,
    beep: $("setBeep").checked,
    pos: 0,
    running: false,
    pauseReason: "start",
    lastTick: performance.now(),
    lastSecond: -1,
    zeroSince: null,
    segIdx: -1,
    lastBeepSec: null,
    nextEvent: 0,
    lastTargetAt: 0,
    trainerMode: null, // "erg" | "free"
    trace: [], // { t, w } for the chart; trimmed when rewinding
    log: [], // every riding second, for the summary
    startedAt: new Date().toISOString(),
  };
  $("rErgToggle").checked = ride.erg;
  $("rBeepToggle").checked = ride.beep;
  $("rWoName").textContent = item.workout.name;
  $("rStripTotal").textContent = fmtTime(ride.timeline.duration);
  $("rDone").classList.remove("show");
  $("rMenu").classList.remove("open");
  closeConfirm(false);
  buildZoneBar();
  renderFtp();
  renderErgState();
  showPause();
  show("ride");
  keepAwake();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
  tick();
}

function buildZoneBar() {
  $("rZoneBar").innerHTML = ZONES.map((z) => `<span style="background:${z.color}"></span>`).join("");
}

function pause(reason) {
  if (!ride || ride.pauseReason) return;
  ride.running = false;
  ride.pauseReason = reason;
  showPause();
}

function resume() {
  if (!ride || !ride.pauseReason) return;
  ride.running = true;
  ride.pauseReason = null;
  ride.zeroSince = null;
  ride.lastTick = performance.now();
  showPause();
}

function showPause() {
  const r = ride?.pauseReason;
  $("rPaused").classList.toggle("show", !!r);
  $("rPause").textContent = r ? "RESUME RIDE" : "PAUSE RIDE";
  if (r === "start") {
    $("rPausedTitle").textContent = "READY";
    $("rPausedSub").textContent = "Start pedaling to begin";
    $("rResume").textContent = "START";
  } else if (r === "auto") {
    $("rPausedTitle").textContent = "PAUSED";
    $("rPausedSub").textContent = "Start pedaling to resume";
    $("rResume").textContent = "RESUME";
  } else {
    $("rPausedTitle").textContent = "PAUSED";
    $("rPausedSub").textContent = "Press resume (or space) when you're ready";
    $("rResume").textContent = "RESUME";
  }
}

function tick() {
  if (!ride) return;
  const now = performance.now();
  const dt = (now - ride.lastTick) / 1000;
  ride.lastTick = now;
  const watts = currentPower();

  // Auto start / pause / resume from the power signal.
  const pedaling = watts !== null && watts > 0;
  if (ride.running) {
    if (!pedaling && $("rAutoPause").checked) {
      ride.zeroSince ??= now;
      if (now - ride.zeroSince > AUTO_PAUSE_S * 1000) pause("auto");
    } else ride.zeroSince = null;
  } else if (pedaling && (ride.pauseReason === "start" || ride.pauseReason === "auto")) {
    resume();
  }

  if (ride.running) {
    ride.pos = Math.min(ride.timeline.duration, ride.pos + dt);
    const sec = Math.floor(ride.pos);
    if (sec !== ride.lastSecond) {
      ride.lastSecond = sec;
      const w = watts ?? 0;
      ride.trace.push({ t: ride.pos, w });
      ride.log.push({ t: sec, w, hr: currentHr(), cad: live.cadence, target: currentTargetW() });
    }
    if (ride.pos >= ride.timeline.duration) return finishRide();
  }

  updateSegment();
  driveTrainer();
  render();
}

function currentSeg() {
  const i = segmentAt(ride.timeline, ride.pos);
  return i < 0 ? null : ride.timeline.segments[i];
}

function currentTargetW() {
  const f = fractionAt(currentSeg(), ride.pos);
  return f === null ? null : Math.round(f * ride.ftp);
}

function updateSegment() {
  const i = segmentAt(ride.timeline, ride.pos);
  if (i !== ride.segIdx) {
    const first = ride.segIdx === -1;
    ride.segIdx = i;
    ride.lastTargetAt = 0; // push the new target immediately
    if (!first && ride.running) {
      beep(1320, 350);
      $("rInterval").classList.remove("flash");
      void $("rInterval").offsetWidth;
      $("rInterval").classList.add("flash");
    }
  }
  const seg = ride.timeline.segments[i];
  if (!seg || !ride.running) return;

  // 3-2-1 countdown into a change of target
  const left = Math.ceil(seg.start + seg.duration - ride.pos);
  const next = ride.timeline.segments[i + 1];
  const changes = next && (next.free !== seg.free || Math.abs(next.from - seg.to) > 0.01);
  if (changes && left <= 3 && left >= 1 && left !== ride.lastBeepSec) {
    ride.lastBeepSec = left;
    beep(880, 110);
  }

  // Workout text events
  const evs = ride.timeline.events;
  while (ride.nextEvent < evs.length && evs[ride.nextEvent].t <= ride.pos) {
    toast(evs[ride.nextEvent].message);
    ride.nextEvent++;
  }
}

function driveTrainer() {
  const target = currentTargetW();
  if (!ride.erg || target === null) {
    if (ride.trainerMode !== "free") {
      trainer.setFreeRide();
      ride.trainerMode = "free";
    }
    return;
  }
  // Ramps change every tick; one write a second is plenty.
  const now = performance.now();
  if (ride.trainerMode === "erg" && now - ride.lastTargetAt < 1000) return;
  ride.lastTargetAt = now;
  ride.trainerMode = "erg";
  trainer.setTargetPower(target);
}

function npOf(log) {
  if (log.length < 30) return null;
  let sum4 = 0;
  let rolling = 0;
  for (let i = 0; i < log.length; i++) {
    rolling += log[i].w;
    if (i >= 30) rolling -= log[i - 30].w;
    if (i >= 29) sum4 += (rolling / 30) ** 4;
  }
  return Math.round((sum4 / (log.length - 29)) ** 0.25);
}

function render() {
  const r = ride;
  const dur = r.timeline.duration;
  const p3 = power3s();
  const seg = currentSeg();
  const target = currentTargetW();

  // top-left
  $("rPower").textContent = p3 ?? "--";
  const avg = r.log.length ? Math.round(r.log.reduce((a, s) => a + s.w, 0) / r.log.length) : null;
  $("rAvg").textContent = avg ?? "--";
  if (r.lastSecond % 5 === 0 || r.npCache === undefined) r.npCache = npOf(r.log);
  $("rNp").textContent = r.npCache ?? "--";
  const bars = $("rZoneBar").children;
  const zi = p3 === null ? -1 : ZONES.indexOf(zoneFor(p3 / r.ftp));
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("on", i === zi);
  $("rZone").textContent = p3 === null ? "--" : `${ZONES[zi].name} · ${Math.round((p3 / r.ftp) * 100)}% FTP`;
  $("rCad").textContent = live.cadence ?? "--";
  $("rHr").textContent = currentHr() ?? "--";
  $("rSpeed").textContent = live.speed != null && currentPower() !== null ? live.speed.toFixed(1) : "--";
  $("rKj").textContent = Math.round(r.log.reduce((a, s) => a + s.w, 0) / 1000);

  // top-center: current interval
  if (seg) {
    const left = seg.start + seg.duration - r.pos;
    $("rIvLbl").textContent = seg.free
      ? "Free ride"
      : seg.from !== seg.to
        ? `Ramp ${Math.round(seg.from * r.ftp)} → ${Math.round(seg.to * r.ftp)} W`
        : seg.rep
          ? seg.on
            ? "Interval"
            : "Recovery"
          : "Target";
    $("rTarget").textContent = target ?? "—";
    $("rIvLeft").textContent = fmtTime(Math.ceil(left));
    $("rIvRep").textContent = seg.rep ? `${seg.rep}/${seg.reps}` : seg.cadence ? `${seg.cadence} rpm` : "";
    $("rIvProg").style.width = `${Math.min(100, ((r.pos - seg.start) / seg.duration) * 100)}%`;
    $("rIvProg").style.background = seg.free ? "#8a8f98" : zoneFor(fractionAt(seg, r.pos)).color;
    const next = r.timeline.segments[r.segIdx + 1];
    $("rNext").innerHTML = next
      ? `Next: <b>${next.free ? "Free ride" : next.from === next.to ? `${Math.round(next.from * r.ftp)} W` : `${Math.round(next.from * r.ftp)}→${Math.round(next.to * r.ftp)} W`}</b> · ${fmtTime(next.duration)}`
      : "Last interval";
    if (target !== null && p3 !== null && r.running) {
      const d = p3 - target;
      const close = Math.abs(d) <= Math.max(5, target * 0.05);
      $("rDelta").textContent = `${d > 0 ? "+" : ""}${d} W`;
      $("rDelta").style.color = close ? "var(--good)" : d < 0 ? "var(--warn)" : "var(--bad)";
    } else $("rDelta").textContent = "";
  }

  // top-right
  const onLast = r.segIdx >= r.timeline.segments.length - 1;
  $("rSkipBtn").disabled = onLast;
  $("rSkip").disabled = onLast;
  $("rClock").textContent = fmtTime(r.pos, { hours: true });
  $("rRemain").textContent = fmtTime(dur - r.pos);

  // bottom strip
  $("rStripPos").textContent = fmtTime(r.pos);
  $("rPct").textContent = `${Math.floor((r.pos / dur) * 100)}%`;
  drawWorkout($("rStrip"), { timeline: r.timeline, ftp: r.ftp, position: r.pos, samples: r.trace });

  // main rolling window: ~20% history, the rest what's coming
  const span = Math.min(720, dur);
  const t0 = Math.min(Math.max(0, r.pos - span * 0.2), dur - span);
  drawWorkout($("rChart"), {
    timeline: r.timeline,
    ftp: r.ftp,
    t0,
    t1: t0 + span,
    position: r.pos,
    samples: r.trace,
    labels: true,
  });
}

function renderFtp() {
  $("rFtp").textContent = ride ? ride.ftp : homeFtp();
}

function renderErgState() {
  const el = $("rErg");
  if (!ride) return;
  if (!ride.erg) {
    el.textContent = "ERG OFF · free resistance";
    el.className = "erg-state";
  } else if (!trainer.canControl) {
    el.textContent = "ERG · trainer not controllable";
    el.className = "erg-state";
  } else {
    el.textContent = "● ERG ON";
    el.className = "erg-state on";
  }
}

function adjustFtp(delta) {
  if (!ride) return;
  ride.ftp = Math.max(50, Math.min(600, ride.ftp + delta));
  ride.lastTargetAt = 0; // re-send the target at the new scale right away
  renderFtp();
  render();
}

function seek(to) {
  ride.pos = Math.max(0, Math.min(ride.timeline.duration - 0.01, to));
  ride.lastSecond = Math.floor(ride.pos);
  ride.trace = ride.trace.filter((s) => s.t <= ride.pos);
  ride.nextEvent = ride.timeline.events.findIndex((e) => e.t > ride.pos);
  if (ride.nextEvent < 0) ride.nextEvent = ride.timeline.events.length;
  ride.lastBeepSec = null;
  updateSegment();
  driveTrainer();
  render();
}

// ---- "are you sure?" for anything that jumps around the workout ----

let pendingConfirm = null;

function askConfirm({ title, body, yes, onYes }) {
  $("rMenu").classList.remove("open");
  $("rConfirmTitle").textContent = title;
  $("rConfirmBody").innerHTML = body;
  $("rConfirmYes").textContent = yes;
  pendingConfirm = onYes;
  $("rConfirm").classList.add("show");
  $("rConfirmYes").focus();
}

function closeConfirm(accepted) {
  const action = pendingConfirm;
  pendingConfirm = null;
  $("rConfirm").classList.remove("show");
  if (accepted && action && ride) action();
}

$("rConfirmYes").addEventListener("click", () => closeConfirm(true));
$("rConfirmNo").addEventListener("click", () => closeConfirm(false));
$("rConfirm").addEventListener("click", (e) => {
  if (e.target === $("rConfirm")) closeConfirm(false);
});

function describeSeg(seg) {
  if (seg.free) return "Free ride";
  const w = (f) => Math.round(f * ride.ftp);
  return seg.from === seg.to ? `${w(seg.from)} W` : `${w(seg.from)} → ${w(seg.to)} W`;
}

// The destination is fixed when the button is pressed, so an interval that
// rolls over while the modal is open doesn't turn "skip" into a double skip.
function skipForward() {
  const i = segmentAt(ride.timeline, ride.pos);
  const next = ride.timeline.segments[i + 1];
  if (!next) return;
  askConfirm({
    title: "Skip to next interval?",
    body: `You'll jump to <b>${describeSeg(next)}</b> for <b>${fmtTime(next.duration)}</b>.`,
    yes: "Skip",
    onYes: () => seek(next.start),
  });
}

function restartInterval() {
  const seg = currentSeg();
  if (!seg) return;
  askConfirm({
    title: "Restart this interval?",
    body: `Back to the start of <b>${describeSeg(seg)}</b> for <b>${fmtTime(seg.duration)}</b>. The time you've done in it is cleared from the chart.`,
    yes: "Restart",
    onYes: () => seek(seg.start),
  });
}

function summarize() {
  const log = ride.log;
  const secs = log.length;
  const avg = secs ? Math.round(log.reduce((a, s) => a + s.w, 0) / secs) : 0;
  const np = npOf(log) ?? avg;
  const IF = np / ride.ftp;
  const hrs = log.filter((s) => s.hr).map((s) => s.hr);
  const cads = log.filter((s) => s.cad).map((s) => s.cad);
  return {
    riding_s: secs,
    avg_power: avg,
    np,
    max_power: secs ? Math.max(...log.map((s) => s.w)) : 0,
    kj: Math.round(log.reduce((a, s) => a + s.w, 0) / 1000),
    if: Math.round(IF * 100) / 100,
    tss: Math.round(((secs * np * IF) / (ride.ftp * 3600)) * 100),
    avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    avg_cadence: cads.length ? Math.round(cads.reduce((a, b) => a + b, 0) / cads.length) : null,
    completed_pct: Math.round((ride.pos / ride.timeline.duration) * 100),
  };
}

function finishRide() {
  if (!ride) return;
  clearInterval(tickTimer);
  ride.running = false;
  trainer.setFreeRide();
  $("rMenu").classList.remove("open");
  $("rPaused").classList.remove("show");
  closeConfirm(false);
  render();
  const s = (ride.summary = summarize());
  const cells = [
    ["Time", fmtTime(s.riding_s)],
    ["Avg power", `${s.avg_power} W`],
    ["NP", `${s.np} W`],
    ["TSS", s.tss],
    ["IF", s.if.toFixed(2)],
    ["Energy", `${s.kj} kJ`],
    ["Avg HR", s.avg_hr ?? "--"],
    ["Avg cadence", s.avg_cadence ?? "--"],
    ["Completed", `${s.completed_pct}%`],
  ];
  $("rSummary").innerHTML = cells.map(([k, v]) => `<div><span>${k.toUpperCase()}</span><b>${v}</b></div>`).join("");
  $("rDone").classList.add("show");
  beep(660, 200);
}

function exitRide() {
  clearInterval(tickTimer);
  trainer.setFreeRide();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  ride = null;
  show("home");
}

$("rSaveRide").addEventListener("click", async () => {
  if (ride.log.length) {
    try {
      await fetch("/api/rides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workout: ride.item.workout.name,
          workout_file: ride.item.id,
          started_at: ride.startedAt,
          finished_at: new Date().toISOString(),
          ftp: ride.ftp,
          summary: ride.summary,
          samples: ride.log,
        }),
      });
    } catch (e) {
      alert(`Couldn't save the ride: ${e.message}`);
      return;
    }
  }
  exitRide();
});
$("rDiscard").addEventListener("click", () => {
  if (confirm("Discard this ride? Nothing will be saved.")) exitRide();
});

$("rFtpUp").addEventListener("click", () => adjustFtp(FTP_STEP));
$("rFtpDown").addEventListener("click", () => adjustFtp(-FTP_STEP));
$("rMenuBtn").addEventListener("click", () => $("rMenu").classList.add("open"));
$("rMenuClose").addEventListener("click", () => $("rMenu").classList.remove("open"));
$("rResume").addEventListener("click", resume);
$("rPause").addEventListener("click", () => {
  if (ride?.pauseReason) resume();
  else pause("manual");
  $("rMenu").classList.remove("open");
});
$("rEnd").addEventListener("click", () =>
  askConfirm({
    title: "End the ride?",
    body: `You've done <b>${fmtTime(ride.pos)}</b> of <b>${fmtTime(ride.timeline.duration)}</b>. You'll see the summary next.`,
    yes: "End ride",
    onYes: finishRide,
  }),
);
$("rSkip").addEventListener("click", skipForward);
$("rBack").addEventListener("click", restartInterval);
$("rSkipBtn").addEventListener("click", skipForward);
$("rRestartBtn").addEventListener("click", restartInterval);
$("rErgToggle").addEventListener("change", (e) => {
  ride.erg = e.target.checked;
  ride.trainerMode = null;
  ride.lastTargetAt = 0;
  trainer.lastTarget = null;
  renderErgState();
  driveTrainer();
});
$("rBeepToggle").addEventListener("change", (e) => (ride.beep = e.target.checked));

document.addEventListener("keydown", (e) => {
  if (!ride || !$("ride").classList.contains("active") || $("rDone").classList.contains("show")) return;
  if (e.target.matches?.("input, textarea")) return;
  if (pendingConfirm) {
    // The modal owns the keyboard while it's open.
    if (e.key === "Escape") closeConfirm(false);
    else if (e.key === "Enter") {
      e.preventDefault();
      closeConfirm(true);
    }
    return;
  }
  if (e.key === "+" || e.key === "=") adjustFtp(FTP_STEP);
  else if (e.key === "-" || e.key === "_") adjustFtp(-FTP_STEP);
  else if (e.key === " ") {
    e.preventDefault();
    if (ride.pauseReason) resume();
    else pause("manual");
  } else if (e.key === "ArrowRight") skipForward();
  else if (e.key === "ArrowLeft") restartInterval();
  else if (e.key === "Escape") $("rMenu").classList.toggle("open");
});

window.addEventListener("resize", () => {
  if (ride) render();
  else if ($("builder").classList.contains("active")) renderPreview();
  else {
    drawLibraryCharts();
    drawDetails();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (ride && ride.log.length && !$("rDone").classList.contains("show")) e.preventDefault();
});

loadLibrary();
