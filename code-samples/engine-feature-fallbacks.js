/*
 * Paj Ntaub Watch - excerpt from engine/watch.html (the HTML5 Canvas clock engine)
 * Copyright (c) 2026 Yang Pao Thao. All rights reserved. Shared for portfolio review only.
 *
 * "Works on every phone": the same engine file runs inside the Android app (with a native
 * `WatchApp` bridge), inside the live wallpaper / screen saver, and in a plain browser preview
 * (no bridge at all). Every capability is feature-detected and has a fallback that always works:
 *
 *   battery      native bridge  ->  Web Battery Status API  ->  hidden
 *   keep awake   native flag    ->  Screen Wake Lock API    ->  normal screen timeout
 *   vibration    native waveform -> navigator.vibrate        ->  a CSS "shake" in the preview
 *   motion       app setting    ->  Android "remove animations" / prefers-reduced-motion
 *   steps/heart  Health Connect ->  phone step counter      ->  rings hidden when no data
 *   weather      fresh forecast ->  last forecast kept offline -> retry later
 *
 * Trimmed for reading: UI wiring, translations and the browser-only test paths are removed.
 */

const opt = { vibrate: true };            // settings, loaded from localStorage (a phone without it just uses defaults)
try { Object.assign(opt, JSON.parse(localStorage.getItem("pajNtaubWatch") || "{}")); } catch (e) {}

// --- Battery -----------------------------------------------------------------------------------
let battery = null, batInfo = {};
if (window.WatchApp) {
  const rd = () => {
    try {
      const b = WatchApp.battery(); battery = b >= 0 ? b : null;
      if (WatchApp.batteryInfo) batInfo = JSON.parse(WatchApp.batteryInfo());
    } catch (e) {}
  };
  rd(); setInterval(rd, 30000);
} else if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    const u = () => {
      battery = Math.round(b.level * 100);
      batInfo = { charging: b.charging,
                  toFullS: b.charging && isFinite(b.chargingTime) ? b.chargingTime : -1,
                  leftS: !b.charging && isFinite(b.dischargingTime) ? b.dischargingTime : -1 };
    };
    u(); b.onlevelchange = u; b.onchargingchange = u;
  }).catch(() => {});
}                                          // neither: battery stays null and its reading is simply not drawn

// --- Battery saver: halve the frame rate --------------------------------------------------------
// "auto" = the phone's own Battery Saver is on, or the battery is at 20% or less.
let phoneSaver = false;
function readPhoneSaver() { try { if (window.WatchApp && WatchApp.powerSave) phoneSaver = !!WatchApp.powerSave(); } catch (e) {} }
readPhoneSaver(); setInterval(readPhoneSaver, 60000);
function savingNow() {
  return opt.saver === "on" || (opt.saver === "auto" && (phoneSaver || (battery != null && battery <= 20)));
}

// --- Keep the screen awake ----------------------------------------------------------------------
let wakeLock = null;
function applyAwake() {
  try { if (window.WatchApp && WatchApp.keepAwake) { WatchApp.keepAwake(!!opt.awake); return; } } catch (e) {}
  try {                                                               // a browser: Screen Wake Lock, where there is one
    if (opt.awake && !document.hidden && navigator.wakeLock && !wakeLock)
      navigator.wakeLock.request("screen").then(l => { wakeLock = l; l.onrelease = () => { wakeLock = null; }; }).catch(() => {});
    else if (!opt.awake && wakeLock) { wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}
document.addEventListener("visibilitychange", applyAwake);

// --- Reduced motion -----------------------------------------------------------------------------
let sysReduce = false;
try {
  const mq = matchMedia("(prefers-reduced-motion: reduce)"); sysReduce = mq.matches;
  mq.addEventListener("change", e => { sysReduce = e.matches; });
} catch (e) {}
try { if (window.WatchApp && WatchApp.animationsOff) sysReduce = sysReduce || !!WatchApp.animationsOff(); } catch (e) {}
const reduceMotion = () => opt.motion === "reduced" || (opt.motion === "auto" && sysReduce);

// --- The hourly buzz ----------------------------------------------------------------------------
// Only while the clock is actually on screen, never in quiet hours, never from the wallpaper.
function buzz(pattern) {
  if (WALLPAPER) return;
  if (!opt.vibrate || document.hidden || inQuiet(new Date())) return;
  try {
    if (window.WatchApp) WatchApp.vibrate(pattern.join(","));
    else if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {}
  document.body.classList.remove("buzz"); void document.body.offsetWidth; document.body.classList.add("buzz");  // preview: shake
}

// --- Steps + heart rate -------------------------------------------------------------------------
// The bridge answers {steps, src, hr, hrAgo, hc}; polled at most every 2 s from the render loop.
// No bridge (browser) = null, and the step / heart rings are not drawn.
let healthAt = -1e9, healthCache = null;
function healthNow() {
  if (!(window.WatchApp && WatchApp.health)) return null;
  if (performance.now() - healthAt > 2000) {
    healthAt = performance.now();
    try { healthCache = JSON.parse(WatchApp.health()); }
    catch (e) { healthCache = { steps: -1, hr: -1, hc: "none" }; }
  }
  return healthCache;
}

// --- Weather with an offline fallback -----------------------------------------------------------
// The store app gets MET Norway forecasts through the native bridge (which caches per place and
// honours the API's Expires / If-Modified-Since rules - see WatchAppBridge.java). The engine never
// blanks the weather: if there is no answer, the last forecast stays on screen and it retries.
const MET_KIND = sym => /thunder/.test(sym) ? "storm" : /snow|sleet/.test(sym) ? "snow" : /rain/.test(sym) ? "rain"
  : /fog/.test(sym) ? "fog" : /cloudy/.test(sym) ? "clouds" : "clear";

async function updateWeather() {
  const at = await where();                                           // bridge location -> typed city -> null
  if (!at) {
    showLive(opt.live ? "(the last weather kept)" : "no location - tap Set city");
    if (!opt.live) setTimeout(updateWeather, 15000);
    return;
  }
  const st = sunTimes(at[0], at[1], new Date());                      // sunrise/sunset computed locally, no API needed

  if (window.WatchApp && WatchApp.metWeather) {
    try {
      const raw = WatchApp.metWeather(at[0].toFixed(2), at[1].toFixed(2));
      if (raw && raw.startsWith("{")) {
        const d = JSON.parse(raw), ts = d.properties.timeseries, nowMs = Date.now();
        const cur = ts.reduce((a, b) => Math.abs(Date.parse(b.time) - nowMs) < Math.abs(Date.parse(a.time) - nowMs) ? b : a);
        const det = cur.data.instant.details;
        const sym = ((cur.data.next_1_hours || cur.data.next_6_hours || {}).summary || {}).symbol_code || "clearsky_day";
        const temps = ts.filter(x => Date.parse(x.time) >= nowMs - 1800000).slice(0, 24).map(x => x.data.instant.details.air_temperature);
        opt.live = { kind: MET_KIND(sym), temp: det.air_temperature, wind: (det.wind_speed || 0) * 3.6,
                     windFrom: det.wind_from_direction, hi: Math.max(...temps), lo: Math.min(...temps),
                     sunrise: st ? st[0] : 6, sunset: st ? st[1] : 18, when: Date.now(), src: "met" };
        saveOpt(); showLive(); return;                                // saved = available offline next launch
      }
      if (raw === "pending") { showLive("(fetching...)"); setTimeout(updateWeather, 4000); return; }
    } catch (e) {}
    showLive(opt.live ? "(the last weather kept)" : "(weather: trying again soon)");
    setTimeout(updateWeather, 10 * 60000);
    return;
  }
  // (browser preview only: a separate free test source is used here; never shipped in the store build)
}

// The real wind drives the animation: falling leaves, rain, snow, clouds and fabric all drift
// with the live wind speed and direction.
function windNow() {
  const kmh = opt.live ? opt.live.wind : 5;
  const from = opt.live && opt.live.windFrom != null ? opt.live.windFrom : 270;
  let side = Math.sin((from + 180) * PI / 180);                      // east-west part of where it blows TO
  if (Math.abs(side) < 0.35) side = side < 0 ? -0.35 : 0.35;         // a north/south wind still shows a little
  const strength = Math.min(1.4, kmh / 40);
  return { kmh, from, strength, push: side * strength * 7 };
}
