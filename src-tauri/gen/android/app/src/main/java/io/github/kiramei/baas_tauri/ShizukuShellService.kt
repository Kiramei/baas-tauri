package io.github.kiramei.baas_tauri

import android.app.ActivityOptions
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Binder
import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** Shell/root process which owns the virtual display, frame capture and input channel. */
@Keep
class ShizukuShellService : IShizukuShellService.Stub {
  private var context: Context? = null
  private val displayLock = Any()
  private var virtualDisplay: VirtualDisplay? = null
  private var displayWidth = 0
  private var displayHeight = 0
  @Volatile private var activePackage = ""
  private var privilegedBridge: PrivilegedDisplayBridge? = null

  constructor()

  @Keep
  constructor(context: Context) {
    this.context = context.applicationContext
  }

  override fun execute(command: String): String {
    val process = ProcessBuilder("sh", "-c", command).start()
    val readers = Executors.newFixedThreadPool(2)
    return try {
      val stdout = readers.submit<String> { process.inputStream.bufferedReader().use { it.readText() } }
      val stderr = readers.submit<String> { process.errorStream.bufferedReader().use { it.readText() } }
      val exitCode = process.waitFor()
      val output = stdout.get().trim()
      val error = stderr.get().trim()
      if (exitCode != 0) {
        throw IllegalStateException(
          "Shizuku shell command failed ($exitCode)${if (error.isBlank()) "" else ": $error"}"
        )
      }
      output
    } finally {
      readers.shutdownNow()
      process.destroy()
    }
  }

  override fun startVirtualDisplay(width: Int, height: Int, density: Int): Int = privileged {
    if (Process.myUid() == Process.ROOT_UID) {
      val bridge = privilegedBridge ?: PrivilegedDisplayBridge.start(
        context ?: throw IllegalStateException("Shizuku user-service context is unavailable")
      ).also { privilegedBridge = it }
      return@privileged bridge.request("START $width $height $density").toInt()
    }
    synchronized(displayLock) {
    val safeWidth = width.coerceIn(640, 3840)
    val safeHeight = height.coerceIn(360, 2160)
    val safeDensity = density.coerceIn(120, 640)
    if (virtualDisplay != null && displayWidth == safeWidth && displayHeight == safeHeight) {
      return@synchronized virtualDisplay?.display?.displayId ?: -1
    }
    stopVirtualDisplayLocked()
    val serviceContext = context ?: throw IllegalStateException("Shizuku user-service context is unavailable")
    val ownerPackage = "com.android.shell"
    val packageContext = serviceContext.createPackageContext(
      ownerPackage,
      Context.CONTEXT_IGNORE_SECURITY,
    )
    val displayContext = PrivilegedIdentityContext(packageContext, ownerPackage, Process.myUid())
    val constructor = DisplayManager::class.java.getDeclaredConstructor(Context::class.java).apply {
      isAccessible = true
    }
    val manager = constructor.newInstance(displayContext)
    NativeDisplayCapture.load()
    val captureSurface = NativeDisplayCapture.start(safeWidth, safeHeight)
    val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
      (1 shl 6) or
      (1 shl 8)
    val display = manager.createVirtualDisplay(
      "BAAS Game",
      safeWidth,
      safeHeight,
      safeDensity,
      captureSurface,
      flags,
    ) ?: run {
      captureSurface.release()
      NativeDisplayCapture.stop()
      throw IllegalStateException("Android rejected the BAAS virtual display")
    }
    captureSurface.release()
    virtualDisplay = display
    displayWidth = safeWidth
    displayHeight = safeHeight
      display.display.displayId
    }
  }

  override fun stopVirtualDisplay() = privileged {
    privilegedBridge?.let { bridge ->
      bridge.request("STOP")
      return@privileged
    }
    synchronized(displayLock) {
      stopVirtualDisplayLocked()
    }
  }

  override fun getVirtualDisplayId(): Int = synchronized(displayLock) {
    privilegedBridge?.let { return@synchronized it.request("ID").toInt() }
    virtualDisplay?.display?.displayId ?: -1
  }

  override fun getVirtualDisplaySize(): IntArray = synchronized(displayLock) {
    privilegedBridge?.let {
      val parts = it.request("SIZE").split(',')
      return@synchronized intArrayOf(parts[0].toInt(), parts[1].toInt())
    }
    intArrayOf(displayWidth.coerceAtLeast(1), displayHeight.coerceAtLeast(1))
  }

  override fun captureVirtualDisplay(): ParcelFileDescriptor =
    captureVirtualDisplay("CAPTURE", Bitmap.CompressFormat.PNG, 100)

  override fun captureVirtualDisplayPreview(): ParcelFileDescriptor =
    captureVirtualDisplay("PREVIEW", Bitmap.CompressFormat.JPEG, 76)

  override fun openVideoStream(fps: Int, bitrate: Int): ParcelFileDescriptor = privileged {
    throw UnsupportedOperationException("Use native preview; screenshots remain active")
  }

  override fun closeVideoStream() = privileged {
    synchronized(displayLock) { closeVideoStreamLocked() }
  }

  private fun captureVirtualDisplay(
    command: String,
    format: Bitmap.CompressFormat,
    quality: Int,
  ): ParcelFileDescriptor = synchronized(displayLock) {
    val bytes = privilegedBridge?.let { bridge ->
      val encoded = bridge.request(command)
      if (encoded.isEmpty()) ByteArray(0)
      else android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
    } ?: NativeDisplayCapture.captureBitmap()?.let { frame ->
      try { ByteArrayOutputStream().use { output ->
        frame.compress(format, quality, output)
        output.toByteArray()
      } } finally { frame.recycle() }
    } ?: throw IllegalStateException("No game frame has been captured yet")

    val pipe = ParcelFileDescriptor.createPipe()
    Thread({
      runCatching {
        ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write(bytes) }
      }
    }, "baas-screenshot-pipe").start()
    pipe[0]
  }

  override fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
    privilegedBridge?.let {
      return it.request("GESTURE $x1 $y1 $x2 $y2 $durationMs").toBoolean()
    }
    val displayId = getVirtualDisplayId()
    if (displayId < 0) return false
    return privileged { DisplayInput.gesture(displayId, x1, y1, x2, y2, durationMs) }
  }

  override fun setPreviewSurface(surface: android.view.Surface?) = privileged {
    check(Process.myUid() != Process.ROOT_UID) { "Root preview uses the system display endpoint" }
    NativeDisplayCapture.load()
    NativeDisplayCapture.setPreviewSurface(surface)
  }

  override fun frameCount(): Long = NativeDisplayCapture.frameCount()
  override fun previewFrameCount(): Long = NativeDisplayCapture.previewFrameCount()
  override fun currentPackage(): String = activePackage
  override fun reconnectNativeEndpoint() = privileged {
    privilegedBridge?.request("PUBLISH")
    Unit
  }
  override fun keyEvent(keyCode: Int): Boolean = privileged {
    privilegedBridge?.let { return@privileged it.request("KEY $keyCode").toBoolean() }
    DisplayInput.key(getVirtualDisplayId(), keyCode)
  }

  /** Launch through ActivityManager's binder, matching MAA-Meow's primary path. */
  override fun launchPackageOnDisplay(packageName: String, displayId: Int): Boolean = privileged {
    privilegedBridge?.let {
      return@privileged it.request("LAUNCH $packageName $displayId").toBoolean()
    }
    require(displayId >= 0) { "Invalid virtual display id" }
    require(packageName.matches(Regex("[A-Za-z0-9_.]+"))) { "Invalid package name" }
    val serviceContext = context ?: throw IllegalStateException("Shizuku user-service context is unavailable")
    val intent = serviceContext.packageManager.getLaunchIntentForPackage(packageName)
      ?: serviceContext.packageManager.getLeanbackLaunchIntentForPackage(packageName)
      ?: throw IllegalStateException("No launcher activity is available for $packageName")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)

    val options = ActivityOptions.makeBasic().apply {
      launchDisplayId = displayId
    }
    val manager = Class.forName("android.app.ActivityManagerNative")
      .getDeclaredMethod("getDefault")
      .invoke(null)
    val applicationThread = Class.forName("android.app.IApplicationThread")
    val profilerInfo = Class.forName("android.app.ProfilerInfo")
    val method = manager.javaClass.getMethod(
      "startActivityAsUser",
      applicationThread,
      String::class.java,
      Intent::class.java,
      String::class.java,
      android.os.IBinder::class.java,
      String::class.java,
      Int::class.javaPrimitiveType,
      Int::class.javaPrimitiveType,
      profilerInfo,
      android.os.Bundle::class.java,
      Int::class.javaPrimitiveType,
    )
    val result = method.invoke(
      manager,
      null,
      "com.android.shell",
      intent,
      null,
      null,
      null,
      0,
      0,
      null,
      options.toBundle(),
      -2,
    ) as Int
    (result >= 0).also { if (it) activePackage = packageName }
  }


  private fun stopVirtualDisplayLocked() {
    closeVideoStreamLocked(restoreCaptureSurface = false)
    virtualDisplay?.release()
    if (Process.myUid() != Process.ROOT_UID) NativeDisplayCapture.stop()
    virtualDisplay = null
    activePackage = ""
    displayWidth = 0
    displayHeight = 0
  }

  // Compatibility stop for the retired stream API. Never changes the capture Surface.
  private fun closeVideoStreamLocked(restoreCaptureSurface: Boolean = true) = Unit

  override fun destroy() {
    synchronized(displayLock) { closeVideoStreamLocked() }
    privilegedBridge?.close()
    privilegedBridge = null
    stopVirtualDisplay()
    System.exit(0)
  }

  private inline fun <T> privileged(block: () -> T): T {
    val identity = Binder.clearCallingIdentity()
    return try {
      block()
    } finally {
      Binder.restoreCallingIdentity(identity)
    }
  }

  private class PrivilegedIdentityContext(
    base: Context,
    private val identityPackage: String,
    private val identityUid: Int,
  ) : ContextWrapper(base) {
    override fun getPackageName(): String = identityPackage
    override fun getOpPackageName(): String = identityPackage
    override fun getApplicationContext(): Context = this

    override fun getAttributionSource(): AttributionSource =
      AttributionSource.Builder(identityUid).setPackageName(identityPackage).build()
  }
}
