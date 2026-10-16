package io.github.kiramei.baas_tauri

import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.hardware.HardwareBuffer
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Owns an off-screen Android VirtualDisplay inside the backend process.
 *
 * The main process requests changes through a tiny file protocol because the
 * backend service intentionally lives in an isolated app process. The display
 * surface is continuously drained so producers never block on ImageReader.
 */
class BaasHeadlessVirtualDisplay(private val context: Context) {
  companion object {
    private const val TAG = "BaasHeadlessVD"
    const val REQUEST_FILE = "config/headless_virtual_display.request"
    const val DISPLAY_ID_FILE = "config/scrcpy_display_id.txt"

    @Volatile private var latestFrameBytes: ByteArray? = null
    @Volatile private var latestFrameWidth = 0
    @Volatile private var latestFrameHeight = 0
    @Volatile private var latestFrameRowStride = 0
    @Volatile private var latestFramePixelStride = 0

    init {
      // The backend service runs in a dedicated process, so it must load the
      // Tauri native library independently before using the frame-copy JNI.
      System.loadLibrary("baas_tauri_lib")
    }

    @JvmStatic fun captureLatestRgba(): ByteArray? = latestFrameBytes?.clone()
    @JvmStatic fun captureWidth(): Int = latestFrameWidth
    @JvmStatic fun captureHeight(): Int = latestFrameHeight
    @JvmStatic fun captureRowStride(): Int = latestFrameRowStride
    @JvmStatic fun capturePixelStride(): Int = latestFramePixelStride
    @JvmStatic external fun copyHardwareBuffer(
      hardwareBuffer: HardwareBuffer,
      destination: ByteBuffer,
    ): Int
    @JvmStatic external fun decodeH264(data: ByteArray): ByteArray?
    @JvmStatic external fun resetH264Decoder()

    private fun clearLatestFrame() {
      latestFrameBytes = null
      latestFrameWidth = 0
      latestFrameHeight = 0
      latestFrameRowStride = 0
      latestFramePixelStride = 0
    }
  }

  private val running = AtomicBoolean(false)
  private var watcherThread: Thread? = null
  private var handlerThread: HandlerThread? = null
  private var imageReader: ImageReader? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var activeRequest: String? = null
  private var lastFrameCopyAt = 0L

  fun startWatcher() {
    if (!running.compareAndSet(false, true)) return
    watcherThread = thread(name = "baas-headless-vd-watcher", isDaemon = true) {
      while (running.get()) {
        try {
          reconcile()
        } catch (error: Throwable) {
          Log.e(TAG, "Virtual display reconcile failed", error)
          stopDisplay()
        }
        try {
          Thread.sleep(200L)
        } catch (_: InterruptedException) {
          break
        }
      }
      stopDisplay()
    }
  }

  fun stopWatcher() {
    running.set(false)
    watcherThread?.interrupt()
    watcherThread = null
    stopDisplay()
  }

  @Synchronized
  private fun reconcile() {
    val root = context.getExternalFilesDir(null)?.parentFile ?: return
    val requestFile = File(root, REQUEST_FILE)
    if (!requestFile.isFile) {
      if (virtualDisplay != null) stopDisplay()
      return
    }
    val request = requestFile.readText().trim()
    if (request == activeRequest && virtualDisplay != null) return
    val parts = request.split(',')
    require(parts.size == 3) { "Invalid headless display request: $request" }
    val width = parts[0].toInt().coerceIn(320, 4096)
    val height = parts[1].toInt().coerceIn(320, 4096)
    val density = parts[2].toInt().coerceIn(72, 640)
    stopDisplay()
    createDisplay(root, width, height, density, request)
  }

  @Synchronized
  private fun createDisplay(root: File, width: Int, height: Int, density: Int, request: String) {
    val worker = HandlerThread("baas-headless-vd-images").also { it.start() }
    // Match the AImageReader usage required by GPU-backed game surfaces. The
    // four-argument Java factory can yield an all-black CPU-only buffer on
    // several emulator/Unity combinations.
    val reader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ImageReader.newInstance(
        width,
        height,
        PixelFormat.RGBA_8888,
        3,
        HardwareBuffer.USAGE_CPU_READ_OFTEN or HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE,
      )
    } else {
      ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3)
    }
    reader.setOnImageAvailableListener({ source ->
      val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
      try {
        val now = SystemClock.elapsedRealtime()
        if (now - lastFrameCopyAt >= 100L) {
          val plane = image.planes.firstOrNull()
          if (plane != null) {
            val expectedBytes = plane.rowStride * image.height
            val directBuffer = ByteBuffer.allocateDirect(expectedBytes)
            val hardwareBuffer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
              image.hardwareBuffer
            } else {
              null
            }
            val copiedBytes = hardwareBuffer?.let {
              try {
                copyHardwareBuffer(it, directBuffer)
              } finally {
                it.close()
              }
            } ?: -1
            val bytes = if (copiedBytes > 0) {
              directBuffer.rewind()
              ByteArray(copiedBytes).also { directBuffer.get(it) }
            } else {
              val buffer = plane.buffer
              buffer.rewind()
              ByteArray(buffer.remaining()).also { buffer.get(it) }
            }
            latestFrameWidth = image.width
            latestFrameHeight = image.height
            latestFrameRowStride = if (copiedBytes > 0) copiedBytes / image.height else plane.rowStride
            latestFramePixelStride = plane.pixelStride
            latestFrameBytes = bytes
            lastFrameCopyAt = now
          }
        }
      } catch (error: Throwable) {
        Log.w(TAG, "Unable to capture virtual display frame", error)
      } finally {
        image.close()
      }
    }, Handler(worker.looper))

    val baseFlags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
      (1 shl 6) or // VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH
      (1 shl 8) // VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL
    val manager = context.getSystemService(DisplayManager::class.java)
    val display = manager.createVirtualDisplay(
      "BAAS headless automation",
      width,
      height,
      density,
      reader.surface,
      baseFlags,
    ) ?: throw IllegalStateException("DisplayManager returned null VirtualDisplay")

    handlerThread = worker
    imageReader = reader
    virtualDisplay = display
    activeRequest = request
    File(root, DISPLAY_ID_FILE).apply {
      parentFile?.mkdirs()
      writeText(display.display.displayId.toString())
    }
    Log.i(TAG, "Created ${width}x${height}/$density display id=${display.display.displayId}")
  }

  @Synchronized
  private fun stopDisplay() {
    val root = context.getExternalFilesDir(null)?.parentFile
    virtualDisplay?.release()
    virtualDisplay = null
    imageReader?.close()
    imageReader = null
    handlerThread?.quitSafely()
    handlerThread = null
    activeRequest = null
    lastFrameCopyAt = 0L
    clearLatestFrame()
    root?.let { File(it, DISPLAY_ID_FILE).delete() }
  }
}
