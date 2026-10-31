// CHART — the workout profile, drawn on a canvas.
//
// Bars are the planned targets coloured by zone. Everything left of the
// position cursor is "done": bars dim and the rider's actual power is traced
// over them. The same renderer draws the big rolling window, the full-workout
// strip, the library thumbnails and the builder preview.

import { zoneFor, fmtTime } from "./zwo.js";

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

// 30 → "30s", 900 → "15 min", 270 → "4:30"
function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return fmtTime(sec);
}

export function peakFraction(timeline) {
  return timeline.segments.reduce((m, s) => Math.max(m, s.from, s.to), 1);
}

/**
 * opts:
 *   timeline   expanded workout
 *   ftp        watts
 *   t0, t1     visible window in workout seconds (default: whole workout)
 *   position   cursor in workout seconds (null = no cursor, nothing "done")
 *   samples    [{ t, w, hr }] actual power (and heart rate), workout seconds
 *   heartRate  also trace heart rate from samples, on its own 60–200 bpm scale
 *   labels     draw target labels + time axis
 *   selected   block index to highlight (builder)
 *   hover      segment index to outline (details tooltip)
 *   small      smaller target labels (the ride screen's full-workout strip)
 *
 * Returns the geometry so callers can hit-test the pointer against bars.
 */
export function drawWorkout(canvas, opts) {
  const { ctx, width, height } = fitCanvas(canvas);
  const { timeline, ftp, labels = false, small = false, samples = [], heartRate = false, selected = null, hover = null } = opts;
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? Math.max(1, timeline.duration);
  const pos = opts.position ?? null;

  ctx.clearRect(0, 0, width, height);
  const pad = labels ? { l: 0, r: 0, t: small ? 40 : 52, b: 22 } : { l: 0, r: 0, t: 3, b: 0 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const base = pad.t + H;
  const yMaxF = Math.max(peakFraction(timeline) * 1.12, 1.2);
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * W;
  const y = (f) => base - (f / yMaxF) * H;

  // FTP reference line
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(239,233,226,.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, Math.round(y(1)) + 0.5);
  ctx.lineTo(pad.l + W, Math.round(y(1)) + 0.5);
  ctx.stroke();
  ctx.restore();
  if (labels) {
    ctx.font = "600 11px Barlow, system-ui, sans-serif";
    ctx.fillStyle = "rgba(239,233,226,.45)";
    ctx.textAlign = "right";
    ctx.fillText(`FTP ${Math.round(ftp)}W`, pad.l + W - 6, y(1) - 5);
  }

  // Bars, drawn twice: dimmed in the past, full strength ahead.
  const cut = pos === null ? pad.l : Math.max(pad.l, Math.min(pad.l + W, x(pos)));
  const drawBars = (alpha) => {
    for (const s of timeline.segments) {
      const s0 = s.start;
      const s1 = s.start + s.duration;
      if (s1 < t0 || s0 > t1) continue;
      const dim = selected !== null && s.blockIndex !== selected ? 0.35 : 1;
      if (s.free) {
        ctx.globalAlpha = alpha * dim;
        ctx.fillStyle = "rgba(160,160,175,.35)";
        ctx.fillRect(x(s0), y(0.5), x(s1) - x(s0), base - y(0.5));
        ctx.strokeStyle = "rgba(239,233,226,.18)";
        ctx.lineWidth = 1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x(s0), y(0.5), x(s1) - x(s0), base - y(0.5));
        ctx.clip();
        for (let hx = x(s0) - H; hx < x(s1); hx += 8) {
          ctx.beginPath();
          ctx.moveTo(hx, base);
          ctx.lineTo(hx + H, base - H);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }
      // Ramps are sliced so each slice can take its own zone colour.
      const px = Math.max(1, x(s1) - x(s0));
      const slices = s.from === s.to ? 1 : Math.max(1, Math.ceil(px / 3));
      for (let i = 0; i < slices; i++) {
        const a = s0 + (s.duration * i) / slices;
        const b = s0 + (s.duration * (i + 1)) / slices;
        const fa = s.from + ((s.to - s.from) * i) / slices;
        const fb = s.from + ((s.to - s.from) * (i + 1)) / slices;
        const xa = x(a);
        const xb = x(b);
        ctx.globalAlpha = alpha * dim;
        ctx.fillStyle = zoneFor((fa + fb) / 2).color;
        ctx.beginPath();
        ctx.moveTo(xa, base);
        ctx.lineTo(xa, y(fa));
        ctx.lineTo(xb, y(fb));
        ctx.lineTo(xb, base);
        ctx.closePath();
        ctx.fill();
      }
      // Hairline between segments so back-to-back intervals read as separate.
      ctx.globalAlpha = 0.5 * alpha;
      ctx.fillStyle = "#14120f";
      ctx.fillRect(x(s1) - 0.5, y(Math.max(s.from, s.to)), 1, base - y(Math.max(s.from, s.to)));
    }
    ctx.globalAlpha = 1;
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cut, height);
  ctx.clip();
  drawBars(0.28);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(cut, 0, width - cut, height);
  ctx.clip();
  drawBars(0.92);
  ctx.restore();

  // Hovered segment: lift it with a light wash and a white outline.
  const hs = hover !== null ? timeline.segments[hover] : null;
  if (hs) {
    const xa = x(hs.start);
    const xb = x(hs.start + hs.duration);
    const ya = y(hs.free ? 0.5 : hs.from);
    const yb = y(hs.free ? 0.5 : hs.to);
    ctx.beginPath();
    ctx.moveTo(xa, base);
    ctx.lineTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.lineTo(xb, base);
    ctx.closePath();
    ctx.fillStyle = "rgba(239,233,226,.18)";
    ctx.fill();
    ctx.strokeStyle = "#efe9e2";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Target watts and duration over upcoming segments that have room for them.
  if (labels) {
    ctx.textAlign = "center";
    const wattFont = `700 ${small ? 16 : 22}px "Barlow Condensed", "Arial Narrow", system-ui, sans-serif`;
    const durFont = `600 ${small ? 12 : 15}px Barlow, system-ui, sans-serif`;
    for (const s of timeline.segments) {
      const xa = Math.max(x(s.start), cut, pad.l);
      const xb = Math.min(x(s.start + s.duration), pad.l + W);
      if (xb <= xa) continue;
      const watts = s.free
        ? "FREE"
        : s.from === s.to
          ? `${Math.round(s.from * ftp)}W`
          : `${Math.round(s.from * ftp)}→${Math.round(s.to * ftp)}W`;
      const dur = fmtDuration(s.duration);
      ctx.font = wattFont;
      const ww = ctx.measureText(watts).width;
      ctx.font = durFont;
      if (Math.max(ww, ctx.measureText(dur).width) + 10 > xb - xa) continue;
      const top = y(s.free ? 0.5 : Math.max(s.from, s.to));
      const cx = (xa + xb) / 2;
      ctx.fillStyle = "rgba(239,233,226,.8)";
      ctx.fillText(dur, cx, top - 6);
      ctx.font = wattFont;
      ctx.fillStyle = "#efe9e2";
      ctx.fillText(watts, cx, top - (small ? 19 : 25));
    }
  }

  // Heart rate, under the power line, on its own scale so it never fights the targets.
  if (heartRate && samples.length > 1) {
    const yHr = (bpm) => base - ((Math.min(200, Math.max(60, bpm)) - 60) / 140) * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, W, height);
    ctx.clip();
    ctx.lineWidth = small ? 1.5 : 2;
    ctx.strokeStyle = "rgba(255,59,92,.9)";
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    for (const s of samples) {
      if (s.t < t0 - 5 || s.t > t1 || !s.hr) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x(s.t), yHr(s.hr));
        started = true;
      } else ctx.lineTo(x(s.t), yHr(s.hr));
    }
    ctx.stroke();
    ctx.restore();
  }

  // Actual power trace (3 s rolling average so it isn't a scribble).
  if (samples.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, W, height);
    ctx.clip();
    ctx.lineWidth = labels ? 2 : 1.25;
    ctx.strokeStyle = "#efe9e2";
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowBlur = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    const k = 3;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t < t0 - 5 || s.t > t1) continue;
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - k + 1); j <= i; j++) {
        sum += samples[j].w;
        n++;
      }
      const px = x(s.t);
      const py = Math.max(pad.t - 2, y(sum / n / ftp));
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Position cursor
  if (pos !== null && pos >= t0 && pos <= t1) {
    const cx = Math.round(x(pos)) + 0.5;
    ctx.strokeStyle = "#efe9e2";
    ctx.lineWidth = labels ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, labels ? pad.t - 8 : 0);
    ctx.lineTo(cx, base);
    ctx.stroke();
    if (labels) {
      ctx.fillStyle = "#efe9e2";
      ctx.beginPath();
      ctx.arc(cx, pad.t - 10, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Time axis
  if (labels) {
    const span = t1 - t0;
    const step = span > 3600 ? 600 : span > 1200 ? 300 : span > 400 ? 60 : 30;
    ctx.font = "600 11px Barlow, system-ui, sans-serif";
    ctx.fillStyle = "rgba(239,233,226,.5)";
    ctx.textAlign = "center";
    for (let t = Math.ceil(Math.max(0, t0) / step) * step; t <= Math.min(t1, timeline.duration); t += step) {
      ctx.fillText(fmtTime(t), x(t), height - 6);
    }
  }

  return {
    timeAt: (px) => t0 + ((px - pad.l) / W) * (t1 - t0),
    xAt: x,
    yAt: y,
    fracAt: (py) => ((base - py) / H) * yMaxF, // a height on the chart back to a fraction of FTP
  };
}

/**
 * A finished ride: the targets it asked for (zone-coloured), the power the
 * rider actually held (white) and heart rate (red, on its own scale).
 *   samples  [{ t, w, hr, cad, target }] one per riding second
 *   ftp      watts the ride was done at
 *   hover    sample index to mark (pointer), or null
 * Returns { indexAt(px) } for hit-testing the pointer.
 */
export function drawRide(canvas, { samples, ftp, hover = null }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const n = samples.length;
  if (!n) return { indexAt: () => null };
  const pad = { t: 18, b: 22 };
  const H = height - pad.t - pad.b;
  const base = pad.t + H;

  // Scale to the targets and to all but the very top of the power spikes.
  const powers = samples.map((s) => s.w || 0).sort((a, b) => a - b);
  const p99 = powers[Math.floor(n * 0.99)] || 0;
  const yMax = Math.max(ftp * 1.25, p99 * 1.08, ...samples.map((s) => (s.target || 0) * 1.12));
  const x = (i) => (i / n) * width;
  const y = (w) => base - (w / yMax) * H;

  // FTP line
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(239,233,226,.22)";
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y(ftp)) + 0.5);
  ctx.lineTo(width, Math.round(y(ftp)) + 0.5);
  ctx.stroke();
  ctx.restore();
  ctx.font = "600 11px Barlow, system-ui, sans-serif";
  ctx.fillStyle = "rgba(239,233,226,.45)";
  ctx.textAlign = "right";
  ctx.fillText(`FTP ${Math.round(ftp)}W`, width - 6, y(ftp) - 5);

  // One point per pixel column from here on, so a 90-minute ride doesn't draw
  // 5,400 sub-pixel slivers (which leave seams in ramps).
  const cols = Math.max(1, Math.floor(width));

  // Targets: whole-pixel columns, merged into one block per run of the same target.
  const targetAt = (c) => samples[Math.min(n - 1, Math.floor(((c + 0.5) / cols) * n))].target || 0;
  ctx.globalAlpha = 0.65;
  for (let c = 0; c < cols; ) {
    const tg = targetAt(c);
    let d = c;
    while (d + 1 < cols && targetAt(d + 1) === tg) d++;
    if (tg) {
      ctx.fillStyle = zoneFor(tg / ftp).color;
      const top = Math.round(y(tg));
      ctx.fillRect(Math.round((c / cols) * width), top, Math.round(((d + 1) / cols) * width) - Math.round((c / cols) * width), base - top);
    }
    c = d + 1;
  }
  ctx.globalAlpha = 1;

  const avgPer = (key) => {
    const out = [];
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c / cols) * n);
      const b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n));
      let sum = 0;
      let k = 0;
      for (let i = a; i < b && i < n; i++) {
        if (samples[i][key] != null) {
          sum += samples[i][key];
          k++;
        }
      }
      out.push(k ? sum / k : null);
    }
    return out;
  };
  const line = (values, yOf, color, widthPx) => {
    ctx.beginPath();
    let pen = false;
    values.forEach((v, c) => {
      if (v == null) return (pen = false);
      const px = ((c + 0.5) / cols) * width;
      if (pen) ctx.lineTo(px, yOf(v));
      else ctx.moveTo(px, yOf(v));
      pen = true;
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  const hrs = samples.map((s) => s.hr).filter((v) => v);
  if (hrs.length) {
    const lo = Math.min(...hrs) - 8;
    const hi = Math.max(...hrs) + 8;
    line(avgPer("hr"), (v) => base - ((v - lo) / (hi - lo)) * H * 0.92, "rgba(255,59,92,.9)", 1.5);
  }
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 4;
  line(avgPer("w"), (v) => Math.max(pad.t - 2, y(v)), "#efe9e2", 1.5);
  ctx.restore();

  if (hover !== null && hover >= 0 && hover < n) {
    const cx = Math.round(x(hover + 0.5)) + 0.5;
    ctx.strokeStyle = "rgba(239,233,226,.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, pad.t - 6);
    ctx.lineTo(cx, base);
    ctx.stroke();
  }

  // Time axis
  const span = n;
  const step = span > 7200 ? 1800 : span > 3600 ? 900 : span > 1200 ? 600 : span > 400 ? 120 : 30;
  ctx.font = "600 11px Barlow, system-ui, sans-serif";
  ctx.fillStyle = "rgba(239,233,226,.5)";
  ctx.textAlign = "center";
  for (let t = step; t < span; t += step) ctx.fillText(fmtTime(t), x(t), height - 6);

  return { indexAt: (px) => Math.max(0, Math.min(n - 1, Math.floor((px / width) * n))) };
}
