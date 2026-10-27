# Android plugin compute workers

Android embeds Python through Chaquopy. It cannot execute `sys.executable` as a
standalone interpreter. Compute actions therefore use two private Android
Service processes, `:baas_plugin_worker0` and `:baas_plugin_worker1`, with the
normal application UID. Each process initializes its own Chaquopy runtime and
executes exactly one action. This provides lifecycle isolation, **not a security
sandbox**: enabled external Python has the backend account's data access.

The backend loads `io.github.kiramei.baas_tauri.PluginWorkerBridge` with
`java.jclass`. Its static methods are retained in release builds by an explicit
R8 rule:

- `start(slot, jobDir, packageDir)` returns JSON `{slot, token, pid, group}`.
  It waits at most ten seconds for the native ready marker. `group == pid`.
- `status(slot, token, expectedPid)` returns whether that owned process is alive.
- `stop(slot, token, expectedPid)` checks ownership, kills the independent worker
  process group, and waits at most two seconds for exit before releasing the slot.
- `getApplicationContext()` uses the public Chaquopy platform API.

The backend supplies fresh app-private `files`, `cache` or `noBackupFiles`
directories. Paths must be canonical without symlink traversal. Each job has
`request.json` (at most 128 KiB) and a copy of the host's pure standard-library
`service/plugins/worker.py`. The APK helper imports only this host worker, never
the backend `service` package, and invokes `execute_request(packageDir, request)`.
It publishes UTF-8 `result.json` by atomic rename, bounded to 128 KiB including
the response envelope; the host worker limits the result itself to 64 KiB.

Native descriptors and Python stdout/stderr are discarded. Exceptions become
fixed error messages without paths, tracebacks or plugin data. Bytecode writes
are disabled before imports so plugin package digests remain stable. A killed
Service uses `START_NOT_STICKY` and cannot replay an action. The process exits
after publishing its result, cancellation or timeout. An independent Java
watchdog also exits if the owning backend PID/start time changes or the worker
exceeds its 135-second hard lifetime, including interpreter initialization.

Ownership checks combine slot/token, PID, UID, process command line, Linux start
time and independent process group. A stale cancellation cannot terminate a new
job in the same slot, or the main application/backend process. Trusted code can
still deliberately start detached processes; this mechanism is not a sandbox.

Portable helper checks:

```sh
python3 scripts/tests/test_android_plugin_worker.py
```

Native lifecycle tests must run against a separately identified test APK so the
installed application's data and game sessions are preserved.

The implementation follows the public APIs documented in
[Chaquopy startup](https://chaquo.com/chaquopy/doc/current/android.html#startup),
[Python.getPlatform](https://chaquo.com/chaquopy/doc/current/java/com/chaquo/python/Python.html),
[AndroidPlatform.getApplication](https://chaquo.com/chaquopy/doc/current/java/com/chaquo/python/android/AndroidPlatform.html),
[Android services](https://developer.android.com/develop/background-work/services),
and [Android Os](https://developer.android.com/reference/android/system/Os).
