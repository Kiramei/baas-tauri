package io.github.kiramei.baas_tauri

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference

@TauriPlugin
class BackendServicePlugin(initialActivity: Activity) : Plugin(initialActivity) {
  companion object {
    // Tauri keeps the plugin across Activity relaunches. Keep its native lanes
    // across them too: recreating UI cannot bypass an already-running Binder call.
    private val commands = BoundedNativeWorker("baas-native-command", 8)
    private val previewQueries = BoundedNativeWorker("baas-native-preview-query", 0)
    private val ui = android.os.Handler(android.os.Looper.getMainLooper())
    private var activeActivity: WeakReference<Activity>? = null
    private var activePlugin: WeakReference<BackendServicePlugin>? = null
    private val sessionOperations: NativeSessionOperations = NativeSessionOperations {
      activeActivity?.get()?.let { activePlugin?.get()?.sessions?.current(it)?.nativeSessionChanged() }
    }

    internal fun activityCreated(activity: Activity) {
      activeActivity = WeakReference(activity)
      activePlugin?.get()?.sessions?.attach(activity)
    }

    internal fun activityResumed(activity: Activity) {
      activityCreated(activity)
      activePlugin?.get()?.sessions?.current(activity)?.onResume()
    }

    internal fun activityPaused(activity: Activity) {
      activePlugin?.get()?.sessions?.current(activity)?.onPause()
    }

    internal fun activityDestroyed(activity: Activity) {
      // A late destroy from the previous Activity cannot destroy its successor.
      activePlugin?.get()?.sessions?.detach(activity)
      if (activeActivity?.get() === activity) activeActivity = null
    }
  }

  private val sessions: ActivitySessionSlot<Activity, BackendActivitySession> = ActivitySessionSlot {
    BackendActivitySession(it, commands, previewQueries, sessionOperations)
  }

  init {
    activePlugin?.get()?.sessions?.clear()
    activePlugin = WeakReference(this)
    val owner = activeActivity?.get()?.takeUnless { it.isDestroyed } ?: initialActivity
    if (!owner.isDestroyed) {
      activeActivity = WeakReference(owner)
      sessions.attach(owner)
    }
  }

  private fun dispatch(invoke: Invoke, command: (BackendActivitySession) -> Unit) {
    val request = sessions.capture()
    ui.post {
      if (activePlugin?.get() !== this) {
        invoke.reject("Android plugin was superseded"); return@post
      }
      if (request == null || !sessions.isCurrent(request)) {
        invoke.reject("Android activity changed before the command could run"); return@post
      }
      val owner = request.owner
      if (activeActivity?.get() !== owner || owner.isDestroyed || owner.isFinishing) {
        invoke.reject("No live Android activity is available"); return@post
      }
      try { command(sessions.attach(owner)) }
      catch (error: Exception) { invoke.reject(error.message, error) }
    }
  }

  override fun onPause() { activeActivity?.get()?.let { activityPaused(it) } }
  override fun onResume() { activeActivity?.get()?.let { activityResumed(it) } }
  override fun onDestroy(activity: AppCompatActivity) { activityDestroyed(activity) }

  @Command fun setSystemBars(invoke: Invoke) = dispatch(invoke) { it.setSystemBars(invoke) }
  @Command fun gameNativePreview(invoke: Invoke) = dispatch(invoke) { it.gameNativePreview(invoke) }
  @Command fun gameFullscreen(invoke: Invoke) = dispatch(invoke) { it.gameFullscreen(invoke) }
  @Command fun gameResumeAutomation(invoke: Invoke) = dispatch(invoke) { it.gameResumeAutomation(invoke) }
  @Command fun ensureStarted(invoke: Invoke) = dispatch(invoke) { it.ensureStarted(invoke) }
  @Command fun listGames(invoke: Invoke) = dispatch(invoke) { it.listGames(invoke) }
  @Command fun launchGame(invoke: Invoke) = dispatch(invoke) { it.launchGame(invoke) }
  @Command fun gameScreenshot(invoke: Invoke) = dispatch(invoke) { it.gameScreenshot(invoke) }
  @Command fun gamePreview(invoke: Invoke) = dispatch(invoke) { it.gamePreview(invoke) }
  @Command fun gameStreamInfo(invoke: Invoke) = dispatch(invoke) { it.gameStreamInfo(invoke) }
  @Command fun gameGesture(invoke: Invoke) = dispatch(invoke) { it.gameGesture(invoke) }
  @Command fun shizukuStatus(invoke: Invoke) = dispatch(invoke) { it.shizukuStatus(invoke) }
  @Command fun startShizukuDisplay(invoke: Invoke) = dispatch(invoke) { it.startShizukuDisplay(invoke) }
  @Command fun launchPackageOnShizukuDisplay(invoke: Invoke) = dispatch(invoke) { it.launchPackageOnShizukuDisplay(invoke) }
  @Command fun stopShizukuDisplay(invoke: Invoke) = dispatch(invoke) { it.stopShizukuDisplay(invoke) }
  @Command fun openShizuku(invoke: Invoke) = dispatch(invoke) { it.openShizuku(invoke) }
  @Command fun requestShizukuPermission(invoke: Invoke) = dispatch(invoke) { it.requestShizukuPermission(invoke) }
  @Command fun shizukuShell(invoke: Invoke) = dispatch(invoke) { it.shizukuShell(invoke) }
  @Command fun installPackage(invoke: Invoke) = dispatch(invoke) { it.installPackage(invoke) }
}

/** Activity references and asynchronous continuations never migrate to a new owner. */
private class BackendActivitySession(
  private val activity: Activity,
  private val commands: BoundedNativeWorker,
  private val previewQueries: BoundedNativeWorker,
  private val sessionOperations: NativeSessionOperations,
) : AutoCloseable {
  private val nativePreview = NativeGamePreview(activity)
  private val previewProgress = PreviewFrameProgress()
  private val previewOwner = LatestNativeRequest<PreviewLayout>()
  private var previewLayout: PreviewLayout? = null
  private var previewProbe = PreviewProbe()
  @Volatile private var destroyed = false
  private var foreground = true
  private var fullscreenRequest = 0L
  private var fullscreenPending = false

  init {
    nativePreview.cancelPendingFullscreen = {
      if (fullscreenPending) {
        fullscreenPending = false; fullscreenRequest++; nativePreview.reportFullscreen(false); true
      } else false
    }
  }

  private data class PreviewLayout(val x: Double, val y: Double, val width: Double, val height: Double,
    val viewportWidth: Double, val enabled: Boolean, val clipTop: Double, val clipBottom: Double, val language: String)
  private data class PreviewProbe(val captured: Long = 0, val presented: Long = 0,
    val hasContent: Boolean = false, val focusDisplay: Int = -1, val error: String? = null)

  private fun onUi(work: () -> Unit) = activity.runOnUiThread { if (!destroyed) work() }

  private fun applyLayout(layout: PreviewLayout, focusDisplay: Int = -1) {
    nativePreview.update(layout.x, layout.y, layout.width, layout.height, layout.viewportWidth,
      layout.enabled, layout.clipTop, layout.clipBottom, focusDisplay)
  }

  private fun resetPreview() {
    previewOwner.invalidate()
    previewProbe = PreviewProbe()
    previewProgress.reset()
    previewLayout?.let { applyLayout(it.copy(enabled = false)) }
  }

  private fun previewReport(layout: PreviewLayout): JSObject {
    val probe = previewProbe
    val displayed = nativePreview.displayedFrameCount()
    val state = if (layout.enabled && probe.error == null) {
      previewProgress.update(probe.captured, probe.presented, displayed, probe.hasContent, android.os.SystemClock.uptimeMillis())
    } else { previewProgress.reset(); PreviewFrameState.WAITING }
    nativePreview.setStatus(state, probe.error, layout.language)
    return JSObject().apply {
      put("capturedFrames", probe.captured); put("presentedFrames", probe.presented)
      put("displayedFrames", displayed); put("focusDisplayId", probe.focusDisplay)
      put("ready", state == PreviewFrameState.LIVE); put("frameState", state.name.lowercase())
      probe.error?.let { put("error", it) }
    }
  }

  /** No PackageManager, Shizuku, capture or filesystem work is allowed on the UI thread. */
  private fun background(invoke: Invoke, changesSession: Boolean = false,
    settled: () -> Unit = {}, commit: (JSObject) -> JSObject = { it }, work: () -> JSObject = { JSObject() }) {
    activity.runOnUiThread {
      if (destroyed) { invoke.reject("Android activity was destroyed"); return@runOnUiThread }
      val mutation = if (changesSession) sessionOperations.begin() else null
      commands.submit(15_000L, { check(!destroyed) { "Android activity was destroyed" }; work() }, { result -> activity.runOnUiThread {
        try {
          if (destroyed) invoke.reject("Android activity was destroyed")
          else result.fold({ value ->
            try { invoke.resolve(commit(value)) } catch (error: Exception) { invoke.reject(error.message, error) }
          }, { invoke.reject(it.message ?: it.javaClass.simpleName) })
        } finally { settled() }
      } }, { if (mutation != null) activity.runOnUiThread { mutation.close() } })
    }
  }

  fun onPause() { onUi { foreground = false; fullscreenRequest++; resetPreview(); nativePreview.pause() } }
  fun onResume() { onUi { foreground = true; nativePreview.resume() } }
  fun nativeSessionChanged() {
    if (destroyed) return
    fullscreenRequest++; fullscreenPending = false
    nativePreview.exitFullscreen(); resetPreview()
  }
  override fun close() {
    if (destroyed) return
    destroyed = true
    fullscreenRequest++; fullscreenPending = false
    previewOwner.invalidate(); previewProbe = PreviewProbe(); previewProgress.reset()
    nativePreview.destroy()
  }

  @Command
  fun setSystemBars(invoke: Invoke) {
    val args = invoke.getArgs()
    val background = args.optString("backgroundColor")
    if (!Regex("^#[0-9a-fA-F]{6}$").matches(background)) {
      invoke.reject("System bar background must be an opaque #RRGGBB color")
      return
    }
    val backgroundColor = Color.parseColor(background)
    val darkIcons = args.optBoolean("darkIcons", false)
    activity.runOnUiThread {
      if (destroyed) { invoke.reject("Android activity was destroyed"); return@runOnUiThread }
      try {
        val mainActivity = activity as? MainActivity
          ?: throw IllegalStateException("Main Android activity is unavailable")
        mainActivity.applySystemBars(backgroundColor, darkIcons)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message, error)
      }
    }
  }

  @Command
  fun gameNativePreview(invoke: Invoke) {
    val args = invoke.getArgs()
    activity.runOnUiThread {
      if (destroyed) { invoke.reject("Android activity was destroyed"); return@runOnUiThread }
      try {
        val palette = args.optJSONObject("themePalette")
        if (palette != null) nativePreview.applyTheme(NativePreviewPalette.from { palette.optString(it) })
        val layout = PreviewLayout(args.optDouble("x", 0.0), args.optDouble("y", 0.0),
          args.optDouble("width", 0.0), args.optDouble("height", 0.0), args.optDouble("viewportWidth", 1.0),
          (args.optBoolean("enabled", false) || nativePreview.isFullscreen()) && sessionOperations.count == 0 && foreground,
          args.optDouble("clipTop", 0.0),
          args.optDouble("clipBottom", 0.0), args.optString("language", "en"))
        if (previewLayout != layout) { previewProbe = PreviewProbe(); previewProgress.reset() }
        previewLayout = layout
        val ticket = previewOwner.update(layout)
        // Resolve immediately: the frontend serializes these commands, including menu hides.
        applyLayout(layout)
        invoke.resolve(previewReport(layout))
        if (layout.enabled) previewQueries.submit(3_000L, {
          check(!destroyed) { "Android activity was destroyed" }
          val counts = ShizukuController.nativeFrameCounts(activity)
          PreviewProbe(counts.first, counts.second, ShizukuController.hasVisibleFrame(activity),
            ShizukuController.previewFocusDisplayId(activity))
        }, { result ->
          if (result.exceptionOrNull() !is java.util.concurrent.RejectedExecutionException) onUi {
            if (previewOwner.isCurrent(ticket) && sessionOperations.count == 0) {
              previewProbe = result.getOrElse { PreviewProbe(error = it.message ?: it.javaClass.simpleName) }
              applyLayout(layout, previewProbe.focusDisplay)
              previewReport(layout)
            }
          }
        })
      } catch (error: Exception) { invoke.reject(error.message, error) }
    }
  }

  @Command
  fun gameFullscreen(invoke: Invoke) {
    val args = invoke.getArgs()
    activity.runOnUiThread {
      if (destroyed) { invoke.reject("Android activity was destroyed"); return@runOnUiThread }
      val ticket = ++fullscreenRequest
      val palette = args.optJSONObject("themePalette")
      if (palette != null) nativePreview.applyTheme(NativePreviewPalette.from { palette.optString(it) })
      if (!args.optBoolean("active", false)) {
        fullscreenPending = false
        nativePreview.exitFullscreen()
        previewOwner.invalidate(); previewProbe = PreviewProbe(); previewProgress.reset()
        invoke.resolve(JSObject().apply { put("active", false) })
        return@runOnUiThread
      }
      fullscreenPending = true
      val handoff = ManualLeaseHandoff<NativeManualInputLease>()
      background(invoke, settled = {
        handoff.cancel()
        if (ticket == fullscreenRequest) fullscreenPending = false
      }, commit = { session ->
        check(ticket == fullscreenRequest && foreground && sessionOperations.count == 0) { "Fullscreen request was superseded" }
        previewOwner.invalidate()
        val lease = checkNotNull(handoff.take()) { "The manual input lease expired" }
        try {
          nativePreview.enterFullscreen(session.getInt("displayId"), session.getInt("width"), session.getInt("height"),
            args.optString("language", "en"), lease)
        } catch (error: Throwable) {
          runCatching { nativePreview.exitFullscreen() }
          lease.close()
          throw error
        }
        JSObject().apply { put("active", true) }
      }) {
        val packageName = allowedGamePackage(args.getString("packageName"))
        val display = ShizukuController.virtualDisplayId(activity)
        check(display > 0 && ShizukuController.currentGamePackage(activity) == packageName) { "The selected game is not running in its owned display" }
        val size = ShizukuController.virtualDisplaySize(activity)
        check(size.size >= 2 && size[0] > 0 && size[1] > 0) { "The game display dimensions are unavailable" }
        val token = ShizukuController.acquireManualInput(activity, display)
        check(token > 0) { "The installed privileged service does not support manual input leases; restart Shizuku" }
        val lease = NativeManualInputLease(display, token) { ShizukuController.releaseManualInputAsync(activity, display, token) }
        check(handoff.offer(lease)) { "The manual input request was superseded" }
        check(ShizukuController.virtualDisplayId(activity) == display && ShizukuController.currentGamePackage(activity) == packageName) {
          "The selected game changed while manual control was opening"
        }
        JSObject().apply { put("displayId", display); put("width", size[0]); put("height", size[1]) }
      }
    }
  }

  @Command
  fun gameResumeAutomation(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      val id = args.getInteger("displayId", -1)
      check(ShizukuController.resumeAutomation(activity, id)) { "The owned display changed or input cancellation failed" }
      JSObject().apply { put("resumed", true) }
    }
  }
  private val gamePackages = linkedMapOf(
    "com.RoamingStar.BlueArchive.bilibili" to "Blue Archive (Bilibili)",
    "com.RoamingStar.BlueArchive" to "Blue Archive (CN)",
    "com.YostarJP.BlueArchive" to "Blue Archive (JP)",
    "com.nexon.bluearchive" to "Blue Archive (Global)",
  )

  @Command
  fun ensureStarted(invoke: Invoke) {
    background(invoke) {
      val context = activity.applicationContext
      ShizukuController.prebind(context)
      val intent = Intent(context, BaasForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      val result = JSObject()
      result.put("pipePath", File(context.filesDir, "baas-service.sock").absolutePath)
      val (videoStreamUrl, videoStreamToken) = BaasLocalDeviceServer.videoStreamAccess(context)
      result.put("videoStreamUrl", videoStreamUrl)
      result.put("videoStreamToken", videoStreamToken)
      result
    }
  }

  @Command
  fun listGames(invoke: Invoke) {
    background(invoke) {
      ShizukuController.prebind(activity)
      val packageManager = activity.packageManager
      val games = JSArray()
      for ((packageName, fallbackLabel) in gamePackages) {
        val applicationInfo = try {
          packageManager.getApplicationInfo(packageName, 0)
        } catch (_: PackageManager.NameNotFoundException) {
          null
        } ?: continue
        if (packageManager.getLaunchIntentForPackage(packageName) == null) continue
        val game = JSObject()
        game.put("packageName", packageName)
        game.put("label", packageManager.getApplicationLabel(applicationInfo).toString().ifBlank { fallbackLabel })
        game.put("iconPngBase64", drawablePngBase64(packageManager.getApplicationIcon(applicationInfo)))
        games.put(game)
      }
      val result = JSObject()
      result.put("games", games)
      putShizukuState(result)
      result
    }
  }

  @Command
  fun launchGame(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke, changesSession = true) {
      val packageName = allowedGamePackage(args.getString("packageName"))
      if (ShizukuController.state(activity).granted && ShizukuController.virtualDisplayId(activity) >= 0) {
        ShizukuController.takeOverGame(activity, packageName)
        return@background JSObject()
      }
      val intent = activity.packageManager.getLaunchIntentForPackage(packageName)
        ?: throw IllegalStateException("No launcher activity is available for $packageName")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      activity.startActivity(intent)
      JSObject()
    }
  }

  @Command
  fun gameScreenshot(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      allowedGamePackage(args.getString("packageName"))
      val result = JSObject()
      result.put("pngBase64", ShizukuController.captureVirtualDisplay(activity))
      result
    }
  }

  @Command
  fun gamePreview(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      allowedGamePackage(args.getString("packageName"))
      val result = JSObject()
      result.put("jpegBase64", ShizukuController.captureVirtualDisplayPreview(activity))
      result
    }
  }

  @Command
  fun gameStreamInfo(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      val (videoStreamUrl, videoStreamToken) = BaasLocalDeviceServer.prepareVideoStream(
        activity,
        args.getInteger("fps", 30).coerceIn(1, 60),
        args.getInteger("bitrate", 4_000_000).coerceIn(256_000, 20_000_000),
      )
      val result = JSObject()
      result.put("videoStreamUrl", videoStreamUrl)
      result.put("videoStreamToken", videoStreamToken)
      result
    }
  }

  @Command
  fun gameGesture(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      allowedGamePackage(args.getString("packageName"))
      val success = ShizukuController.gesture(
        activity,
        args.getInteger("x1", 0),
        args.getInteger("y1", 0),
        args.getInteger("x2", 0),
        args.getInteger("y2", 0),
        args.getInteger("durationMs", 1).coerceIn(1, 10_000),
      )
      if (!success) throw IllegalStateException("Shizuku could not control the game display")
      JSObject()
    }
  }

  @Command
  fun shizukuStatus(invoke: Invoke) {
    background(invoke) {
      val result = JSObject()
      putShizukuState(result)
      result
    }
  }

  @Command
  fun startShizukuDisplay(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke, changesSession = true) {
      val result = JSObject()
      result.put(
        "displayId",
        ShizukuController.startVirtualDisplay(
          activity,
          args.getInteger("width", 1280),
          args.getInteger("height", 720),
          args.getInteger("density", 240),
        ),
      )
      result
    }
  }

  @Command
  fun launchPackageOnShizukuDisplay(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke, changesSession = true) {
      val packageName = allowedGamePackage(args.getString("packageName"))
      val displayId = args.getInteger("displayId", -1)
      if (!ShizukuController.launchPackageOnDisplay(activity, packageName, displayId)) {
        throw IllegalStateException("Android rejected the game launch on the virtual display")
      }
      JSObject()
    }
  }

  @Command
  fun stopShizukuDisplay(invoke: Invoke) {
    background(invoke, changesSession = true) {
      ShizukuController.stopVirtualDisplay(activity)
      JSObject()
    }
  }

  @Command
  fun openShizuku(invoke: Invoke) {
    background(invoke) {
      ShizukuController.openInstalledShizuku(activity)
      JSObject()
    }
  }

  @Command
  fun requestShizukuPermission(invoke: Invoke) {
    background(invoke) {
      ShizukuController.requestPermission(activity)
      JSObject()
    }
  }

  @Command
  fun shizukuShell(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      val command = args.getString("command")
      val result = JSObject()
      result.put("output", ShizukuController.execute(activity, command))
      result
    }
  }

  @Command
  fun installPackage(invoke: Invoke) {
    val args = invoke.getArgs()
    background(invoke) {
      val packagePath = File(args.getString("path")).canonicalFile
      val allowedRoots = listOf(activity.cacheDir.canonicalFile, activity.filesDir.canonicalFile)
      if (allowedRoots.none { packagePath.toPath().startsWith(it.toPath()) }) {
        throw SecurityException("Update package must be stored in app-private storage")
      }
      if (!packagePath.isFile || packagePath.extension.lowercase() != "apk") {
        throw IllegalArgumentException("Downloaded Android update package is missing")
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
        activity.startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        )
        throw IllegalStateException("Allow installs from this app, then run the update again")
      }
      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        packagePath,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      JSObject()
    }
  }

  private fun allowedGamePackage(packageName: String): String {
    if (!gamePackages.containsKey(packageName)) {
      throw SecurityException("Unsupported game package")
    }
    return packageName
  }

  private fun putShizukuState(result: JSObject) {
    val state = ShizukuController.state(activity)
    result.put("shizukuInstalled", state.installed)
    result.put("shizukuRunning", state.running)
    result.put("shizukuGranted", state.granted)
    result.put("shizukuUid", state.uid)
    result.put(
      "shizukuDisplayId",
      if (state.granted) runCatching { ShizukuController.virtualDisplayId(activity) }.getOrDefault(-1) else -1,
    )
  }

  private fun drawablePngBase64(drawable: Drawable): String {
    val bitmap = if (drawable is BitmapDrawable && drawable.bitmap != null) {
      drawable.bitmap
    } else {
      Bitmap.createBitmap(
        drawable.intrinsicWidth.coerceAtLeast(1),
        drawable.intrinsicHeight.coerceAtLeast(1),
        Bitmap.Config.ARGB_8888,
      ).also { bitmap ->
        val canvas = android.graphics.Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
      }
    }
    val output = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
    return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
  }
}
