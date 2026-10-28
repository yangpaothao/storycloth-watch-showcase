/*
 * Paj Ntaub Watch - excerpt from android/app/.../MainActivity.java (the Android host app)
 * Copyright (c) 2026 Yang Pao Thao. All rights reserved. Shared for portfolio review only.
 *
 * What this shows
 *   The phone app is a full-screen WebView running the shared canvas engine (assets/watch.html).
 *   Native capabilities are exposed to it through one object, `WatchApp`, added with
 *   addJavascriptInterface. The engine feature-detects every method (`window.WatchApp &&
 *   WatchApp.health`), so the same HTML also runs in a browser with no bridge at all.
 *
 *   Design rules for the bridge:
 *     - Every call returns immediately (JS calls arrive on a WebView binder thread). Slow work,
 *       like a network fetch, runs in the background and the engine polls again ("pending").
 *     - Plain strings / numbers / JSON strings only - no objects cross the boundary.
 *     - Never throw into JavaScript: failures become a sentinel value (-1, "", "denied", "{}").
 *
 * Trimmed: about 50 bridge methods exist (alarms, calendar, reminders, backup, share, wallpaper,
 * in-app update, purchase unlock, ...). Only a representative handful are shown. The contact
 * string sent to the weather API is replaced with a placeholder.
 */
package com.pajntaub.watch;

public class MainActivity extends Activity implements SensorEventListener {

    // Weather provider terms require identifying the app and a contact (placeholder here).
    static final String MET_USER_AGENT = "<AppName>/<version> <website> <contact>";

    private final java.util.Set<String> fetchingKeys = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private long phoneSteps = -1, hcSteps = -1;   // step counter sensor / Health Connect (filled elsewhere)
    private int heartBpm = -1; private long heartAt;
    private boolean hcSteps_ok, hcHeart_ok, askedSteps, asking;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView web = new WebView(this);
        // ... WebSettings: JavaScript + DOM storage on, file access limited to the bundled assets ...
        web.addJavascriptInterface(new Bridge(), "WatchApp");
        setContentView(web);
        web.loadUrl("file:///android_asset/watch.html");
    }

    private class Bridge {

        /** A vibration pattern "on,off,on,..." in milliseconds (the hourly buzz). */
        @JavascriptInterface
        public void vibrate(String pattern) {
            try {
                String[] parts = pattern.split(",");
                long[] wave = new long[parts.length + 1];
                wave[0] = 0;                                              // start at once
                for (int i = 0; i < parts.length; i++) wave[i + 1] = Long.parseLong(parts[i].trim());
                Vibrator v = getSystemService(Vibrator.class);
                if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createWaveform(wave, -1));
            } catch (Exception ignored) {                                 // a bad pattern or no vibrator: do nothing
            }
        }

        /** Battery level 0-100, or -1 when unknown. */
        @JavascriptInterface
        public int battery() {
            Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b == null) return -1;
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            return level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1;
        }

        /** True while the system Battery Saver is on (the engine then renders at half frame rate). */
        @JavascriptInterface
        public boolean powerSave() {
            android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
            return pm != null && pm.isPowerSaveMode();
        }

        /**
         * The forecast for lat,lon (rounded to 2 decimals, so a coarse location is enough):
         *   - returns the cached JSON while it is still valid (before the server's Expires time);
         *   - otherwise starts ONE background fetch per place and returns the old copy, or "pending";
         *   - sends If-Modified-Since, so an unchanged forecast costs a 304 and no body;
         *   - on HTTP 429 backs off for an hour.
         * One cache per place (the user's own place + saved "My places"), so switching places is instant
         * and the last forecast survives being offline.
         */
        @JavascriptInterface
        public String metWeather(String lat, String lon) {
            if (MET_USER_AGENT.isEmpty()) return "nocontact";
            String key = lat + "," + lon;
            android.content.SharedPreferences sp = getSharedPreferences(
                    "met_" + key.replace(',', '_').replace('-', 'm').replace('.', 'd'), MODE_PRIVATE);
            String body = sp.getString("body", ""), forKey = sp.getString("key", "");
            long expires = sp.getLong("expires", 0);
            boolean valid = key.equals(forKey) && System.currentTimeMillis() < expires && !body.isEmpty();

            if (!valid && fetchingKeys.add(key)) {                        // add() == false: a fetch is already running
                final String lastMod = key.equals(forKey) ? sp.getString("lastmod", "") : "";
                new Thread(() -> {
                    try {
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(
                                "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + lat + "&lon=" + lon).openConnection();
                        c.setRequestProperty("User-Agent", MET_USER_AGENT);
                        if (!lastMod.isEmpty()) c.setRequestProperty("If-Modified-Since", lastMod);
                        c.setConnectTimeout(10000); c.setReadTimeout(15000);
                        int code = c.getResponseCode();
                        long exp = c.getExpiration() > 0 ? c.getExpiration() : System.currentTimeMillis() + 30 * 60 * 1000;
                        android.content.SharedPreferences.Editor ed = sp.edit().putString("key", key).putLong("expires", exp);
                        if (code == 200) {
                            java.io.InputStream in = c.getInputStream();
                            String txt = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                            in.close();
                            String lm = c.getHeaderField("Last-Modified");
                            ed.putString("body", txt).putString("lastmod", lm == null ? "" : lm);
                        } else if (code == 429) {
                            ed.putLong("expires", System.currentTimeMillis() + 60 * 60 * 1000);   // told to slow down
                        }                                                                        // 304: keep the body
                        ed.apply();
                    } catch (Exception ignored) {                         // offline: the old copy stays valid for the engine
                    } finally {
                        fetchingKeys.remove(key);
                    }
                }).start();
            }
            return body.isEmpty() || !key.equals(forKey) ? "pending" : body;
        }

        /**
         * Steps + heart rate as JSON: {steps (-1 = unknown), src ("health" | "phone" | ""), hr (-1 = none),
         * hrAgo (seconds), hc ("on" | "off" = installed but not allowed | "none" = not on this phone)}.
         * Takes the larger of the phone's own step counter and Health Connect (a watch may have counted
         * steps the phone didn't). Asks once for the activity-recognition permission.
         */
        @JavascriptInterface
        public String health() {
            if (!stepsAllowed() && !askedSteps && !asking && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                askedSteps = true; asking = true;
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.ACTIVITY_RECOGNITION}, REQ_STEPS));
            }
            boolean hc = HealthReader.available(MainActivity.this);
            long steps = hcSteps >= 0 ? Math.max(hcSteps, phoneSteps) : phoneSteps;
            String src = hcSteps >= 0 && hcSteps >= phoneSteps ? "health" : phoneSteps >= 0 ? "phone" : "";
            long ago = heartBpm > 0 ? (System.currentTimeMillis() - heartAt) / 1000 : -1;
            return "{\"steps\":" + steps + ",\"src\":\"" + src + "\",\"hr\":" + heartBpm + ",\"hrAgo\":" + ago
                    + ",\"hc\":\"" + (!hc ? "none" : hcSteps_ok || hcHeart_ok ? "on" : "off") + "\"}";
        }
    }
}
