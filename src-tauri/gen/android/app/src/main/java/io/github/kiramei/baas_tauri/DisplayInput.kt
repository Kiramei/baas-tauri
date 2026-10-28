package io.github.kiramei.baas_tauri

import android.os.SystemClock
import android.view.InputDevice
import android.view.InputEvent
import android.view.MotionEvent

/** Cached hidden APIs; no per-gesture process startup. Must run in the privileged process. */
object DisplayInput {
  /** Android 12 presents TYPE_PRESENTATION below app tasks; own a higher shield. */
  @Synchronized fun focusShieldWindow(context: android.content.Context, displayId: Int): Boolean {
    PrivilegedExecution.virtualDisplayId(displayId)
    check(android.os.Build.VERSION.SDK_INT in 31..32 && android.os.Process.myUid() == android.os.Process.SHELL_UID)
    val display = context.getSystemService(android.hardware.display.DisplayManager::class.java).getDisplay(displayId)
      ?: throw IllegalStateException("The game display disappeared before focus recovery")
    val shell = ShellFocusContext(context.createPackageContext(ShellProcessIdentity.PACKAGE_NAME,
      android.content.Context.CONTEXT_IGNORE_SECURITY))
    check(shell.packageManager.checkPermission("android.permission.INTERNAL_SYSTEM_WINDOW", "com.android.shell") ==
      android.content.pm.PackageManager.PERMISSION_GRANTED) { "Shizuku shell cannot create the game focus shield" }
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    val ready = java.util.concurrent.CompletableFuture<Unit>()
    val finished = java.util.concurrent.atomic.AtomicBoolean(false)
    val attached = java.util.concurrent.atomic.AtomicReference<Pair<android.view.WindowManager, android.view.View>?>()
    val handshake = PreviewFocusHandshake()
    handler.post {
      if (finished.get()) return@post
      try {
        prepareShellFocusIdentity(shell)
        val windowContext = ShellFocusContext(shell.createWindowContext(display, PrivilegedExecution.FOCUS_SHIELD_WINDOW_TYPE, null))
        val windows = windowContext.getSystemService(android.view.WindowManager::class.java)
        val view = android.view.View(windowContext).apply {
          setBackgroundColor(android.graphics.Color.TRANSPARENT)
          setOnTouchListener { _, event ->
            when (event.actionMasked) {
              MotionEvent.ACTION_DOWN -> handshake.recordDown()
              MotionEvent.ACTION_CANCEL -> handshake.recordCancel()
            }
            true
          }
        }
        view.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
          override fun onPreDraw(): Boolean {
            view.viewTreeObserver.removeOnPreDrawListener(this)
            view.postDelayed({ ready.complete(Unit) }, 300L)
            return true
          }
        })
        val attributes = android.view.WindowManager.LayoutParams(-1, -1,
          PrivilegedExecution.FOCUS_SHIELD_WINDOW_TYPE,
          android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
          android.graphics.PixelFormat.TRANSLUCENT).apply {
          title = PrivilegedExecution.FOCUS_SHIELD_TITLE
          packageName = "com.android.shell"
          gravity = android.view.Gravity.TOP or android.view.Gravity.LEFT
          windowAnimations = 0
        }
        windows.addView(view, attributes)
        attached.set(windows to view)
      } catch (error: Throwable) { ready.completeExceptionally(error) }
    }
    return try {
      ready.get(2500, java.util.concurrent.TimeUnit.MILLISECONDS)
      focusOwnedWindow(displayId, android.os.Process.SHELL_UID) && handshake.complete()
    } finally {
      finished.set(true)
      val removed = java.util.concurrent.CompletableFuture<Unit>()
      handler.post {
        try {
          attached.getAndSet(null)?.let { (windows, view) -> windows.removeViewImmediate(view) }
          removed.complete(Unit)
        } catch (error: Throwable) { removed.completeExceptionally(error) }
      }
      removed.get(2500, java.util.concurrent.TimeUnit.MILLISECONDS)
    }
  }

  /** Android 12 AppOps constructs SyncNotedAppOp from ActivityThread, not the View's Context. */
  private fun prepareShellFocusIdentity(shell: android.content.Context) {
    val processUid = android.os.Process.myUid()
    check(processUid == android.os.Process.SHELL_UID) {
      "Focus identity requires the shell process (uid=$processUid, host=${BuildConfig.APPLICATION_ID})"
    }
    val info = shell.applicationInfo
    check(info.uid == android.os.Process.SHELL_UID && info.packageName == ShellProcessIdentity.PACKAGE_NAME) {
      "Invalid focus ApplicationInfo (package=${info.packageName}, appUid=${info.uid}, uid=$processUid, host=${BuildConfig.APPLICATION_ID})"
    }
    val type = Class.forName("android.app.ActivityThread")
    val thread = checkNotNull(type.getMethod("currentActivityThread").invoke(null)) { "Shell ActivityThread is unavailable" }
    ShellProcessIdentity.prepare(thread, info, BuildConfig.APPLICATION_ID, processUid,
      { android.app.Instrumentation.newApplication(android.app.Application::class.java, shell) },
      { (it as android.app.Application).packageName })
    val preparedPackage = type.getMethod("currentPackageName").invoke(null)
    val preparedOpPackage = type.getMethod("currentOpPackageName").invoke(null)
    check(preparedPackage == ShellProcessIdentity.PACKAGE_NAME && preparedOpPackage == ShellProcessIdentity.PACKAGE_NAME) {
      "Shell framework identity is unavailable before focus recovery (package=$preparedPackage, opPackage=$preparedOpPackage, uid=$processUid, host=${BuildConfig.APPLICATION_ID})"
    }
  }

  private class ShellFocusContext(base: android.content.Context) : android.content.ContextWrapper(base) {
    override fun getPackageName(): String = ShellProcessIdentity.PACKAGE_NAME
    override fun getOpPackageName(): String = ShellProcessIdentity.PACKAGE_NAME
    override fun getApplicationContext(): android.content.Context = this
    override fun getAttributionSource(): android.content.AttributionSource =
      android.content.AttributionSource.Builder(android.os.Process.SHELL_UID)
        .setPackageName(ShellProcessIdentity.PACKAGE_NAME).build()
  }

  private val manager by lazy {
    Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null)
  }
  private val inject by lazy {
    manager.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType)
  }
  private val setDisplay by lazy {
    InputEvent::class.java.getDeclaredMethod("setDisplayId", Int::class.javaPrimitiveType).apply { isAccessible = true }
  }

  internal fun touchFrame(event: MotionEvent): OwnedDisplayTouch.Frame = OwnedDisplayTouch.Frame(
    event.action, event.downTime, event.eventTime,
    if (event.pointerCount in 1..10) List(event.pointerCount) { index ->
      OwnedDisplayTouch.Pointer(event.getPointerId(index), event.getX(index), event.getY(index))
    } else emptyList(),
  )

  /** One already-validated event, no sleep, process startup or whole-gesture lock. */
  internal fun touchEvent(displayId: Int, frame: OwnedDisplayTouch.Frame): Boolean {
    PrivilegedExecution.virtualDisplayId(displayId)
    val properties = frame.pointers.map { pointer -> MotionEvent.PointerProperties().apply {
      id = pointer.id
      toolType = MotionEvent.TOOL_TYPE_FINGER
    } }.toTypedArray()
    val coordinates = frame.pointers.map { pointer -> MotionEvent.PointerCoords().apply {
      x = pointer.x
      y = pointer.y
      pressure = if (frame.maskedAction == MotionEvent.ACTION_UP || frame.maskedAction == MotionEvent.ACTION_CANCEL) 0f else 1f
      size = 1f
    } }.toTypedArray()
    // Reconstruct, rather than forwarding unvalidated history/axes/source/deviceId.
    val event = MotionEvent.obtain(frame.downTime, frame.eventTime, frame.action, properties.size,
      properties, coordinates, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
    try {
      setDisplay.invoke(event, displayId)
      // A manual-to-automation handoff cannot start the next gesture until the
      // remembered manual CANCEL has completed. Other real-time events stay async.
      return inject.invoke(manager, event, if (frame.maskedAction == MotionEvent.ACTION_CANCEL) 2 else 0) as Boolean
    } finally { event.recycle() }
  }

  /** Only the BAAS-owned Presentation may receive this focus handshake. */
  @Synchronized fun focusOwnedWindow(displayId: Int, ownerUid: Int): Boolean {
    PrivilegedExecution.virtualDisplayId(displayId)
    require(ownerUid == android.os.Process.SHELL_UID || ownerUid >= 10000)
    val sdk = android.os.Build.VERSION.SDK_INT
    check(PrivilegedExecution.supportsPreviewFocus(sdk)) { "Preview focus requires Android 12 or newer" }
    val sendEvent: (InputEvent) -> Boolean = if (PrivilegedExecution.usesTargetedFocusInput(sdk)) {
      val binder = Class.forName("android.os.ServiceManager").getMethod("getService", String::class.java).invoke(null, "input")
      val input = Class.forName("android.hardware.input.IInputManager\$Stub")
        .getMethod("asInterface", android.os.IBinder::class.java).invoke(null, binder)
      val method = input.javaClass.getMethod("injectInputEventToTarget", InputEvent::class.java,
        Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
      val action: (InputEvent) -> Boolean = { event -> method.invoke(input, event, 2, ownerUid) as Boolean }
      action
    } else {
      // Android 12 cannot target a UID. Never send even DOWN unless the published
      // top input window is our full-display shield, which stays until CANCEL.
      check(ownerUid == android.os.Process.SHELL_UID) { "Android 12 focus requires the privileged BAAS shield" }
      val windowCheck = PrivilegedExecution.checkFocusInputWindow(inputWindowSnapshot(), displayId, ownerUid)
      check(windowCheck.verified) {
        // Keep raw dumps (which include other application/window names) private.
        // This is the exact snapshot checked before DOWN, while our shield lives.
        "The privileged BAAS focus shield is not the verified top input window " +
          "(display=$displayId ${windowCheck.diagnostic})"
      }
      val action: (InputEvent) -> Boolean = { event -> inject.invoke(manager, event, 2) as Boolean }
      action
    }
    val downAt = SystemClock.uptimeMillis()
    fun send(action: Int): Boolean {
      val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, 64f, 64f, 0)
      try {
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        setDisplay.invoke(event, displayId)
        return sendEvent(event)
      } finally { event.recycle() }
    }
    var cancelled = false
    try {
      if (!send(MotionEvent.ACTION_DOWN)) return false
      cancelled = send(MotionEvent.ACTION_CANCEL)
      return cancelled
    } finally { if (!cancelled) runCatching { send(MotionEvent.ACTION_CANCEL) } }
  }

  private fun inputWindowSnapshot(): String {
    val process = ProcessBuilder("/system/bin/dumpsys", "input").redirectErrorStream(true).start()
    val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    return try {
      val output = executor.submit<String> { process.inputStream.bufferedReader().use { it.readText() } }
      val snapshot = output.get(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
      val exited = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
      val exit = if (exited) process.exitValue() else null
      if (exit == 0) snapshot else {
        android.util.Log.w("BaasNativePreview", "Input dump subprocess exited=$exited exitCode=$exit bytes=${snapshot.length}; using input Binder dump")
        inputBinderSnapshot()
      }
    } catch (error: Exception) {
      android.util.Log.w("BaasNativePreview", "Input dump subprocess failed: ${error.javaClass.simpleName}; using input Binder dump")
      inputBinderSnapshot()
    } finally {
      process.destroy()
      executor.shutdownNow()
    }
  }

  private fun inputBinderSnapshot(): String {
    val binder = Class.forName("android.os.ServiceManager").getMethod("getService", String::class.java)
      .invoke(null, "input") as android.os.IBinder
    val pipe = android.os.ParcelFileDescriptor.createPipe()
    val executor = java.util.concurrent.Executors.newFixedThreadPool(2)
    return try {
      val reader = executor.submit<String> {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(pipe[0]).bufferedReader().use { it.readText() }
      }
      val writer = executor.submit { pipe[1].use { binder.dump(it.fileDescriptor, emptyArray()) } }
      writer.get(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
      reader.get(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
    } finally {
      pipe.forEach { runCatching { it.close() } }
      executor.shutdownNow()
    }
  }

  @Synchronized fun key(displayId: Int, keyCode: Int): Boolean {
    if (displayId < 0) return false
    val now = SystemClock.uptimeMillis()
    for (action in listOf(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.ACTION_UP)) {
      val event = android.view.KeyEvent(now, SystemClock.uptimeMillis(), action, keyCode, 0)
      setDisplay.invoke(event, displayId)
      if (!(inject.invoke(manager, event, if (action == android.view.KeyEvent.ACTION_DOWN) 2 else 0) as Boolean)) return false
    }
    return true
  }

  @Synchronized fun gesture(displayId: Int, x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
    require(displayId >= 0)
    val downAt = SystemClock.uptimeMillis()
    fun send(action: Int, x: Float, y: Float, mode: Int): Boolean {
      val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
      val position = MotionEvent.PointerCoords().apply {
        this.x = x; this.y = y; size = 1f
        pressure = if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) 0f else 1f
      }
      val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, 1,
        arrayOf(pointer), arrayOf(position), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
      try {
        setDisplay.invoke(event, displayId)
        return inject.invoke(manager, event, mode) as Boolean
      } finally { event.recycle() }
    }
    if (!send(MotionEvent.ACTION_DOWN, x1.toFloat(), y1.toFloat(), 2)) return false
    var released = false
    try {
      val duration = durationMs.coerceIn(1, 10_000)
      if (x1 != x2 || y1 != y2 || duration > 250) {
        val start = SystemClock.uptimeMillis()
        do {
          val elapsed = (SystemClock.uptimeMillis() - start).coerceAtMost(duration.toLong())
          val fraction = elapsed.toFloat() / duration
          if (!send(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * fraction, y1 + (y2 - y1) * fraction, 0)) return false
          if (elapsed >= duration) break
          SystemClock.sleep(8)
        } while (true)
      } else {
        SystemClock.sleep(duration.toLong())
      }
      released = send(MotionEvent.ACTION_UP, x2.toFloat(), y2.toFloat(), 0)
      return released
    } finally {
      if (!released) runCatching { send(MotionEvent.ACTION_CANCEL, x2.toFloat(), y2.toFloat(), 0) }
    }
  }

  @Synchronized fun pinch(displayId: Int, width: Int, height: Int, inward: Boolean, percent: Int, durationMs: Int): Boolean {
    require(displayId >= 0 && width > 0 && height > 0)
    val downAt = SystemClock.uptimeMillis()
    val duration = durationMs.coerceIn(1, 10_000)
    val outer = width * 0.3f
    val inner = outer * (1f - percent.coerceIn(1, 100) / 100f).coerceAtLeast(0.02f)
    val start = if (inward) outer else inner
    val end = if (inward) inner else outer
    fun send(action: Int, spread: Float, count: Int, mode: Int): Boolean {
      val properties = Array(count) { index -> MotionEvent.PointerProperties().apply {
        id = index; toolType = MotionEvent.TOOL_TYPE_FINGER
      } }
      val coordinates = Array(count) { index -> MotionEvent.PointerCoords().apply {
        x = width / 2f + (if (index == 0) -spread else spread)
        y = height / 2f; pressure = 1f; size = 1f
      } }
      val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, count,
        properties, coordinates, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
      try {
        setDisplay.invoke(event, displayId)
        return inject.invoke(manager, event, mode) as Boolean
      } finally { event.recycle() }
    }
    if (!send(MotionEvent.ACTION_DOWN, start, 1, 2)) return false
    var released = false
    try {
      val secondDown = MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
      if (!send(secondDown, start, 2, 2)) return false
      val started = SystemClock.uptimeMillis()
      do {
        val elapsed = (SystemClock.uptimeMillis() - started).coerceAtMost(duration.toLong())
        val spread = start + (end - start) * elapsed.toFloat() / duration
        if (!send(MotionEvent.ACTION_MOVE, spread, 2, 0)) return false
        if (elapsed >= duration) break
        SystemClock.sleep(8)
      } while (true)
      val secondUp = MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
      if (!send(secondUp, end, 2, 0)) return false
      released = send(MotionEvent.ACTION_UP, end, 1, 0)
      return released
    } finally {
      if (!released) runCatching { send(MotionEvent.ACTION_CANCEL, end, 2, 0) }
    }
  }
}
