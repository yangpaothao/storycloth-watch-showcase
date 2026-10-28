/*
 * Paj Ntaub Watch - excerpt from engine/watch.html (the HTML5 Canvas clock engine)
 * Copyright (c) 2026 Yang Pao Thao. All rights reserved. Shared for portfolio review only.
 *
 * What this shows
 *   1. One coordinate system for every screen: everything is drawn in a 1000 x 1000 "face space".
 *      A round/square screen (a watch) draws the circle; a tall/wide screen (a phone) draws a
 *      rectangle, and anything that goes "round the clock" is mapped onto the rectangle's edge.
 *   2. Embroidery lit by the REAL sun or moon: the sun/moon's altitude + azimuth for the user's
 *      location decide which way the stitched bands cast their shadow, how long and how dark.
 *   3. Cheap drawing on purpose: plain fills and strokes, no canvas filters and no gradients in the
 *      hot path, so the same code runs at 60 fps on low-end phones and in the watch preview.
 *
 * Trimmed for reading: settings, skins and helpers defined elsewhere in the engine
 * (opt, ctx, mixC, skyUpdate, skyCache, headingShown, shown) are referenced but not repeated.
 */

// ---------------------------------------------------------------------------------------------
// 1. Geometry: one face space, two shapes
// ---------------------------------------------------------------------------------------------
const C = 500;                                                       // centre of the 1000 x 1000 face
const PI = Math.PI;

// A point at `deg` degrees clockwise from 12 o'clock, `r` units from the centre.
const pol = (deg, r) => [C + Math.sin(deg * PI / 180) * r, C - Math.cos(deg * PI / 180) * r];

// Phone vs watch is decided by the screen itself, not by a build flag: an aspect ratio above
// 1.22 is a phone or tablet (rectangle layout); round or square is a watch (circle layout).
// The phone can still opt into the round look from Settings.
const phoneScreen = () => !WATCH_ONLY &&
  Math.max(innerWidth, innerHeight) / Math.max(1, Math.min(innerWidth, innerHeight)) > 1.22;
const rectMode = () => opt.phoneShape !== "round" && phoneScreen();

// In rectangle mode the SHORT side is always 1000 units, so turning the phone keeps every
// element at its real size. RL/RT = left/top, RW/RH = width/height (updated every frame).
const RE = 513;                                                      // radius of the outer lane
let RH = 1000, RT = 0, RW = 1000, RL = 0;

// Walk the rectangle's perimeter: `deg` (0..360, from top-middle, clockwise) becomes a distance
// along the edge, inset by q. Returns [x, y, heading of that edge].
function rectEdge(q, deg) {
  const x0 = RL + q, y0 = RT + q, x1 = RL + RW - q, y1 = RT + RH - q;
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2, P = 4 * (hw + hh);
  let s = ((deg / 360) % 1 + 1) % 1 * P;
  //            [segment length, start x, start y, dx, dy, heading]
  const seg = [[hw, C, y0, 1, 0, 0], [2 * hh, x1, y0, 0, 1, 90], [2 * hw, x1, y1, -1, 0, 180],
               [2 * hh, x0, y1, 0, -1, 270], [hw, x0, y0, 1, 0, 360]];
  for (const [L, ax, ay, dx, dy, hd] of seg) { if (s <= L) return [ax + dx * s, ay + dy * s, hd]; s -= L; }
  return [C, y0, 0];
}

// "Round the clock" for either shape: the same call places race animals, hour signs and the
// season's drifting leaves on the watch's circle OR along the phone's rectangular border.
const rpol = (deg, r) => {
  if (!rectMode()) return pol(deg, r);
  const [x, y] = rectEdge(RE - r, deg);
  return [x, y];
};

// ---------------------------------------------------------------------------------------------
// 2. Light from the real sun / moon
// ---------------------------------------------------------------------------------------------
// LIGHT = which way shadows fall on the dial (dx, dy), how long (len: long when the light is low,
// short at noon) and how dark (mult: strong sun, soft moon scaled by its phase).
let LIGHT = { dx: 0.55, dy: 0.83, len: 1, mult: 1, src: "none" };

function updateLight(d) {
  skyUpdate(d);                                                      // cached sun/moon alt-az for the user's place
  const pick = (alt, az, mult) => {
    const a = (az - headingShown) * PI / 180;                        // turns with the phone's compass heading
    const lx = Math.sin(a), ly = -Math.cos(a);
    const len = Math.max(0.45, Math.min(2.2, 0.6 / Math.tan(Math.max(4, alt) * PI / 180)));
    return { dx: -lx, dy: -ly, len, mult };
  };
  const [sAlt, sAz] = skyCache.sun, [mAlt, mAz] = skyCache.moon;

  if (!shown("shadows")) LIGHT = { dx: 0.55, dy: 0.83, len: 1, mult: 1, src: "off" };
  else if (sAlt > 0) {                                               // daytime: stronger as the sun climbs (full by ~40 degrees)
    const sk = Math.pow(Math.min(1, sAlt / 40), 0.8);
    LIGHT = { ...pick(sAlt, sAz, 0.35 + 1.3 * sk), src: "sun", sk };
  } else if (mAlt > 0) {                                             // night: the moon, fainter for a thin crescent
    LIGHT = { ...pick(mAlt, mAz, (0.45 + 0.45 * skyCache.phase[0]) * Math.min(1, mAlt / 8) + 0.35), src: "moon" };
  } else {
    LIGHT = { dx: 0.55, dy: 0.83, len: 0.55, mult: 0.6, src: "none" }; // neither up: a faint default shadow
  }
  const E = eclipseNow(d);                                           // a solar eclipse fades the shadows too
  if (E && LIGHT.src === "sun") LIGHT = { ...LIGHT, mult: LIGHT.mult * (1 - Math.pow(E.cov, 1.4)) };
}

// A "raised appliqué" band = 7 stroked layers of the same path: two offset shadow strokes, the
// three thread colours, then a sheen facing the light and a crease facing away. No blur needed.
function litBand(w, cols) {
  const L = LIGHT, o = k => [L.dx * k * L.len, L.dy * k * L.len];
  const a = v => `rgba(0,0,0,${Math.min(0.6, v * L.mult).toFixed(3)})`;
  const [o1x, o1y] = o(10.8 * w), [o2x, o2y] = o(6.1 * w);
  const sx = -L.dx * 3 * w * 1.41, sy = -L.dy * 3 * w * 1.41;
  return [[26 * w, a(0.16), o1x, o1y], [21 * w, a(0.34), o2x, o2y],                 // soft shadow
          [17 * w, cols[0], 0, 0], [12 * w, cols[1], 0, 0], [7 * w, cols[2], 0, 0], // red / white / blue thread
          [3 * w, "rgba(255,255,255,.62)", sx, sy], [3 * w, "rgba(0,0,0,.38)", -sx, -sy]]; // sheen + crease
}

// The paj ntaub snail-shell spiral (qwj): an Archimedean spiral as a 70-segment polyline.
function spiralPath(cx, cy, r0, r1, turns, a0, dir) {
  ctx.beginPath(); const N = 70;
  for (let i = 0; i <= N; i++) {
    const u = i / N, a = a0 + dir * u * turns * 2 * PI, r = r0 + (r1 - r0) * u;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
}

// Usage inside the spiral renderer: draw ALL spirals layer by layer (all shadows, then all red,
// then all white ...) so overlapping spirals never show seams.
function drawSpiralBands(shells, cols) {
  const SH = litBand(1, cols);
  for (const [W0, colour, OX, OY] of SH) {
    ctx.save(); ctx.translate(OX, OY); ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const Q of shells) {
      spiralPath(Q.x, Q.y, Q.r0, Q.r1, Q.turns, Q.a0, Q.dir);
      ctx.strokeStyle = colour; ctx.lineWidth = W0 * Q.k; ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// 3. A 3D-looking embroidered triangle ("tooth"), lit by LIGHT
// ---------------------------------------------------------------------------------------------
// Thousands of these are drawn per frame along the spirals and borders, so the shades are
// computed once per colour and cached; the tooth itself is three plain triangle fills.
const TOOTH_SH = new Map();
const toothShade = (col, k) => {
  const key = col + k; let v = TOOTH_SH.get(key);
  if (v == null) {
    try { v = mixC(col, k > 0 ? "#ffffff" : "#000000", Math.abs(k)); } catch (e) { v = col; }
    TOOTH_SH.set(key, v);
  }
  return v;
};

// base centre (bx, by), pointing along unit vector (dx, dy), len long, half wide each side
function tooth(bx, by, dx, dy, len, half, col) {
  const tx = -dy, ty = dx;
  const ax = bx - tx * half, ay = by - ty * half, cx2 = bx + tx * half, cy2 = by + ty * half;
  const px = bx + dx * len, py = by + dy * len;
  const L = LIGHT, sz = Math.max(0.7, Math.min(len, half * 2) * 0.11) * L.len;
  const ox = L.dx * sz, oy = L.dy * sz;
  const plusLit = tx * L.dx + ty * L.dy < 0;                          // which half faces the light

  ctx.fillStyle = "rgba(0,0,0," + Math.min(0.5, 0.28 * L.mult).toFixed(3) + ")";   // its shadow
  ctx.beginPath(); ctx.moveTo(ax + ox, ay + oy); ctx.lineTo(px + ox, py + oy); ctx.lineTo(cx2 + ox, cy2 + oy); ctx.closePath(); ctx.fill();

  ctx.fillStyle = toothShade(col, 0.2);                               // the whole tooth, lit
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(px, py); ctx.lineTo(cx2, cy2); ctx.closePath(); ctx.fill();

  ctx.fillStyle = toothShade(col, -0.26);                             // the half away from the light, darker
  ctx.beginPath(); if (plusLit) ctx.moveTo(ax, ay); else ctx.moveTo(cx2, cy2);
  ctx.lineTo(px, py); ctx.lineTo(bx, by); ctx.closePath(); ctx.fill();
}
