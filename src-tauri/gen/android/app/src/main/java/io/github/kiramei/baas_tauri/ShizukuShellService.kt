package io.github.kiramei.baas_tauri

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Binder
import android.os.Process
import android.system.Os
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
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

  constructor()

  @Keep
  constructor(context: Context) {
    this.context = context.applicationContext
    if (Process.myUid() == 0) {
      Os.setgid(Process.SHELL_UID)
      Os.setuid(Process.SHELL_UID)
    }
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
    synchronized(displayLock) {
    val safeWidth = width.coerceIn(640, 3840)
    val safeHeight = height.coerceIn(360, 2160)
    val safeDensity = density.coerceIn(120, 640)
    if (virtualDisplay != null && displayWidth == safeWidth && displayHeight == safeHeight) {
      return@synchronized virtualDisplay?.display?.displayId ?: -1
    }
    stopVirtualDisplayLocked()
    val serviceContext = context ?: throw IllegalStateException("Shizuku user-service context is unavailable")
    val displayContext = serviceContext.createPackageContext(
      "com.android.shell",
      Context.CONTEXT_IGNORE_SECURITY,
    )
    val manager = displayContext.getSystemService(DisplayManager::class.java)
      ?: throw IllegalStateException("Android DisplayManager is unavailable")
    val thread = HandlerThread("baas-virtual-display-frames").also { it.start() }
    val reader = ImageReader.newInstance(safeWidth, safeHeight, PixelFormat.RGBA_8888, 3)
    reader.setOnImageAvailableListener({ source -> consumeLatestFrame(source) }, Handler(thread.looper))
    val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
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
    synchronized(displayLock) {
      stopVirtualDisplayLocked()
    }
  }

  override fun getVirtualDisplayId(): Int = synchronized(displayLock) {
    virtualDisplay?.display?.displayId ?: -1
  }

  override fun getVirtualDisplaySize(): IntArray = synchronized(displayLock) {
    intArrayOf(displayWidth.coerceAtLeast(1), displayHeight.coerceAtLeast(1))
  }

  override fun captureVirtualDisplay(): String = synchronized(displayLock) {
    val frame = latestFrame ?: return@synchronized ""
    val output = ByteArrayOutputStream()
    frame.compress(Bitmap.CompressFormat.PNG, 100, output)
    android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
  }

  override fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
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

  override fun destroy() {
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
}
