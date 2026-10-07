// CHART — the scrolling workout profile, drawn on a canvas.
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

export function peakFraction(timeline) {
  return timeline.segments.reduce((m, s) => Math.max(m, s.from, s.to), 1);
}

/**
 * opts:
 *   timeline   expanded workout
 *   ftp        watts
 *   t0, t1     visible window in workout seconds (default: whole workout)
 *   position   cursor in workout seconds (null = no cursor, nothing "done")
 *   samples    [{ t, w }] actual power, workout seconds
 *   labels     draw target labels + time axis
 *   selected   block index to highlight (builder)
 *   hover      segment index to outline (details tooltip)
 *
 * Returns the geometry so callers can hit-test the pointer against bars.
 */
export function drawWorkout(canvas, opts) {
  const { ctx, width, height } = fitCanvas(canvas);
  const { timeline, ftp, labels = false, samples = [], selected = null, hover = null } = opts;
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? Math.max(1, timeline.duration);
  const pos = opts.position ?? null;

  ctx.clearRect(0, 0, width, height);
  const pad = labels ? { l: 0, r: 0, t: 26, b: 22 } : { l: 0, r: 0, t: 3, b: 0 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const base = pad.t + H;
  const yMaxF = Math.max(peakFraction(timeline) * 1.12, 1.2);
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * W;
  const y = (f) => base - (f / yMaxF) * H;

  // FTP reference line
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, Math.round(y(1)) + 0.5);
  ctx.lineTo(pad.l + W, Math.round(y(1)) + 0.5);
  ctx.stroke();
  ctx.restore();
  if (labels) {
    ctx.font = "600 11px Barlow, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.45)";
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
        ctx.strokeStyle = "rgba(255,255,255,.18)";
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
      ctx.fillStyle = "#0b0a1a";
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
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Target labels over upcoming segments that have room for them.
  if (labels) {
    ctx.font = "700 12px Barlow, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const s of timeline.segments) {
      const xa = Math.max(x(s.start), cut);
      const xb = x(s.start + s.duration);
      if (xb - xa < 48 || xb < t0 || xa > pad.l + W) continue;
      const peak = Math.max(s.from, s.to);
      const txt = s.free
        ? "FREE"
        : s.from === s.to
          ? `${Math.round(s.from * ftp)}W`
          : `${Math.round(s.from * ftp)}→${Math.round(s.to * ftp)}W`;
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillText(txt, (xa + xb) / 2, y(s.free ? 0.5 : peak) - 7);
    }
  }

  // Actual power trace (3 s rolling average so it isn't a scribble).
  if (samples.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, W, height);
    ctx.clip();
    ctx.lineWidth = labels ? 2 : 1.25;
    ctx.strokeStyle = "#fff";
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
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = labels ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, labels ? pad.t - 8 : 0);
    ctx.lineTo(cx, base);
    ctx.stroke();
    if (labels) {
      ctx.fillStyle = "#fff";
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
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.textAlign = "center";
    for (let t = Math.ceil(Math.max(0, t0) / step) * step; t <= Math.min(t1, timeline.duration); t += step) {
      ctx.fillText(fmtTime(t), x(t), height - 6);
    }
  }

  return {
    timeAt: (px) => t0 + ((px - pad.l) / W) * (t1 - t0),
    xAt: x,
    yAt: y,
  };
}
