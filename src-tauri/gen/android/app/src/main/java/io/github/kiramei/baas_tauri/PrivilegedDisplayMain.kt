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
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Base64
import android.util.Log
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.io.PrintWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

@Keep
object PrivilegedDisplayMain {
  private const val TAG = "BaasPrivilegedDisplay"
  private const val OWNER_PACKAGE = "android"
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var imageThread: HandlerThread? = null
  private var latestFrame: Bitmap? = null
  private var displayWidth = 0
  private var displayHeight = 0
  private var lastFrameAt = 0L
  private var streamServer: ServerSocket? = null
  private var streamThread: Thread? = null
  private var videoStream: H264VideoStream? = null

  @JvmStatic
  fun main(args: Array<String>) {
    val output = PrintWriter(System.out, true)
    try {
      check(Process.myUid() == Process.SYSTEM_UID || Process.myUid() == Process.ROOT_UID) {
        "Privileged backend did not start with a supported identity"
      }
      val systemContext = systemContext()
      System.`in`.bufferedReader().forEachLine { line ->
        try {
          val parts = line.split(' ')
          val result = when (parts.firstOrNull()) {
            "PING" -> "pong"
            "START" -> startDisplay(systemContext, parts[1].toInt(), parts[2].toInt(), parts[3].toInt()).toString()
            "STOP" -> { stopDisplay(); "" }
            "ID" -> (virtualDisplay?.display?.displayId ?: -1).toString()
            "SIZE" -> "$displayWidth,$displayHeight"
            "CAPTURE" -> capture(Bitmap.CompressFormat.PNG, 100)
            "PREVIEW" -> capture(Bitmap.CompressFormat.JPEG, 76)
            "OPEN_STREAM" -> openStream(parts[1].toInt(), parts[2].toInt()).toString()
            "CLOSE_STREAM" -> { closeStream(); "" }
            "GESTURE" -> gesture(parts.drop(1).map(String::toInt)).toString()
            "LAUNCH" -> launch(systemContext, parts[1], parts[2].toInt()).toString()
            "EXIT" -> {
              stopDisplay()
              output.println("OK")
              kotlin.system.exitProcess(0)
            }
            else -> throw IllegalArgumentException("Unknown privileged display command")
          }
          output.println(if (result.isEmpty()) "OK" else "OK $result")
        } catch (error: Throwable) {
          Log.e(TAG, "Privileged display command failed", error)
          val message = errorDescription(error)
          output.println("ERR ${Base64.encodeToString(message.toByteArray(), Base64.NO_WRAP)}")
        }
      }
    } catch (error: Throwable) {
      Log.e(TAG, "Privileged display backend failed", error)
      val message = errorDescription(error)
      output.println("ERR ${Base64.encodeToString(message.toByteArray(), Base64.NO_WRAP)}")
    } finally {
      stopDisplay()
    }
  }

  private fun errorDescription(error: Throwable): String {
    val causes = generateSequence(error) { current ->
      (current as? java.lang.reflect.InvocationTargetException)?.targetException ?: current.cause
    }.take(8).toList()
    return causes.joinToString(" -> ") { cause ->
      "${cause.javaClass.simpleName}: ${cause.message ?: "no message"}"
    }
  }

  private fun systemContext(): Context {
    if (Looper.myLooper() == null) Looper.prepareMainLooper()
    val activityThread = Class.forName("android.app.ActivityThread")
      .getDeclaredMethod("systemMain")
      .apply { isAccessible = true }
      .invoke(null)
    val base = activityThread.javaClass.getDeclaredMethod("getSystemContext")
      .apply { isAccessible = true }
      .invoke(activityThread) as Context
    val packageContext = base.createPackageContext(OWNER_PACKAGE, Context.CONTEXT_IGNORE_SECURITY)
    return IdentityContext(packageContext)
  }

  private fun startDisplay(context: Context, width: Int, height: Int, density: Int): Int {
    stopDisplay()
    val safeWidth = width.coerceIn(640, 3840)
    val safeHeight = height.coerceIn(360, 2160)
    val safeDensity = density.coerceIn(120, 640)
    val thread = HandlerThread("baas-system-display-frames").also { it.start() }
    val reader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ImageReader.newInstance(
        safeWidth, safeHeight, PixelFormat.RGBA_8888, 5,
        HardwareBuffer.USAGE_CPU_READ_OFTEN or HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE,
      )
    } else {
      ImageReader.newInstance(safeWidth, safeHeight, PixelFormat.RGBA_8888, 5)
    }
    reader.setOnImageAvailableListener({ consumeFrame(it) }, Handler(thread.looper))
    val constructor = DisplayManager::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }
    val manager = constructor.newInstance(context)
    val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_SECURE or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
      (1 shl 6) or (1 shl 8) or (1 shl 10) or (1 shl 11) or (1 shl 12)
    val display = manager.createVirtualDisplay(
      "BAAS Game", safeWidth, safeHeight, safeDensity, reader.surface, flags,
    ) ?: throw IllegalStateException("Android rejected the privileged virtual display")
    imageThread = thread
    imageReader = reader
    virtualDisplay = display
    displayWidth = safeWidth
    displayHeight = safeHeight
    return display.display.displayId
  }

  private fun launch(context: Context, packageName: String, displayId: Int): Boolean {
    require(packageName.matches(Regex("[A-Za-z0-9_.]+")))
    val intent = context.packageManager.getLaunchIntentForPackage(packageName)
      ?: context.packageManager.getLeanbackLaunchIntentForPackage(packageName)
      ?: throw IllegalStateException("No launcher activity is available for $packageName")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
    Runtime.getRuntime().exec(arrayOf("am", "force-stop", "--user", "0", packageName)).waitFor()
    val options = ActivityOptions.makeBasic().apply { launchDisplayId = displayId }
    val manager = Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null)
    val method = manager.javaClass.getMethod(
      "startActivityAsUser", Class.forName("android.app.IApplicationThread"), String::class.java,
      Intent::class.java, String::class.java, IBinder::class.java, String::class.java,
      Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Class.forName("android.app.ProfilerInfo"),
      android.os.Bundle::class.java, Int::class.javaPrimitiveType,
    )
    return (method.invoke(manager, null, OWNER_PACKAGE, intent, null, null, null, 0, 0, null, options.toBundle(), -2) as Int) >= 0
  }

  private fun gesture(values: List<Int>): Boolean {
    require(values.size == 5)
    val displayId = virtualDisplay?.display?.displayId ?: return false
    val (x1, y1, x2, y2, duration) = values
    val command = if (x1 == x2 && y1 == y2 && duration <= 250) {
      arrayOf("input", "-d", displayId.toString(), "tap", x1.toString(), y1.toString())
    } else {
      arrayOf("input", "-d", displayId.toString(), "swipe", x1.toString(), y1.toString(), x2.toString(), y2.toString(), duration.toString())
    }
    return Runtime.getRuntime().exec(command).waitFor() == 0
  }

  @Synchronized private fun capture(format: Bitmap.CompressFormat, quality: Int): String {
    val frame = latestFrame ?: return ""
    return ByteArrayOutputStream().use { output ->
      frame.compress(format, quality, output)
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
  }

  private fun consumeFrame(reader: ImageReader) {
    val image = reader.acquireLatestImage() ?: return
    try {
      val now = android.os.SystemClock.uptimeMillis()
      if (now - lastFrameAt < 500L) return
      lastFrameAt = now
      val bitmap = imageToBitmap(image)
      synchronized(this) { latestFrame?.recycle(); latestFrame = bitmap }
    } finally { image.close() }
  }

  private fun imageToBitmap(image: Image): Bitmap {
    val plane = image.planes[0]
    val padded = Bitmap.createBitmap(
      image.width + (plane.rowStride - plane.pixelStride * image.width) / plane.pixelStride,
      image.height, Bitmap.Config.ARGB_8888,
    )
    padded.copyPixelsFromBuffer(plane.buffer)
    if (padded.width == image.width) return padded
    return Bitmap.createBitmap(padded, 0, 0, image.width, image.height).also { padded.recycle() }
  }

  @Synchronized private fun stopDisplay() {
    closeStream(restoreCaptureSurface = false)
    imageReader?.setOnImageAvailableListener(null, null)
    virtualDisplay?.release()
    imageReader?.close()
    imageThread?.quitSafely()
    latestFrame?.recycle()
    virtualDisplay = null; imageReader = null; imageThread = null; latestFrame = null
    displayWidth = 0; displayHeight = 0; lastFrameAt = 0
  }

  @Synchronized private fun openStream(fps: Int, bitrate: Int): Int {
    closeStream()
    val display = virtualDisplay ?: throw IllegalStateException("The virtual display is not running")
    val server = ServerSocket().apply {
      reuseAddress = true
      bind(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 1)
    }
    streamServer = server
    streamThread = Thread({
      try {
        val socket = server.accept()
        synchronized(this) {
          if (streamServer !== server) {
            socket.close()
            return@Thread
          }
          videoStream = H264VideoStream.start(
            display,
            displayWidth.coerceAtLeast(1),
            displayHeight.coerceAtLeast(1),
            fps,
            bitrate,
            socket.getOutputStream(),
          )
        }
      } catch (error: Throwable) {
        if (!server.isClosed) Log.e(TAG, "H.264 stream failed", error)
      } finally {
        runCatching { server.close() }
      }
    }, "baas-system-video-accept").apply {
      isDaemon = true
      start()
    }
    return server.localPort
  }

  @Synchronized private fun closeStream(restoreCaptureSurface: Boolean = true) {
    runCatching { streamServer?.close() }
    videoStream?.close()
    streamThread?.interrupt()
    streamServer = null
    videoStream = null
    streamThread = null
    if (restoreCaptureSurface) {
      val display = virtualDisplay
      val surface = imageReader?.surface
      if (display != null && surface != null) runCatching { display.setSurface(surface) }
    }
  }

  private class IdentityContext(base: Context) : ContextWrapper(base) {
    override fun getPackageName(): String = OWNER_PACKAGE
    override fun getOpPackageName(): String = OWNER_PACKAGE
    override fun getApplicationContext(): Context = this
    override fun getAttributionSource(): AttributionSource =
      AttributionSource.Builder(Process.SYSTEM_UID).setPackageName(OWNER_PACKAGE).build()
  }
}
