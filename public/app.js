// WHORL — library, builder, and the ride screen.

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
import { drawWorkout, drawRide } from "./chart.js";
import { Trainer, requestHeartRate, attachHeartRate, rememberedDevices, whenReachable } from "./trainer.js";

const $ = (id) => document.getElementById(id);

// fetch for the app's own API: a 401 means the session ran out, so go sign in.
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("signed out");
  }
  return res;
}
const FTP_STEP = 5;
const STALE_MS = 3000; // a reading older than this counts as "no data"
const AUTO_PAUSE_S = 3;
const TICK_MS = 250;

// The app was called Quinvy: carry each saved setting (FTP, ERG, beeps, last tab…)
// over to its whorl.* key once, so nobody's preferences reset with the rename.
try {
  for (const old of Object.keys(localStorage).filter((k) => k.startsWith("quinvy."))) {
    const k = `whorl.${old.slice("quinvy.".length)}`;
    if (localStorage.getItem(k) === null) localStorage.setItem(k, localStorage.getItem(old));
    localStorage.removeItem(old);
  }
} catch {
  /* storage unavailable — nothing to carry over */
}

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`whorl.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`whorl.${k}`, JSON.stringify(v));
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
const homeFtp = () => Number(ftpInput.value) || 200;

// FTP can be set at the top of Browse or in a workout's details; both stay in step,
// and every chart redraws so the watts match. An invalid number goes back to the last good one.
function setFtp(value) {
  let v = Math.round(Number(value));
  if (v >= 50 && v <= 600) store.set("ftp", v);
  else v = store.get("ftp", 200);
  ftpInput.value = v;
  $("dFtpVal").value = v;
  $("bFtpVal").value = v;
  drawLibraryCharts();
  if (detailsItem) {
    renderDetailsMeta();
    drawDetails();
  }
  // The builder shows watts next to every % field, so redraw its rows too.
  if ($("builder").classList.contains("active")) renderBlocks();
}
ftpInput.addEventListener("change", () => setFtp(ftpInput.value));
$("dFtpVal").addEventListener("change", () => setFtp($("dFtpVal").value));
// Redraw while typing, but only once it's a sensible number, so "2" on the way to "245" doesn't snap back.
$("dFtpVal").addEventListener("input", () => {
  const v = Number($("dFtpVal").value);
  if (v >= 50 && v <= 600) setFtp(v);
});
$("dFtpDown").addEventListener("click", () => setFtp(homeFtp() - FTP_STEP));
$("dFtpUp").addEventListener("click", () => setFtp(homeFtp() + FTP_STEP));
$("bFtpVal").addEventListener("change", () => setFtp($("bFtpVal").value));
$("bFtpVal").addEventListener("input", () => {
  const v = Number($("bFtpVal").value);
  if (v >= 50 && v <= 600) setFtp(v);
});
$("bFtpDown").addEventListener("click", () => setFtp(homeFtp() - FTP_STEP));
$("bFtpUp").addEventListener("click", () => setFtp(homeFtp() + FTP_STEP));

$("setBeep").checked = store.get("beep", true);
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

// Devices from earlier visits that can be reconnected without the browser's
// picker (Chrome's getDevices()). Their ids are saved when they first connect.
const known = { trainer: null, hr: null };
let trainerReconnecting = false;
let hrReconnecting = false;
const RECONNECT_WAIT_MS = 30000; // how long to wait for a remembered device to show up

trainer.addEventListener("status", ({ detail }) => {
  $("trDot").classList.toggle("on", detail.connected);
  $("trName").textContent = detail.connected ? detail.name : detail.name || "Disconnected";
  $("trSub").textContent = detail.connected
    ? detail.canControl
      ? "ERG control ready"
      : "power only — no ERG control"
    : "FTMS smart trainer or power meter";
  $("btnSim").disabled = detail.connected;
  if (detail.connected && trainer.device) {
    known.trainer = trainer.device;
    store.set("trainerDevice", { id: trainer.device.id, name: detail.name });
  }
  renderErgState();
  renderSensorButtons();
  // Dropped mid-session (out of range, trainer restarted): get it back by itself.
  if (!detail.connected && known.trainer && !trainerReconnecting) reconnectTrainer();
});
trainer.addEventListener("error", ({ detail }) => toast(`Trainer: ${detail.message}`));

// Connect when there's nothing to remember, Reconnect for a remembered device
// (no picker), Change once connected; "Choose another" always opens the picker.
function renderSensorButtons() {
  const trainerOn = trainer.simulated || !!trainer.device?.gatt?.connected;
  $("btnTrainer").textContent = trainerReconnecting ? "Reconnecting…" : trainerOn ? "Change" : known.trainer ? "Reconnect" : "Connect";
  $("btnTrainer").disabled = trainerReconnecting;
  $("btnTrainerOther").hidden = trainerOn || !known.trainer;
  $("btnHr").textContent = hrReconnecting ? "Reconnecting…" : hrStrapConnected ? "Change" : known.hr ? "Reconnect" : "Connect";
  $("btnHr").disabled = hrReconnecting;
  $("btnHrOther").hidden = hrStrapConnected || !known.hr;
  mirrorSensors();
}

// The workout details window shows the same trainer / heart rate status as the
// cards at the top of Browse, and its Connect buttons press the same buttons.
function mirrorSensors() {
  $("dTrDot").classList.toggle("on", $("trDot").classList.contains("on"));
  $("dTrName").textContent = $("trName").textContent;
  $("dTrSub").textContent = $("trSub").textContent;
  $("dTrainer").textContent = $("btnTrainer").textContent;
  $("dTrainer").disabled = $("btnTrainer").disabled;
  $("dHrDot").classList.toggle("on", $("hrDot").classList.contains("on"));
  $("dHrName").textContent = $("hrName").textContent;
  $("dHr").textContent = $("btnHr").textContent;
  $("dHr").disabled = $("btnHr").disabled;
}
$("dTrainer").addEventListener("click", () => $("btnTrainer").click());
$("dHr").addEventListener("click", () => $("btnHr").click());

function needBluetooth() {
  if (navigator.bluetooth) return true;
  alert("Web Bluetooth isn't available in this browser — use Chrome or Edge.");
  return false;
}

// ---- trainer ----

async function pickTrainer() {
  if (!needBluetooth()) return;
  $("trSub").textContent = "connecting…";
  mirrorSensors();
  try {
    await trainer.connect();
  } catch (e) {
    $("trSub").textContent = e.name === "NotFoundError" ? "FTMS smart trainer or power meter" : `error: ${e.message}`;
  }
  renderSensorButtons();
}

async function reconnectTrainer() {
  const device = known.trainer;
  if (!device || trainerReconnecting || trainer.simulated) return;
  trainerReconnecting = true;
  $("trName").textContent = device.name || "Trainer";
  $("trSub").textContent = "reconnecting…";
  renderSensorButtons();
  try {
    await whenReachable(device, (d) => trainer.attach(d), RECONNECT_WAIT_MS);
  } catch {
    $("trSub").textContent = "not found. Is it on? Tap Reconnect";
  }
  trainerReconnecting = false;
  renderSensorButtons();
}

$("btnTrainer").addEventListener("click", () => {
  const on = trainer.simulated || trainer.device?.gatt?.connected;
  if (!on && known.trainer) return reconnectTrainer();
  pickTrainer();
});
$("btnTrainerOther").addEventListener("click", pickTrainer);

// ---- heart-rate strap ----

function onBpm(bpm) {
  live.hr = bpm;
  live.hrAt = Date.now();
}

function onHrDisconnect() {
  hrStrapConnected = false;
  $("hrDot").classList.remove("on");
  $("hrName").textContent = known.hr?.name || "Disconnected";
  $("hrSub").textContent = "disconnected";
  renderSensorButtons();
  reconnectHr(); // straps drop when you step off the bike or the battery blips
}

async function useHrStrap(device) {
  const name = await attachHeartRate(device, onBpm, onHrDisconnect);
  hrStrapConnected = true;
  known.hr = device;
  store.set("hrDevice", { id: device.id, name });
  $("hrDot").classList.add("on");
  $("hrName").textContent = name;
  $("hrSub").textContent = "connected";
}

async function pickHr() {
  if (!needBluetooth()) return;
  try {
    await useHrStrap(await requestHeartRate());
  } catch (e) {
    if (e.name !== "NotFoundError") $("hrName").textContent = `error: ${e.message}`;
  }
  renderSensorButtons();
}

async function reconnectHr() {
  const device = known.hr;
  if (!device || hrReconnecting) return;
  hrReconnecting = true;
  $("hrName").textContent = device.name || "HR strap";
  $("hrSub").textContent = "reconnecting…";
  renderSensorButtons();
  try {
    await whenReachable(device, useHrStrap, RECONNECT_WAIT_MS);
  } catch {
    $("hrSub").textContent = "not found. Strap on? Tap Reconnect";
  }
  hrReconnecting = false;
  renderSensorButtons();
}

$("btnHr").addEventListener("click", () => {
  if (!hrStrapConnected && known.hr) return reconnectHr();
  pickHr();
});
$("btnHrOther").addEventListener("click", pickHr);

// On load: reconnect the trainer and strap from last time, if the browser can.
async function restoreSensors() {
  const saved = { trainer: store.get("trainerDevice", null), hr: store.get("hrDevice", null) };
  if (!saved.trainer && !saved.hr) return;
  const devices = await rememberedDevices();
  known.trainer = devices.find((d) => d.id === saved.trainer?.id) || null;
  known.hr = devices.find((d) => d.id === saved.hr?.id) || null;
  // Can't reconnect here (the browser doesn't remember devices): say what was used last.
  if (saved.trainer && !known.trainer) $("trSub").textContent = `last used: ${saved.trainer.name}`;
  if (saved.hr && !known.hr) $("hrSub").textContent = `last used: ${saved.hr.name}`;
  renderSensorButtons();
  if (known.trainer) reconnectTrainer();
  if (known.hr) reconnectHr();
}

$("btnSettings").addEventListener("click", () => $("settings").classList.add("show"));
$("setClose").addEventListener("click", () => $("settings").classList.remove("show"));
$("settings").addEventListener("click", (e) => {
  if (e.target === $("settings")) $("settings").classList.remove("show");
});

// ---- Strava: once connected, every saved ride is posted there ----

let strava = { available: false, connected: false, athlete: null };

async function loadStrava() {
  strava = await api("/api/strava")
    .then((r) => r.json())
    .catch(() => strava);
  $("setStrava").hidden = !strava.available;
  $("stravaConnect").hidden = strava.connected;
  $("stravaDisconnect").hidden = !strava.connected;
  $("stravaSub").textContent = strava.connected
    ? `Connected${strava.athlete?.name ? ` as ${strava.athlete.name}` : ""}. Saved rides are posted automatically.`
    : "Post every saved ride to Strava";
}

$("stravaDisconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect Strava? Rides you save won't be posted there any more.")) return;
  await api("/api/strava", { method: "DELETE" });
  loadStrava();
});

const stravaUrl = (id) => `https://www.strava.com/activities/${id}`;

let noticeTimer = null;
function notice(text, link, ms = 8000) {
  const el = $("notice");
  el.textContent = text;
  if (link) {
    const a = document.createElement("a");
    a.className = "strava-link";
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    el.append(a);
  }
  el.classList.add("show");
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// Uploads the saved ride, then waits for Strava to finish processing it.
// Resolves to the final status ({ state: "done", activity_id } or { state: "error", error }).
async function postToStrava(file) {
  const url = `/api/rides/${encodeURIComponent(file)}/strava`;
  notice("Posting to Strava…", null, 0);
  let status;
  try {
    status = await api(url, { method: "POST" }).then((r) => r.json());
    for (let i = 0; status.state === "processing" && i < 20; i++) {
      await new Promise((ok) => setTimeout(ok, 3000));
      status = await api(url).then((r) => r.json());
    }
  } catch (e) {
    status = { state: "error", error: e.message };
  }
  if (status.state === "done") {
    notice("Posted to Strava.", { href: stravaUrl(status.activity_id), text: "View ↗" });
  } else if (status.state === "processing") {
    notice("Strava is still processing the ride. It'll show up there shortly.");
  } else {
    notice(`Couldn't post to Strava: ${status.error || "unknown error"} You can retry from the ride in History.`, null, 12000);
  }
  if (rideView?.summary.id === file) showRideStrava(status);
  return status;
}

// Coming back from Strava's authorization page.
{
  const back = new URLSearchParams(location.search).get("strava");
  if (back) {
    history.replaceState(null, "", location.pathname);
    notice(
      {
        connected: "Strava connected. Rides you save will be posted there.",
        denied: "Strava wasn't connected: Whorl needs permission to upload activities.",
      }[back] || "Couldn't connect Strava. Try again from Settings.",
    );
  }
}

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
// Library — "Browse" lists everything: presets/<collection>/ plus the rider's
// own workouts/ (the "My workouts" collection). "Favorites" lists the starred ones.
// ======================================================================

const COLLECTION_LABELS = {
  mine: "My workouts",
  originals: "Originals",
  featured: "Featured",
  classics: "Classics",
  endurance: "Z2 Endurance",
  plan: "Training plan",
  uploaded: "Uploaded",
};
const collectionLabel = (c) => COLLECTION_LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1);
// Collections that don't put a tag on their cards; they still have a filter chip.
const UNTAGGED = new Set(["featured", "plan"]);
const collectionBadge = (c) => (UNTAGGED.has(c) ? "" : `<span class="badge">${collectionLabel(c)}</span>`);

let library = []; // { key, id, collection, workout, timeline, stats, category }
const browse = { collection: "all", category: "all", durMin: 0, durMax: null, q: "" };
let favorites = new Set(); // library keys, kept in favorites.json by the server
let rides = null; // History: ride summaries from the server, newest first; null until loaded
let homeTab = store.get("homeTab", "browse");
if (homeTab !== "favorites" && homeTab !== "history") homeTab = "browse"; // "mine" was the old My workouts tab

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
  const [mine, presets, favs] = await Promise.all(
    ["/api/workouts", "/api/presets", "/api/favorites"].map((u) =>
      api(u)
        .then((r) => r.json())
        .catch((e) => {
          console.warn(`${u} failed`, e);
          return [];
        }),
    ),
  );
  favorites = new Set(favs);
  library = [];
  for (const [r, collection] of [...mine.map((r) => [r, "mine"]), ...presets.map((r) => [r, r.collection])]) {
    try {
      library.push(toItem(r, collection));
    } catch (e) {
      console.warn(`skipping ${r.id}: ${e.message}`);
    }
  }
  library.sort((a, b) => a.workout.name.localeCompare(b.workout.name));
  renderBrowseFilters();
  renderHome();
}

// ---- tabs ----

function setHomeTab(tab) {
  homeTab = tab;
  store.set("homeTab", tab);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
  $("browsePane").hidden = tab !== "browse";
  $("favPane").hidden = tab !== "favorites";
  $("historyPane").hidden = tab !== "history";
  renderHome();
  renderHistory();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setHomeTab(t.dataset.tab)));

function renderHome() {
  const favs = library.filter((w) => favorites.has(w.key));
  $("tabBrowseCount").textContent = library.length;
  $("tabFavCount").textContent = favs.length;
  if (homeTab === "browse") {
    const shown = library.filter(matchesBrowse);
    $("browseCount").textContent = `${shown.length} of ${library.length} workouts`;
    renderCards($("browseGrid"), shown, "No workouts match these filters.");
  } else if (homeTab === "favorites") {
    renderCards($("favGrid"), favs, "No favorites yet. Tap ☆ on a workout in Browse to add it here.");
  }
}

// ---- browse filters ----

// ---- duration slider: two thumbs on one track, in minutes ----

const DUR_STEP = 5;
let durLimit = 120; // slider end, rounded up from the longest workout

// With the max thumb at the end of the track there's no upper bound, so a
// 3h45 ride still shows when the slider only goes to 4h.
function durInRange(seconds) {
  const min = seconds / 60;
  return min >= browse.durMin && (browse.durMax === null || min <= browse.durMax);
}

function fmtMinutes(m) {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function renderDurSlider() {
  const lo = $("fDurMin");
  const hi = $("fDurMax");
  for (const input of [lo, hi]) {
    input.max = durLimit;
    input.step = DUR_STEP;
  }
  const max = browse.durMax ?? durLimit;
  lo.value = browse.durMin;
  hi.value = max;
  $("fDurFill").style.left = `${(browse.durMin / durLimit) * 100}%`;
  $("fDurFill").style.width = `${((max - browse.durMin) / durLimit) * 100}%`;
  // When both thumbs sit at the far end, the min thumb must be on top or it can't be grabbed.
  lo.style.zIndex = browse.durMin > durLimit / 2 ? 3 : 2;
  const any = browse.durMin === 0 && browse.durMax === null;
  $("fDurVal").textContent = any
    ? "Any length"
    : browse.durMax === null
      ? `${fmtMinutes(browse.durMin)} +`
      : browse.durMin === 0
        ? `Up to ${fmtMinutes(browse.durMax)}`
        : browse.durMin === browse.durMax
          ? fmtMinutes(browse.durMin)
          : `${fmtMinutes(browse.durMin)} – ${fmtMinutes(browse.durMax)}`;
  $("fDurReset").hidden = any;
  $("fDurEnds").innerHTML = `<span>0</span><span>${fmtMinutes(durLimit)}+</span>`;
}

function onDurInput(which) {
  let lo = Number($("fDurMin").value);
  let hi = Number($("fDurMax").value);
  // Thumbs can meet but never cross: the one being dragged stops at the other.
  if (lo > hi) {
    if (which === "min") lo = hi;
    else hi = lo;
  }
  browse.durMin = lo;
  browse.durMax = hi >= durLimit ? null : hi;
  renderDurSlider();
  renderHome();
}

$("fDurMin").addEventListener("input", () => onDurInput("min"));
$("fDurMax").addEventListener("input", () => onDurInput("max"));
$("fDurReset").addEventListener("click", () => {
  browse.durMin = 0;
  browse.durMax = null;
  renderDurSlider();
  renderHome();
});

function matchesBrowse(w) {
  if (browse.collection !== "all" && w.collection !== browse.collection) return false;
  if (browse.category !== "all" && w.category !== browse.category) return false;
  if (!durInRange(w.stats.duration)) return false;
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

// Workout types as bars that rise with intensity, in the same colours as the charts.
function typeFilter(el, cats, current, onPick) {
  el.innerHTML = "";
  el.classList.toggle("all", current === "all");
  const bar = (c, h) => `<i style="--c:${CATEGORY_COLORS[c]}; height:${h}px"></i>`;
  const options = [
    ["all", "All types", CATEGORIES.map((c, i) => bar(c, 10 + i * 5)).join("")],
    ...cats.map((c) => [c, c, bar(c, 16 + CATEGORIES.indexOf(c) * 5)]),
  ];
  for (const [value, label, bars] of options) {
    const b = document.createElement("button");
    b.className = "type" + (value === "all" ? " all" : "") + (value === current ? " on" : "");
    b.setAttribute("aria-pressed", String(value === current));
    b.innerHTML = `<span class="stem">${bars}</span>${label}`;
    b.addEventListener("click", () => onPick(value));
    el.appendChild(b);
  }
}

function renderBrowseFilters() {
  const collections = [...new Set(library.map((w) => w.collection))].sort(
    (a, b) => Object.keys(COLLECTION_LABELS).indexOf(a) - Object.keys(COLLECTION_LABELS).indexOf(b),
  );
  if (browse.collection !== "all" && !collections.includes(browse.collection)) browse.collection = "all";
  chips(
    $("fCollection"),
    [["all", "All", library.length], ...collections.map((c) => [c, collectionLabel(c), library.filter((w) => w.collection === c).length])],
    browse.collection,
    (v) => {
      browse.collection = v;
      renderBrowseFilters();
      renderHome();
    },
  );
  const cats = CATEGORIES.filter((c) => library.some((w) => w.category === c));
  typeFilter($("fCategory"), cats, browse.category, (v) => {
    browse.category = v;
    renderBrowseFilters();
    renderHome();
  });
  const longest = Math.max(60, ...library.map((w) => w.stats.duration / 60));
  durLimit = Math.ceil(longest / 15) * 15;
  browse.durMin = Math.min(browse.durMin, durLimit);
  if (browse.durMax !== null && browse.durMax >= durLimit) browse.durMax = null;
  renderDurSlider();
}

let accountEmail = ""; // the signed-in rider's email, once /auth/me answers

function setSearch(value) {
  $("fSearch").value = value;
  browse.q = value.trim().toLowerCase();
  $("fSearchClear").hidden = !value;
  renderHome();
}
$("fSearch").addEventListener("input", (e) => {
  // A password manager can mistake this box for a username field and fill in the
  // rider's email, which filters every workout out. Nobody searches for that.
  const v = e.target.value;
  setSearch(accountEmail && v.trim().toLowerCase() === accountEmail ? "" : v);
});
$("fSearchClear").addEventListener("click", () => {
  setSearch("");
  $("fSearch").focus();
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
    card.className = "wo";
    card.dataset.key = item.key;
    const s = item.stats;
    const isMine = item.collection === "mine";
    const canDelete = isMine || item.collection === "uploaded";
    const fav = favorites.has(item.key);
    card.innerHTML = `
      <div class="wo-badges">
        <span class="badge cat" style="--c:${CATEGORY_COLORS[item.category]}">${item.category}</span>
        ${collectionBadge(item.collection)}
        <button class="star${fav ? " on" : ""}" data-act="fav" title="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "★" : "☆"}</button>
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
      openDetails(item);
    });
    el.appendChild(card);
  }
  requestAnimationFrame(drawLibraryCharts);
}

function cardAction(item, act) {
  if (act === "fav") return toggleFavorite(item);
  if (act === "edit") return openBuilder(item);
  if (act === "delete") return deleteWorkout(item);
  if (act === "ride") {
    closeDetails();
    return startRide(item);
  }
}

// ---- favorites ----

async function saveFavorites() {
  const res = await api("/api/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [...favorites] }),
  }).catch(() => null);
  return !!(res && res.ok);
}

async function toggleFavorite(item) {
  const on = !favorites.has(item.key);
  if (on) favorites.add(item.key);
  else favorites.delete(item.key);
  renderHome();
  renderDetailsStar();
  if (!(await saveFavorites())) {
    // Put it back the way it was so the screen matches what's saved.
    if (on) favorites.delete(item.key);
    else favorites.add(item.key);
    renderHome();
    renderDetailsStar();
    alert("Couldn't save favorites. Is the server running?");
  }
}

function drawLibraryCharts() {
  document.querySelectorAll(".home-grid .wo").forEach((card) => {
    const item = library.find((w) => w.key === card.dataset.key);
    if (item) drawWorkout(card.querySelector("canvas"), { timeline: item.timeline, ftp: homeFtp() });
  });
}

// ---- details modal ----

let detailsItem = null;

function openDetails(item) {
  detailsItem = item;
  const w = item.workout;
  $("dTitle").textContent = w.name;
  $("dBadges").innerHTML = `<span class="badge cat" style="--c:${CATEGORY_COLORS[item.category]}">${item.category}</span>${collectionBadge(item.collection)}`;
  renderDetailsMeta();
  $("dFtpVal").value = homeFtp();
  mirrorSensors();
  $("dDesc").textContent = w.description || "No description.";
  $("dEdit").textContent = item.collection === "mine" ? "Edit" : "Copy & edit";
  $("dDelete").hidden = !(item.collection === "mine" || item.collection === "uploaded");
  renderDetailsStar();
  $("details").classList.add("show");
  hideTip();
  requestAnimationFrame(() => drawDetails());
}

function renderDetailsMeta() {
  const s = detailsItem.stats;
  $("dMeta").innerHTML = `<span>Duration <b>${fmtTime(s.duration)}</b></span><span>TSS <b>${Math.round(s.tss)}</b></span><span>IF <b>${s.IF.toFixed(2)}</b></span><span>NP <b>${Math.round(s.IF * homeFtp())} W</b></span><span>Author <b class="plain"></b></span>`;
  $("dMeta").querySelector(".plain").textContent = detailsItem.workout.author || "—";
}

function renderDetailsStar() {
  if (!detailsItem) return;
  const fav = favorites.has(detailsItem.key);
  $("dStar").classList.toggle("on", fav);
  $("dStar").textContent = fav ? "★" : "☆";
  $("dStar").title = fav ? "Remove from favorites" : "Add to favorites";
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
$("dStar").addEventListener("click", () => detailsItem && toggleFavorite(detailsItem));
$("details").addEventListener("click", (e) => {
  if (e.target === $("details")) closeDetails();
});
for (const [id, act] of [
  ["dRide", "ride"],
  ["dEdit", "edit"],
  ["dDelete", "delete"],
]) {
  $(id).addEventListener("click", () => {
    const item = detailsItem;
    if (act !== "ride") closeDetails();
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
  await api(url, { method: "DELETE" });
  if (favorites.delete(item.key)) await saveFavorites();
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

// Uploads land in Browse's Uploaded collection (presets/uploaded/).
async function uploadFiles(files) {
  let ok = 0;
  const failed = [];
  for (const file of files) {
    const xml = await file.text();
    try {
      parseZwo(xml); // validate before it lands in the folder
      const res = await api("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, xml }),
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error);
      ok++;
    } catch (e) {
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  if (failed.length) alert(`Couldn't add:\n${failed.join("\n")}`);
  if (!ok) return;
  browse.collection = "uploaded";
  browse.category = "all";
  await loadLibrary();
  setHomeTab("browse");
}

$("uploadFile").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});
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
  uploadFiles([...e.dataTransfer.files].filter((f) => /\.(zwo|xml)$/i.test(f.name)));
});

$("btnNew").addEventListener("click", () => openBuilder(null));
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
  $("bFtpVal").value = homeFtp();
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
  builder.timeline = timeline;
  if (timeline.duration > 0) {
    builder.geom = drawWorkout($("bChart"), { timeline, ftp: homeFtp(), labels: true, selected: builder.selected });
  } else {
    builder.geom = null;
    const c = $("bChart");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
}

// ---- drag the chart: the top of a bar sets its power, its right edge its length ----

const GRAB_PX = 9;
let drag = null; // { b, key, kind, orig, px0, perRep, g } while a handle is held

// Which block field the top of a bar controls. Ramps have two ends, so the half
// you grab decides which one moves; intervals change every rep's on or off power.
function powerKey(b, seg, t) {
  const firstHalf = t - seg.start < seg.duration / 2;
  switch (b.type) {
    case "steady":
      return "power";
    case "intervals":
      return seg.on ? "onPower" : "offPower";
    case "warmup":
    case "ramp":
      return firstHalf ? "powerLow" : "powerHigh";
    case "cooldown": {
      // Cooldowns are drawn high to low whichever way the file stores them.
      const startKey = b.powerLow >= b.powerHigh ? "powerLow" : "powerHigh";
      return firstHalf ? startKey : startKey === "powerLow" ? "powerHigh" : "powerLow";
    }
  }
  return null;
}

// What's under the pointer on the builder chart.
function chartHandle(px, py) {
  const g = builder.geom;
  const segs = builder.timeline?.segments;
  if (!g || !segs?.length) return null;
  const base = g.yAt(0);
  // Right edges first: they're thin, so they win over a bar top right next to them.
  let edge = null;
  for (const seg of segs) {
    const xe = g.xAt(seg.start + seg.duration);
    const top = g.yAt(seg.free ? 0.5 : Math.max(seg.from, seg.to));
    const dist = Math.abs(px - xe);
    if (dist <= 6 && py >= top - GRAB_PX && py <= base && (!edge || dist < edge.dist)) edge = { seg, dist };
  }
  if (edge) return { seg: edge.seg, kind: "length" };
  const t = g.timeAt(px);
  const seg = segs.find((s) => t >= s.start && t < s.start + s.duration);
  if (!seg) return null;
  if (!seg.free) {
    const f = seg.from + ((seg.to - seg.from) * (t - seg.start)) / seg.duration;
    if (Math.abs(py - g.yAt(f)) <= GRAB_PX) return { seg, kind: "power", t };
  }
  return py <= base && py >= g.yAt(seg.free ? 0.5 : Math.max(seg.from, seg.to)) - GRAB_PX ? { seg, kind: "select" } : null;
}

function chartPoint(e) {
  const r = $("bChart").getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function showDragTip(px, py, text) {
  const tip = $("bDragTip");
  tip.textContent = text;
  tip.style.left = `${px}px`;
  tip.style.top = `${py}px`;
  tip.classList.add("show");
}

$("bChart").addEventListener("pointerdown", (e) => {
  const [px, py] = chartPoint(e);
  const h = chartHandle(px, py);
  if (!h) return;
  const g = builder.geom; // keep the scale from the moment of grabbing, so the bar tracks the pointer
  const b = builder.workout.blocks[h.seg.blockIndex];
  selectBlock(h.seg.blockIndex);
  document.querySelectorAll("#blocks .block")[h.seg.blockIndex]?.scrollIntoView({ block: "nearest" });
  if (h.kind === "select") return;
  const key = h.kind === "power" ? powerKey(b, h.seg, h.t) : b.type === "intervals" ? (h.seg.on ? "onDuration" : "offDuration") : "duration";
  if (!key) return;
  drag = { b, key, kind: h.kind, orig: b[key], px0: px, perRep: h.seg.rep || 1, g };
  $("bChart").setPointerCapture(e.pointerId);
  e.preventDefault();
});

$("bChart").addEventListener("pointermove", (e) => {
  const [px, py] = chartPoint(e);
  if (!drag) {
    const h = chartHandle(px, py);
    $("bChart").style.cursor = !h ? "default" : h.kind === "power" ? "ns-resize" : h.kind === "length" ? "ew-resize" : "pointer";
    return;
  }
  const { b, key, g } = drag;
  if (drag.kind === "power") {
    b[key] = Math.max(0.2, Math.min(3, Math.round(g.fracAt(py) * 100) / 100));
    showDragTip(px, py, `${Math.round(b[key] * 100)}% · ${Math.round(b[key] * homeFtp())}W`);
  } else {
    // In intervals the grabbed edge moves by one step per rep before it, so share the drag out.
    const dt = (g.timeAt(px) - g.timeAt(drag.px0)) / drag.perRep;
    const step = drag.orig >= 120 ? 15 : 5;
    b[key] = Math.max(step, Math.round((drag.orig + dt) / step) * step);
    showDragTip(px, py, fmtTime(b[key]));
  }
  renderPreview();
});

function endDrag() {
  if (!drag) return;
  drag = null;
  $("bDragTip").classList.remove("show");
  renderBlocks(); // the block's fields show the new numbers
}
$("bChart").addEventListener("pointerup", endDrag);
$("bChart").addEventListener("pointercancel", endDrag);

$("bDownload").addEventListener("click", () => downloadZwo(builder.workout));
$("bSave").addEventListener("click", async () => {
  const w = builder.workout;
  if (!w.name.trim()) {
    $("bName").focus();
    return alert("Give the workout a name first.");
  }
  if (!w.blocks.length) return alert("Add at least one block.");
  const res = await api("/api/workouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: builder.id, name: w.name, xml: serializeZwo(w) }),
  });
  const out = await res.json();
  if (!out.ok) return alert(`Save failed: ${out.error}`);
  // Land on Browse filtered to My workouts, so the saved workout is in view.
  browse.collection = "mine";
  browse.category = "all";
  await loadLibrary();
  setHomeTab("browse");
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

function startRide(item) {
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
    beep: $("setBeep").checked,
    pos: 0,
    running: false,
    pauseReason: "start",
    lastTick: performance.now(),
    lastSecond: -1,
    zeroSince: null,
    segIdx: -1,
    lastBeepSec: null,
    cadWarned: null, // segment index already announced as "coming up"
    nextEvent: 0,
    lastTargetAt: 0,
    trainerMode: null, // "erg" | "free"
    trace: [], // { t, w } for the chart; trimmed when rewinding
    log: [], // every riding second, for the summary
    startedAt: new Date().toISOString(),
  };
  $("rBeepToggle").checked = ride.beep;
  $("rWoName").textContent = item.workout.name;
  $("rDone").classList.remove("show");
  $("rMenu").classList.remove("open");
  hideCadence();
  closeConfirm(false);
  renderFtp();
  renderErgState();
  showPause();
  show("ride");
  keepAwake();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
  tick();
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
  syncPauseMenu();
}

// Paused mid-ride (not the READY screen), the ride menu opens beside the pause
// screen, so resume, restart/skip interval, end ride and the settings are all there.
function syncPauseMenu() {
  const paused = ride?.pauseReason === "auto" || ride?.pauseReason === "manual";
  const open = paused && !pendingConfirm && !$("rDone").classList.contains("show");
  $("rMenu").classList.toggle("open", open);
  $("rPaused").classList.toggle("with-menu", open);
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
      ride.trace.push({ t: ride.pos, w, hr: currentHr() });
      ride.log.push({ t: sec, w, hr: currentHr(), cad: live.cadence, spd: live.speed, target: currentTargetW() });
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
    const prev = ride.timeline.segments[ride.segIdx];
    ride.segIdx = i;
    ride.lastTargetAt = 0; // push the new target immediately
    if (!first && ride.running) {
      beep(1320, 350);
      $("rInterval").classList.remove("flash");
      void $("rInterval").offsetWidth;
      $("rInterval").classList.add("flash");
      announceCadence(prev, ride.timeline.segments[i]);
    }
  }
  const seg = ride.timeline.segments[i];
  if (!seg || !ride.running) return;

  // 3-2-1 countdown into a change of target
  const left = Math.ceil(seg.start + seg.duration - ride.pos);
  const next = ride.timeline.segments[i + 1];
  const cadChange = next && cadenceShift(seg, next);
  const changes = next && (next.free !== seg.free || Math.abs(next.from - seg.to) > 0.01 || cadChange);
  if (changes && left <= 3 && left >= 1 && left !== ride.lastBeepSec) {
    ride.lastBeepSec = left;
    beep(880, 110);
  }

  // Heads-up before a big cadence change, counting down to it.
  if (cadChange?.big && left <= CAD_WARN_S && left >= 1) {
    ride.cadWarned = i + 1;
    showCadence(cadChange, `${cadChange.dir === "up" ? "Spin up" : "Slow down"} in ${left}`, false);
  }

  // Workout text events
  const evs = ride.timeline.events;
  while (ride.nextEvent < evs.length && evs[ride.nextEvent].t <= ride.pos) {
    toast(evs[ride.nextEvent].message);
    ride.nextEvent++;
  }
}

// ---- cadence call-outs: any change of cadence target pops up mid-screen ----

const CAD_WARN_S = 5;
const CAD_BIG_RPM = 8;
const CAD_HOLD_MS = 6000;
let cadTimer = null;

// What changes between two segments' cadence targets, or null if nothing does.
function cadenceShift(from, to) {
  const a = from?.cadence ?? null;
  const b = to?.cadence ?? null;
  if (a === b) return null;
  if (b === null) return { rpm: null, dir: "free", big: false };
  if (a === null) return { rpm: b, dir: "new", big: false };
  return { rpm: b, dir: b > a ? "up" : "down", big: Math.abs(b - a) >= CAD_BIG_RPM };
}

function showCadence(shift, label, now) {
  const el = $("rCadAlert");
  el.classList.toggle("up", shift.dir === "up");
  el.classList.toggle("down", shift.dir === "down" || shift.dir === "free");
  $("rCadArrow").textContent = shift.dir === "up" ? "▲" : shift.dir === "new" ? "●" : "▼";
  $("rCadLbl").textContent = label;
  $("rCadVal").textContent = shift.rpm ?? "Your call";
  el.querySelector("small").hidden = shift.rpm === null;
  el.classList.add("show");
  if (now) {
    el.classList.remove("now");
    void el.offsetWidth;
    el.classList.add("now");
  }
  clearTimeout(cadTimer);
  cadTimer = setTimeout(hideCadence, now ? CAD_HOLD_MS : 1500);
}

function hideCadence() {
  clearTimeout(cadTimer);
  $("rCadAlert").classList.remove("show", "now");
}

function announceCadence(prev, seg) {
  const shift = cadenceShift(prev, seg);
  if (!shift) {
    // Moved on without a cadence change: drop any leftover heads-up.
    if (ride.cadWarned !== null) hideCadence();
    ride.cadWarned = null;
    return;
  }
  ride.cadWarned = null;
  const label =
    shift.dir === "free"
      ? "Cadence: back to your own"
      : shift.big
        ? shift.dir === "up"
          ? "Spin up now"
          : "Slow cadence now"
        : "New cadence";
  showCadence(shift, label, true);
  // Two quick notes after the interval beep: rising to spin up, falling to slow down.
  const notes = shift.dir === "up" ? [988, 1480] : shift.dir === "new" ? [1175, 1175] : [1480, 988];
  setTimeout(() => beep(notes[0], 120), 420);
  setTimeout(() => beep(notes[1], 180), 580);
}

function driveTrainer() {
  const target = currentTargetW();
  // Workouts always run in ERG; only free-ride blocks hand the resistance back.
  if (target === null) {
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

  // top bar: only says something when the trainer has dropped
  $("rTrWarn").hidden = !!(trainer.simulated || trainer.device?.gatt?.connected);

  // the heads-up row. Elapsed only shows hours once there is one.
  $("rClock").textContent = fmtTime(r.pos);
  $("rRemain").textContent = fmtTime(dur - r.pos);
  $("rPower").textContent = p3 ?? "--";
  $("rTarget").textContent = seg?.free ? "Free" : target !== null ? `${target} W` : "--";
  $("rPowerTile").style.setProperty("--c", !seg || seg.free || target === null ? ZONES[0].color : zoneFor(target / r.ftp).color);
  $("rHr").textContent = currentHr() ?? "--";
  $("rCad").textContent = live.cadence ?? "--";

  // the current block as a ring that empties beside power, then the next three as bars that rise with effort
  if (seg) {
    const left = seg.start + seg.duration - r.pos;
    const watts = (s) =>
      s.free ? "Free" : s.from === s.to ? `${Math.round(s.from * r.ftp)} W` : `${Math.round(s.from * r.ftp)}→${Math.round(s.to * r.ftp)} W`;
    const colour = (s, f = (s.from + s.to) / 2) => (s.free ? ZONES[0].color : zoneFor(f).color);
    $("rIvLeft").textContent = fmtTime(Math.ceil(left));
    const rep = seg.rep ? (seg.on ? `Rep ${seg.rep} of ${seg.reps}` : `Rest ${seg.rep} of ${seg.reps}`) : "";
    const cad = seg.cadence ? `${seg.cadence} rpm` : "";
    $("rIvSub").textContent = [rep, cad].filter(Boolean).join(" · ");
    const arc = $("rArc");
    const around = 2 * Math.PI * 88;
    arc.setAttribute("stroke-dasharray", `${Math.max(0, (left / seg.duration) * around)} ${around}`);
    arc.setAttribute("stroke", colour(seg, fractionAt(seg, r.pos)));
    $("rIvSvg").setAttribute("aria-label", `Interval: ${fmtTime(Math.ceil(left))} left${rep ? `, ${rep}` : ""}`);

    // Only rebuilt when the block or FTP changes, not every tick.
    const nextKey = `${r.segIdx}|${r.ftp}`;
    if (r.nextKey !== nextKey) {
      r.nextKey = nextKey;
      const ahead = r.timeline.segments.slice(r.segIdx + 1, r.segIdx + 4);
      const withCadence = ahead.some((s) => s.cadence);
      $("rNext").innerHTML = ahead.length
        ? ahead
            .map((s, i) => {
              const f = s.free ? 0.5 : Math.max(s.from, s.to);
              const h = Math.round(Math.max(14, Math.min(120, (f / 1.2) * 120)));
              return `<div class="r-step">${i === 0 ? '<span class="tag">NEXT</span>' : ""}<i style="--c:${colour(s)}; height:${h}px"></i><span>${watts(s)}</span><span>${fmtTime(s.duration)}</span>${withCadence ? `<span class="rpm">${s.cadence ? `${s.cadence} rpm` : ""}</span>` : ""}</div>`;
            })
            .join("")
        : '<span class="r-last">Last interval</span>';
      $("rNext").setAttribute(
        "aria-label",
        ahead.length ? `Up next: ${ahead.map((s) => `${watts(s)} for ${fmtTime(s.duration)}`).join(", then ")}` : "Last interval",
      );
    }
  }

  $("rSkip").disabled = r.segIdx >= r.timeline.segments.length - 1;

  // bottom strip
  drawWorkout($("rStrip"), {
    timeline: r.timeline,
    ftp: r.ftp,
    position: r.pos,
    samples: r.trace,
    heartRate: true,
    labels: true,
    small: true,
  });

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
    heartRate: true,
    labels: true,
  });
}

function renderFtp() {
  $("rFtp").textContent = ride ? ride.ftp : homeFtp();
}

function renderErgState() {
  if (!ride) return;
  $("rErgWarn").hidden = !!trainer.canControl;
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
  hideCadence();
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
  syncPauseMenu();
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
  closeConfirm(false);
  $("rMenu").classList.remove("open");
  $("rPaused").classList.remove("show", "with-menu");
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
    let saved;
    try {
      saved = await api("/api/rides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workout: ride.item.workout.name,
          workout_key: ride.item.key,
          workout_file: ride.item.id,
          started_at: ride.startedAt,
          finished_at: new Date().toISOString(),
          ftp: ride.ftp,
          summary: ride.summary,
          samples: ride.log,
        }),
      }).then((r) => r.json());
    } catch (e) {
      alert(`Couldn't save the ride: ${e.message}`);
      return;
    }
    loadRides();
    if (strava.connected && saved?.file) postToStrava(saved.file);
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
$("rBeepToggle").addEventListener("change", (e) => {
  ride.beep = e.target.checked;
  store.set("beep", ride.beep);
  $("setBeep").checked = ride.beep;
});

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
    drawRideView();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (ride && ride.log.length && !$("rDone").classList.contains("show")) e.preventDefault();
});

// ======================================================================
// Account: who's signed in, sign out, delete account
// ======================================================================

async function loadAccount() {
  const me = await api("/auth/me")
    .then((r) => r.json())
    .catch(() => ({ mode: "open" }));
  // Open mode has nobody to sign out; the shared password has no account to delete.
  $("acctSignOut").hidden = me.mode === "open";
  $("acctEmail").textContent = me.email || "";
  $("acctEmail").hidden = !me.email;
  // A local server signs everyone in with one shared password, so there's no email to show.
  $("setEmailVal").textContent = me.email || "the shared beta password";
  $("setEmail").hidden = me.mode === "open";
  accountEmail = (me.email || "").toLowerCase();
  $("daUser").value = me.email || ""; // the username the Delete account password belongs to
  if (accountEmail && $("fSearch").value.trim().toLowerCase() === accountEmail) setSearch("");
  $("setAccount").hidden = me.mode !== "accounts";
}

// Show/hide eye inside the password field.
const EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = EYE.replace("</svg>", '<path d="M3 3l18 18"/></svg>');
function showPassword(input, eye, shown) {
  input.type = shown ? "text" : "password";
  eye.innerHTML = shown ? EYE_OFF : EYE;
  eye.setAttribute("aria-label", shown ? "Hide password" : "Show password");
  eye.setAttribute("aria-pressed", String(shown));
}
showPassword($("daPassword"), $("daEye"), false);
$("daEye").addEventListener("click", () => {
  showPassword($("daPassword"), $("daEye"), $("daPassword").type === "password");
  $("daPassword").focus();
});

function closeDeleteAccount() {
  $("delAcct").classList.remove("show");
  $("daPassword").value = "";
  showPassword($("daPassword"), $("daEye"), false);
}

$("acctDelete").addEventListener("click", () => {
  $("settings").classList.remove("show");
  $("daError").textContent = "";
  $("delAcct").classList.add("show");
  $("daPassword").focus();
});
$("daClose").addEventListener("click", closeDeleteAccount);
$("daCancel").addEventListener("click", closeDeleteAccount);
$("delAcct").addEventListener("click", (e) => {
  if (e.target === $("delAcct")) closeDeleteAccount();
});
$("daForm").addEventListener("submit", (e) => e.preventDefault());
$("daPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("daConfirm").click();
});
$("daConfirm").addEventListener("click", async () => {
  $("daError").textContent = "";
  $("daConfirm").disabled = true;
  try {
    const res = await api("/auth/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("daPassword").value }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "Couldn't delete the account. Try again.");
    location.href = "/login";
  } catch (e) {
    $("daError").textContent = e.message;
  } finally {
    $("daConfirm").disabled = false;
  }
});

// ======================================================================
// History: every saved ride, newest first
// ======================================================================

async function loadRides() {
  try {
    rides = await api("/api/rides").then((r) => r.json());
  } catch (e) {
    console.warn("rides failed", e);
    rides ??= [];
  }
  renderHistory();
}

function fmtHours(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderHistory() {
  $("tabHistCount").textContent = rides ? rides.length : "";
  if (homeTab !== "history" || !rides) return;
  const now = Date.now();
  const total = (days) => {
    const rs = rides.filter((r) => days === null || now - Date.parse(r.started_at) <= days * 864e5);
    const sum = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
    return { n: rs.length, secs: sum("riding_s"), tss: sum("tss"), kj: sum("kj") };
  };
  $("histTotals").innerHTML = [
    ["Last 7 days", total(7)],
    ["Last 30 days", total(30)],
    ["All time", total(null)],
  ]
    .map(
      ([label, t]) => `<div class="hist-total"><h3>${label}</h3><div class="big">${fmtHours(t.secs)}</div>` +
        `<div class="sub">${t.n} ride${t.n === 1 ? "" : "s"} · TSS ${Math.round(t.tss)} · ${t.kj} kJ</div></div>`,
    )
    .join("");

  const list = $("histList");
  list.innerHTML = "";
  if (!rides.length) {
    list.innerHTML = `<div class="empty">No rides yet. Finish a ride and choose <b>Save &amp; exit</b>, and it'll show up here.</div>`;
    return;
  }
  for (const r of rides) {
    const row = document.createElement("button");
    row.className = "hist-row" + ((r.riding_s || 0) < 60 ? " short" : "");
    row.innerHTML = `
      <div class="hist-when"><div class="hist-date"></div><div class="hist-name"></div></div>
      <div class="hist-stats">
        <span>Time<b>${fmtTime(r.riding_s || 0)}</b></span>
        <span>Avg<b>${r.avg_power ?? "--"} W</b></span>
        <span>NP<b>${r.np ?? "--"} W</b></span>
        <span>TSS<b>${r.tss ?? "--"}</b></span>
        <span class="hr">HR<b>${r.avg_hr ?? "--"}</b></span>
      </div>`;
    row.querySelector(".hist-date").textContent = fmtWhen(r.started_at);
    row.querySelector(".hist-name").textContent = r.workout;
    row.addEventListener("click", () => openRide(r));
    list.appendChild(row);
  }
}

// The workout a ride was done on, if it's still in the library: by its key, then
// by file name, then by name (workouts have moved collections and been renamed
// since some rides were saved).
function workoutForRide(r) {
  const file = r.workout_file || "";
  const key = r.workout_key || (file.includes("/") ? `${file.split("/")[0]}:${file}` : `mine:${file}`);
  const base = file.split("/").pop();
  // Titles lost their lengths ("Long Ride 1.5h", "... (90min)"), so compare without them.
  const plain = (name) =>
    String(name || "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+-?\s*\d+(\.\d+)?\s*(h|hr|min)\b|\s+-\s*\d+h\d+m\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return (
    library.find((w) => w.key === key) ||
    (base && library.find((w) => w.id.split("/").pop() === base)) ||
    library.find((w) => w.workout.name === r.workout) ||
    library.find((w) => plain(w.workout.name) === plain(r.workout)) ||
    null
  );
}

let rideView = null; // { summary, data, geom, hover }

async function openRide(r) {
  rideView = { summary: r, data: null, geom: null, hover: null };
  $("rvDate").textContent = fmtWhen(r.started_at);
  $("rvTitle").textContent = r.workout;
  const cells = [
    ["Time", fmtTime(r.riding_s || 0)],
    ["Avg power", `${r.avg_power ?? "--"} W`],
    ["NP", `${r.np ?? "--"} W`],
    ["Max", `${r.max_power ?? "--"} W`],
    ["TSS", r.tss ?? "--"],
    ["IF", r.if != null ? Number(r.if).toFixed(2) : "--"],
    ["Energy", `${r.kj ?? "--"} kJ`],
    ["Avg HR", r.avg_hr ?? "--"],
    ["Cadence", r.avg_cadence ?? "--"],
    ["Completed", `${r.completed_pct ?? "--"}%`],
    ["FTP", `${r.ftp ?? "--"} W`],
  ];
  $("rvStats").innerHTML = cells.map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join("");
  $("rvAgain").hidden = !workoutForRide(r);
  showRideStrava(null);
  $("rvLoading").hidden = false;
  $("rvTip").classList.remove("show");
  const c = $("rvChart");
  c.getContext("2d").clearRect(0, 0, c.width, c.height);
  $("rideView").classList.add("show");
  try {
    const res = await api(`/api/rides/${encodeURIComponent(r.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (rideView?.summary !== r) return; // closed or switched while loading
    rideView.data = data;
    showRideStrava(data.strava || null);
    $("rvLoading").hidden = true;
    drawRideView();
  } catch (e) {
    $("rvLoading").textContent = "Couldn't load this ride.";
  }
}

function drawRideView() {
  if (!rideView?.data || !$("rideView").classList.contains("show")) return;
  rideView.geom = drawRide($("rvChart"), {
    samples: rideView.data.samples || [],
    ftp: rideView.data.ftp || homeFtp(),
    hover: rideView.hover,
  });
}

function closeRide() {
  $("rideView").classList.remove("show");
  $("rvLoading").textContent = "Loading ride…";
  rideView = null;
}

$("rvClose").addEventListener("click", closeRide);
$("rideView").addEventListener("click", (e) => {
  if (e.target === $("rideView")) closeRide();
});

// Hover (or drag a finger) across the chart to read the numbers at that moment.
function rideTip(e) {
  if (!rideView?.geom || !rideView.data) return;
  const rect = $("rvChart").getBoundingClientRect();
  const px = e.clientX - rect.left;
  const i = rideView.geom.indexAt(px);
  const smp = rideView.data.samples[i];
  if (!smp) return;
  rideView.hover = i;
  drawRideView();
  const tip = $("rvTip");
  tip.innerHTML =
    `<div class="tip-head">${fmtTime(smp.t ?? i)}</div>` +
    `<div class="tip-w">${smp.w ?? "--"} W</div>` +
    `<div class="tip-sub">target ${smp.target ?? "--"} W${smp.hr ? ` · ♥ ${smp.hr}` : ""}${smp.cad ? ` · ${smp.cad} rpm` : ""}</div>`;
  tip.style.left = `${Math.max(70, Math.min(rect.width - 70, px))}px`;
  tip.style.top = "64px";
  tip.classList.add("show");
}
$("rvChart").addEventListener("pointermove", rideTip);
$("rvChart").addEventListener("pointerdown", rideTip);
$("rvChart").addEventListener("pointerleave", () => {
  if (!rideView) return;
  rideView.hover = null;
  $("rvTip").classList.remove("show");
  drawRideView();
});

$("rvAgain").addEventListener("click", () => {
  const item = rideView && workoutForRide(rideView.summary);
  if (!item) return;
  closeRide();
  openDetails(item);
});

// "View on Strava" once it's there; otherwise a button to post it (a ride
// saved before connecting, or one whose upload failed).
function showRideStrava(status) {
  const done = status?.state === "done";
  $("rvStravaLink").hidden = !done;
  if (done) $("rvStravaLink").href = stravaUrl(status.activity_id);
  const post = $("rvStravaPost");
  post.hidden = done || !strava.connected || !rideView?.data;
  post.disabled = status?.state === "processing" && !!status.posting;
  post.textContent = post.disabled ? "Posting…" : status?.state === "error" ? "Retry Strava" : "Post to Strava";
}

$("rvStravaPost").addEventListener("click", async () => {
  const r = rideView?.summary;
  if (!r) return;
  showRideStrava({ state: "processing", posting: true });
  await postToStrava(r.id);
});

$("rvDelete").addEventListener("click", async () => {
  const r = rideView?.summary;
  if (!r || !confirm(`Delete this ride (${r.workout}, ${fmtWhen(r.started_at)}) from your history?`)) return;
  await api(`/api/rides/${encodeURIComponent(r.id)}`, { method: "DELETE" });
  closeRide();
  await loadRides();
});

loadAccount();
loadStrava();
loadLibrary();
loadRides();
restoreSensors();
