# Native Device Benchmark Target

This Android application is a controlled measurement target, not the BAAS app
or a game. It has a separate application ID, no network permission, no backend,
no accounts and no scheduler. It continuously draws a frame barcode and counts
completed touch inputs inside the green region.

Build with Gradle 8.14.3, Android Gradle Plugin 8.11.0, JDK 17 and Android SDK 36:

```powershell
gradle -p docs/benchmarks/device-target assembleDebug
```

The validation run reused the Gradle wrapper from the separate Android validation
checkout, with `-p` pointing here. It did not change that checkout. Build products,
Gradle caches and local SDK configuration stay ignored. The source manifest,
Java files and resulting APK SHA-256 accompany the measurement record.

## Surface

The landscape surface is 1280x720, with pixel-coordinate calibration patches at
the top. Four 16-bit barcodes encode state token, input count, rendered-frame
count and the last input duration. A static texture pane begins at `(900, 350)`.
The quality comparison uses its 260x210 region beginning at `(940, 390)`.

Scene 0 is mostly static except for frame-counter updates. Scene 1 translates a
deterministic four-pixel-tiled texture behind the controls; only uncovered
background regions move. It does not represent a fully animated game scene.

Only `ACTION_UP` following a down inside `(64,350)-(1216,630)` increments the input
count. Duration is the Android event-time difference; travel is the integer
distance between first down and final up. Intermediate trajectory shape and game
success are not validated. No input is passed through to other applications.

The explicit broadcast receiver accepts `token`, `scene` and `reset` extras and
writes a JSON snapshot to this app's private `files/state.json`. The harness
reads that file with `run-as` outside timed calls. It contains only these test
counters and geometry. It is not an authentication token or a production API.

## Device Ownership

`docs/scripts/measure-device.py` requires a verified disposable BAAS Android demo
and its CDP connection before temporarily stopping that owned app. It refuses
existing automation processes/sockets, checks APK identities and autostart,
preserves shared screenshot/jar files, starts a uniquely named non-daemon
atx-agent and reuses installed instrumentation APKs without reinstalling them.

The bundled production initializer selects the Linux 386 atx-agent for x86_64.
The staged amd64 binary requires a glibc loader unavailable on this Android
image. A standard agent with the instrumentation service running is used for
the published comparison. Do not connect stock uiautomator2 to the BAAS Android
bridge at the same port or bypass that bridge's authentication.

Cleanup targets only this run's connections and verified processes. The installed
debug instrumentation process is stopped under its own UID with `run-as`; its
APK is retained and hashed before/after. The primary x86 demo is restarted and
its idle/authenticated state and task selections are verified. An inactive owned
ARM validation clone, if stopped, is not restarted alongside the x86 backend
because they share service ports. No unrelated app package is stopped.

Raw diagnostics remain under ignored `.cache/`. Publication excludes device
serials, host paths, process/socket identifiers and agent logs.
