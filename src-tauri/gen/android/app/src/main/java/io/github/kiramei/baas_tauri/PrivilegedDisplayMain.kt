package io.github.kiramei.baas_tauri

import android.app.ActivityOptions
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Base64
import android.util.Log
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.io.PrintWriter

@Keep
object PrivilegedDisplayMain {
  private const val TAG = "BaasPrivilegedDisplay"
  private const val OWNER_PACKAGE = "android"
  private var virtualDisplay: VirtualDisplay? = null
  private var displayWidth = 0
  private var displayHeight = 0
  @Volatile private var activePackage = ""
  private val touchSession = OwnedDisplayTouch(android.os.SystemClock::uptimeMillis, DisplayInput::touchEvent)
  private val inputGate = ManualInputGate(touchSession::cancelStream)
  private val manualLeases = ManualInputLeaseHost(inputGate) { check(touchSession.cancelStream()) { "Manual touch cancellation failed" } }
  private val shellPermits = mutableMapOf<Long, AutoCloseable>()
  private var nextShellPermit = 0L

  @JvmStatic
  fun main(args: Array<String>) {
    val output = PrintWriter(System.out, true)
    try {
      check(Process.myUid() == Process.SYSTEM_UID || Process.myUid() == Process.ROOT_UID) {
        "Privileged backend did not start with a supported identity"
      }
      val systemContext = systemContext()
      NativeDisplayCapture.load(args[0])
      val endpoint = object : INativeDisplayEndpoint.Stub() {
        private fun authorize() {
          check(android.os.Binder.getCallingUid() == args[2].toInt()) { "Unexpected preview client" }
        }
        override fun setPreviewSurface(surface: android.view.Surface?) = PrivilegedExecution.binderResult {
          authorize(); NativeDisplayCapture.setPreviewSurface(surface)
        }
        override fun frameCount(): Long = PrivilegedExecution.binderResult { authorize(); NativeDisplayCapture.frameCount() }
        override fun previewFrameCount(): Long = PrivilegedExecution.binderResult { authorize(); NativeDisplayCapture.previewFrameCount() }
        override fun hasVisibleFrame(): Boolean = PrivilegedExecution.binderResult { authorize(); NativeDisplayCapture.hasVisibleFrame() }
        override fun currentPackage(): String = PrivilegedExecution.binderResult { authorize(); activePackage }
        override fun topPackage(): String = PrivilegedExecution.binderResult {
          authorize()
          val identity = android.os.Binder.clearCallingIdentity()
          try {
            virtualDisplay?.display?.displayId?.let { GameTaskTransfer.topPackage(it) }.orEmpty()
          } finally { android.os.Binder.restoreCallingIdentity(identity) }
        }
        override fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean = PrivilegedExecution.binderResult {
          authorize()
          val id = virtualDisplay?.display?.displayId ?: -1
          inputGate.automation(id) { DisplayInput.gesture(id, x1, y1, x2, y2, durationMs) }
        }
        override fun pinch(inward: Boolean, percent: Int, durationMs: Int): Boolean = PrivilegedExecution.binderResult {
          authorize()
          val id = virtualDisplay?.display?.displayId ?: -1
          inputGate.automation(id) { DisplayInput.pinch(id, displayWidth, displayHeight, inward, percent, durationMs) }
        }
        override fun touch(expectedDisplayId: Int, leaseId: Long, event: android.view.MotionEvent): Boolean = PrivilegedExecution.binderResult {
          authorize()
          val identity = android.os.Binder.clearCallingIdentity()
          try {
            val frame = DisplayInput.touchFrame(event)
            inputGate.manual(expectedDisplayId, leaseId, frame) { touchSession.send(expectedDisplayId, frame) }
          } finally { android.os.Binder.restoreCallingIdentity(identity) }
        }
        override fun acquireManualInput(expectedDisplayId: Int, owner: IBinder): Long = PrivilegedExecution.binderResult {
          authorize()
          val identity = android.os.Binder.clearCallingIdentity()
          try { manualLeases.acquire(expectedDisplayId, owner) } finally { android.os.Binder.restoreCallingIdentity(identity) }
        }
        override fun releaseManualInput(expectedDisplayId: Int, leaseId: Long): Boolean = PrivilegedExecution.binderResult {
          authorize()
          val identity = android.os.Binder.clearCallingIdentity()
          try { manualLeases.release(expectedDisplayId, leaseId) } finally { android.os.Binder.restoreCallingIdentity(identity) }
        }
        override fun resumeAutomation(expectedDisplayId: Int): Boolean = PrivilegedExecution.binderResult {
          authorize(); inputGate.resumeAutomation(expectedDisplayId)
        }
      }
      publishEndpoint("${args[1]}.native-display", endpoint)
      System.`in`.bufferedReader().forEachLine { line ->
        try {
          val parts = line.split(' ')
          val result = when (parts.firstOrNull()) {
            "PING" -> "pong"
            "PUBLISH" -> { publishEndpoint("${args[1]}.native-display", endpoint); "" }
            "SHELL_BEGIN" -> {
              check(shellPermits.size < 16) { "Too many outstanding automation shell calls" }
              val permit = checkNotNull(inputGate.shellPermit()) { "The owned display cannot safely accept automation input" }
              val token = ++nextShellPermit
              shellPermits[token] = permit
              token.toString()
            }
            "SHELL_END" -> {
              checkNotNull(shellPermits.remove(parts[1].toLong())) { "Unknown automation shell permit" }.close()
              ""
            }
            "START" -> startDisplay(systemContext, parts[1].toInt(), parts[2].toInt(), parts[3].toInt()).toString()
            "STOP" -> { stopDisplay(); "" }
            "ID" -> (virtualDisplay?.display?.displayId ?: -1).toString()
            "SIZE" -> "$displayWidth,$displayHeight"
            "CAPTURE" -> capture(Bitmap.CompressFormat.PNG, 100)
            "PREVIEW" -> capture(Bitmap.CompressFormat.JPEG, 76)
            "OPEN_STREAM" -> throw UnsupportedOperationException("Use native preview; capture output cannot be reassigned to an encoder")
            "CLOSE_STREAM" -> ""
            "GESTURE" -> gesture(parts.drop(1).map(String::toInt)).toString()
            "KEY" -> {
              val id = virtualDisplay?.display?.displayId ?: -1
              inputGate.automation(id) { DisplayInput.key(id, parts[1].toInt()) }.toString()
            }
            "LAUNCH" -> launch(systemContext, parts[1], parts[2].toInt()).toString()
            "TRANSFER" -> {
              check(parts[1] == activePackage) { "The selected game is not active" }
              inputGate.invalidate({ touchSession.deactivate() })
              try {
                GameTaskTransfer.move(parts[1], virtualDisplay?.display?.displayId ?: -1, parts[2].toInt())
              } catch (error: Throwable) {
                touchSession.activate(activePackage)
                inputGate.activate(virtualDisplay?.display?.displayId ?: -1)
                throw error
              }
              activePackage = ""
              ""
            }
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
      shellPermits.values.forEach { runCatching { it.close() } }
      shellPermits.clear()
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

  private fun publishEndpoint(authority: String, endpoint: IBinder) {
    // app_process is not an ActivityManager-registered application. The normal
    // ContentResolver path passes an unregistered IApplicationThread and is rejected.
    val manager = Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null)
    val token = android.os.Binder()
    val acquire = manager.javaClass.methods.first { it.name == "getContentProviderExternal" && it.parameterCount == 4 }
    val holder = acquire.invoke(manager, authority, 0, token, authority)
      ?: throw IllegalStateException("Native preview bootstrap provider is unavailable")
    try {
      val provider = holder.javaClass.getField("provider").get(holder)
      val extras = android.os.Bundle().apply { putBinder("endpoint", endpoint) }
      val calls = provider.javaClass.methods.filter { it.name == "call" }
      // New Android releases retain deprecated overloads whose authority is
      // "unknown". Select the current signature, never the first reflected one.
      val call = when {
        android.os.Build.VERSION.SDK_INT >= 31 -> calls.first { it.parameterTypes[0].name == "android.content.AttributionSource" }
        android.os.Build.VERSION.SDK_INT == 30 -> calls.first { it.parameterCount == 6 }
        android.os.Build.VERSION.SDK_INT == 29 -> calls.first { it.parameterCount == 5 }
        else -> calls.first { it.parameterCount == 4 }
      }
      val arguments: Array<Any?> = when {
        call.parameterTypes[0].name == "android.content.AttributionSource" -> arrayOf(
          AttributionSource.Builder(Process.myUid()).setPackageName(OWNER_PACKAGE).build(), authority, "publish", null, extras)
        call.parameterCount == 6 -> arrayOf(OWNER_PACKAGE, null, authority, "publish", null, extras)
        call.parameterCount == 5 -> arrayOf(OWNER_PACKAGE, authority, "publish", null, extras)
        else -> arrayOf(OWNER_PACKAGE, "publish", null, extras)
      }
      call.invoke(provider, *arguments)
    } finally {
      manager.javaClass.getMethod("removeContentProviderExternal", String::class.java, IBinder::class.java).invoke(manager, authority, token)
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
    val safeWidth = width.coerceIn(640, 3840)
    val safeHeight = height.coerceIn(360, 2160)
    val safeDensity = density.coerceIn(120, 640)
    virtualDisplay?.display?.displayId?.let { id ->
      check(inputGate.canPrepare(id)) { "A manual view or automated input is still using the owned display" }
      if (displayWidth == safeWidth && displayHeight == safeHeight) return PrivilegedExecution.virtualDisplayId(id)
    }
    stopDisplay()
    val captureSurface = NativeDisplayCapture.start(safeWidth, safeHeight)
    val constructor = DisplayManager::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }
    val manager = constructor.newInstance(context)
    val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_SECURE or
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
      (1 shl 6) or (1 shl 8) or (1 shl 11) or (1 shl 12)
    val display = try {
      manager.createVirtualDisplay(
        "BAAS Game", safeWidth, safeHeight, safeDensity, captureSurface, PrivilegedExecution.trustedDisplayFlags(flags, android.os.Build.VERSION.SDK_INT),
      ) ?: throw IllegalStateException("Android rejected the privileged virtual display")
    } catch (error: Throwable) {
      runCatching { NativeDisplayCapture.stop() }
      throw error
    } finally {
      captureSurface.release()
    }
    virtualDisplay = display
    displayWidth = safeWidth
    displayHeight = safeHeight
    touchSession.own(display.display.displayId, safeWidth, safeHeight)
    inputGate.own(display.display.displayId)
    return PrivilegedExecution.virtualDisplayId(display.display.displayId)
  }

  private fun launch(context: Context, packageName: String, displayId: Int): Boolean {
    PrivilegedExecution.virtualDisplayId(displayId)
    check(virtualDisplay?.display?.displayId == displayId) { "The requested game display is no longer active" }
    require(packageName.matches(Regex("[A-Za-z0-9_.]+")))
    return inputGate.automation(displayId, requireActive = false) {
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
    val success = (method.invoke(manager, null, OWNER_PACKAGE, intent, null, null, null, 0, 0, null, options.toBundle(), -2) as Int) >= 0
    if (success) {
      activePackage = packageName
      touchSession.activate(packageName)
      inputGate.activate(displayId)
    }
    success
    }
  }

  private fun gesture(values: List<Int>): Boolean {
    require(values.size == 5)
    val displayId = virtualDisplay?.display?.displayId ?: return false
    val (x1, y1, x2, y2, duration) = values
    return inputGate.automation(displayId) { DisplayInput.gesture(displayId, x1, y1, x2, y2, duration) }
  }

  @Synchronized private fun capture(format: Bitmap.CompressFormat, quality: Int): String {
    val frame = NativeDisplayCapture.captureBitmap() ?: throw IllegalStateException("No game frame has been captured yet")
    return try { ByteArrayOutputStream().use { output ->
      frame.compress(format, quality, output)
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    } } finally { frame.recycle() }
  }


  @Synchronized private fun stopDisplay() {
    inputGate.invalidate({ touchSession.clear() }, closed = true)
    virtualDisplay?.release()
    NativeDisplayCapture.stop()
    virtualDisplay = null
    activePackage = ""
    displayWidth = 0; displayHeight = 0
  }


  private class IdentityContext(base: Context) : ContextWrapper(base) {
    override fun getPackageName(): String = OWNER_PACKAGE
    override fun getOpPackageName(): String = OWNER_PACKAGE
    override fun getApplicationContext(): Context = this
    override fun getAttributionSource(): AttributionSource =
      AttributionSource.Builder(Process.SYSTEM_UID).setPackageName(OWNER_PACKAGE).build()
  }
}
