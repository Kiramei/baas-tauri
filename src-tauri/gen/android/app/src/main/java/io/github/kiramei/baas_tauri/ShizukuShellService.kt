package io.github.kiramei.baas_tauri

import android.app.ActivityOptions
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Binder
import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.Executors

/** Shell/root process which owns the virtual display, frame capture and input channel. */
@Keep
class ShizukuShellService : IShizukuShellService.Stub {
  private var context: Context? = null
  private val displayLock = Any()
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var imageThread: HandlerThread? = null
  private var latestFrame: Bitmap? = null
  private var displayWidth = 0
  private var displayHeight = 0
  private var lastFrameAt = 0L
  private var privilegedBridge: PrivilegedDisplayBridge? = null
  private var videoStream: H264VideoStream? = null
  private var privilegedVideoSocket: Socket? = null
  private var privilegedVideoRelay: Thread? = null

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
    val thread = HandlerThread("baas-virtual-display-frames").also { it.start() }
    // Match MAA-Meow's capture surface contract. Unity renders through a GPU-backed
    // SurfaceView; a CPU-only ImageReader may create a valid display which stays black.
    val reader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ImageReader.newInstance(
        safeWidth,
        safeHeight,
        PixelFormat.RGBA_8888,
        5,
        HardwareBuffer.USAGE_CPU_READ_OFTEN or HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE,
      )
    } else {
      ImageReader.newInstance(safeWidth, safeHeight, PixelFormat.RGBA_8888, 5)
    }
    reader.setOnImageAvailableListener({ source -> consumeLatestFrame(source) }, Handler(thread.looper))
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
      reader.surface,
      flags,
    ) ?: run {
      reader.close()
      thread.quitSafely()
      throw IllegalStateException("Android rejected the BAAS virtual display")
    }
    imageThread = thread
    imageReader = reader
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
    synchronized(displayLock) {
      closeVideoStreamLocked()
      privilegedBridge?.let { bridge ->
        val port = bridge.request("OPEN_STREAM $fps $bitrate").toInt()
        val connector = Executors.newSingleThreadExecutor()
        val socket = try {
          connector.submit<Socket> { Socket(InetAddress.getLoopbackAddress(), port) }.get()
        } finally {
          connector.shutdownNow()
        }
        val pipe = ParcelFileDescriptor.createPipe()
        try {
          privilegedVideoSocket = socket
          privilegedVideoRelay = Thread({
            try {
              socket.getInputStream().use { input ->
                ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { output ->
                  input.copyTo(output, 64 * 1024)
                }
              }
            } catch (_: Throwable) {
              runCatching { pipe[1].close() }
            }
          }, "baas-privileged-video-relay").apply {
            isDaemon = true
            start()
          }
          // Binder cannot transfer a Magisk-domain TCP socket directly to an
          // untrusted app on enforcing SELinux builds. An anonymous pipe keeps
          // the exact binary stream while giving Binder a transferable fd.
          return@synchronized pipe[0]
        } catch (error: Throwable) {
          runCatching { socket.close() }
          runCatching { pipe[0].close() }
          runCatching { pipe[1].close() }
          throw error
        }
      }
      val display = virtualDisplay ?: throw IllegalStateException("The virtual display is not running")
      val width = displayWidth.coerceAtLeast(1)
      val height = displayHeight.coerceAtLeast(1)
      val pipe = ParcelFileDescriptor.createPipe()
      try {
        val sink = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
        videoStream = H264VideoStream.start(display, width, height, fps, bitrate, sink)
        pipe[0]
      } catch (error: Throwable) {
        runCatching { pipe[0].close() }
        runCatching { pipe[1].close() }
        restoreCaptureSurfaceLocked()
        throw error
      }
    }
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
    } ?: latestFrame?.let { frame ->
      ByteArrayOutputStream().use { output ->
        frame.compress(format, quality, output)
        output.toByteArray()
      }
    } ?: ByteArray(0)

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
    val command = if (x1 == x2 && y1 == y2 && durationMs <= 250) {
      "input -d $displayId tap ${x1.coerceAtLeast(0)} ${y1.coerceAtLeast(0)}"
    } else {
      "input -d $displayId swipe ${x1.coerceAtLeast(0)} ${y1.coerceAtLeast(0)} " +
        "${x2.coerceAtLeast(0)} ${y2.coerceAtLeast(0)} ${durationMs.coerceIn(1, 10_000)}"
    }
    execute(command)
    return true
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
    result >= 0
  }

  private fun consumeLatestFrame(reader: ImageReader) {
    val image = reader.acquireLatestImage() ?: return
    try {
      val now = android.os.SystemClock.uptimeMillis()
      if (now - lastFrameAt < 500L) return
      lastFrameAt = now
      val bitmap = imageToBitmap(image)
      synchronized(displayLock) {
        latestFrame?.recycle()
        latestFrame = bitmap
      }
    } finally {
      image.close()
    }
  }

  private fun imageToBitmap(image: Image): Bitmap {
    val plane = image.planes[0]
    val pixelStride = plane.pixelStride
    val rowStride = plane.rowStride
    val rowPadding = rowStride - pixelStride * image.width
    val padded = Bitmap.createBitmap(image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888)
    padded.copyPixelsFromBuffer(plane.buffer)
    if (padded.width == image.width) return padded
    val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
    padded.recycle()
    return cropped
  }

  private fun stopVirtualDisplayLocked() {
    closeVideoStreamLocked(restoreCaptureSurface = false)
    imageReader?.setOnImageAvailableListener(null, null)
    virtualDisplay?.release()
    imageReader?.close()
    imageThread?.quitSafely()
    latestFrame?.recycle()
    virtualDisplay = null
    imageReader = null
    imageThread = null
    latestFrame = null
    displayWidth = 0
    displayHeight = 0
    lastFrameAt = 0L
  }

  private fun closeVideoStreamLocked(restoreCaptureSurface: Boolean = true) {
    privilegedBridge?.let { bridge ->
      runCatching { bridge.request("CLOSE_STREAM") }
      runCatching { privilegedVideoSocket?.close() }
      privilegedVideoRelay?.interrupt()
      privilegedVideoSocket = null
      privilegedVideoRelay = null
      return
    }
    videoStream?.close()
    videoStream = null
    if (restoreCaptureSurface) restoreCaptureSurfaceLocked()
  }

  private fun restoreCaptureSurfaceLocked() {
    val display = virtualDisplay ?: return
    val surface = imageReader?.surface ?: return
    runCatching { display.setSurface(surface) }
  }

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
