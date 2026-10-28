# Code samples

Four short excerpts from the private Paj Ntaub Watch codebase. I trimmed each one down to the interesting part, so they show how the app is built but won't compile on their own. Helpers defined elsewhere are referenced and not repeated. Nothing here includes keys, signing setup, server addresses or billing logic.

| File | From | What it shows |
|---|---|---|
| [`engine-geometry-and-lighting.js`](engine-geometry-and-lighting.js) | `engine/watch.html` (HTML5 Canvas) | One 1000 x 1000 face space for every screen: the circle on a watch, and the same "round the clock" positions mapped onto the rectangle on a phone. Stitched spirals and triangles take their shadows from the real sun or moon. Drawing uses plain fills only, so it stays fast on low-end phones. |
| [`engine-feature-fallbacks.js`](engine-feature-fallbacks.js) | `engine/watch.html` | The "works on every phone" rule in code. Battery, wake lock, vibration, reduced motion, steps and heart rate, and weather each try the native bridge first, then a Web API, then a safe default. The last forecast is kept for offline use. |
| [`WatchAppBridge.java`](WatchAppBridge.java) | `android/app/.../MainActivity.java` | The `WatchApp` JavaScript bridge between the WebView engine and Android. Calls never block or throw. Each place gets its own forecast cache that follows the weather API's `Expires` and `If-Modified-Since` rules and backs off on 429. Steps are merged from the phone's step counter and Health Connect. |
| [`SkyComplication.kt`](SkyComplication.kt) | `android/wear/.../Sky.kt`, `SkyComplicationService.kt` | Watch Face Format faces can't run code. Kotlin works out where the sun and moon are and packs both positions into one complication value; the face's XML expressions decode it. The same slot's MAX picks the skin, so a skin change is a data update and the watch doesn't install a new face. |

Copyright © 2026 Yang Pao Thao. All rights reserved. Shared for portfolio review only. See [`../LICENSE-NOTICE.md`](../LICENSE-NOTICE.md).
