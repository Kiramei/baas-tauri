package io.github.kiramei.baas_tauri

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Point
import android.os.IBinder
import android.os.Looper
import android.view.Display
import android.view.MotionEvent
import android.view.SurfaceControl
import android.view.SurfaceControlViewHost
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager

/** A temporary input surface hosted by our own window, on our owned display only. */
internal class NativeFocusSurface private constructor(
  private val root: SurfaceControl,
  private val host: SurfaceControlViewHost,
) : AutoCloseable {
  private var closed = false

  override fun close() {
    if (closed) return
    closed = true
    closeResources(root, host)
  }

  companion object {
    private fun setVisible(root: SurfaceControl, visible: Boolean) {
      SurfaceControl.Transaction().use { transaction ->
        SurfaceControl.Transaction::class.java.getMethod(if (visible) "show" else "hide", SurfaceControl::class.java)
          .invoke(transaction, root)
        transaction.apply()
      }
    }

    private fun closeResources(root: SurfaceControl, host: SurfaceControlViewHost?) {
      // Every resource has its own finally: an input-channel teardown failure
      // must not leave a visible surface or prevent the WM host's later removal.
      try {
        if (root.isValid) setVisible(root, false)
      } finally {
        try { host?.release() } finally {
          try {
            if (root.isValid) SurfaceControl.Transaction().use { transaction ->
              SurfaceControl.Transaction::class.java.getMethod("remove", SurfaceControl::class.java)
                .invoke(transaction, root)
              transaction.apply()
            }
          } finally { root.release() }
        }
      }
    }

    @SuppressLint("BlockedPrivateApi", "DiscouragedPrivateApi")
    fun create(
      context: Context,
      display: Display,
      ownWindow: View,
      cancelled: () -> Boolean,
      onDown: () -> Unit,
      onCancel: () -> Unit,
      onReady: () -> Unit,
      onFailure: (Throwable) -> Unit,
    ): NativeFocusSurface {
      check(Looper.myLooper() == Looper.getMainLooper()) { "Focus surfaces require the UI thread" }
      check(android.os.Build.VERSION.SDK_INT in 31..32 && android.os.Process.myUid() == android.os.Process.SHELL_UID) {
        "Focus surfaces require the Android 12 shell service"
      }
      val displayId = PrivilegedExecution.virtualDisplayId(display.displayId)
      check(display.isValid && ownWindow.isAttachedToWindow && ownWindow.display?.displayId == displayId) {
        "The owned focus host disappeared"
      }
      val displayManager = context.getSystemService(android.hardware.display.DisplayManager::class.java)
      val primary = checkNotNull(displayManager.getDisplay(Display.DEFAULT_DISPLAY))
      check(primary.isValid) { "The primary display stack could not be verified" }
      val layerStackMethod = Display::class.java.getDeclaredMethod("getLayerStack").apply { isAccessible = true }
      val layerStack = PrivilegedExecution.focusSurfaceLayerStack(displayId,
        layerStackMethod.invoke(display) as Int, layerStackMethod.invoke(primary) as Int)
      val viewRoot = checkNotNull(View::class.java.getDeclaredMethod("getViewRootImpl").apply {
        isAccessible = true
      }.invoke(ownWindow)) { "The owned focus window has no ViewRoot" }
      // A window/client token is not its input-channel token. Only our existing
      // shield's channel lets WMS raise the correct display after the handshake.
      val inputToken = checkNotNull(viewRoot.javaClass.getMethod("getInputToken").invoke(viewRoot) as? IBinder) {
        "The owned focus window has no input channel"
      }
      val size = Point().also { display.getRealSize(it) }
      check(size.x > 64 && size.y > 64) { "The owned display is too small for the focus handshake" }
      val builder = SurfaceControl.Builder().setName(PrivilegedExecution.FOCUS_SHIELD_TITLE)
      // Never publish a default-stack surface, even during construction failures.
      SurfaceControl.Builder::class.java.getMethod("setHidden", Boolean::class.javaPrimitiveType).invoke(builder, true)
      SurfaceControl.Builder::class.java.getMethod("setContainerLayer").invoke(builder)
      val root = builder.build()
      var host: SurfaceControlViewHost? = null
      try {
        SurfaceControl.Transaction().use { transaction ->
          SurfaceControl.Transaction::class.java.getMethod("setLayerStack", SurfaceControl::class.java,
            Int::class.javaPrimitiveType).invoke(transaction, root, layerStack)
          transaction.setLayer(root, Int.MAX_VALUE).apply()
        }
        val windowless = Class.forName("android.view.WindowlessWindowManager")
        val manager = windowless.getConstructor(Configuration::class.java, SurfaceControl::class.java,
          IBinder::class.java).newInstance(context.resources.configuration, root, inputToken)
        host = SurfaceControlViewHost::class.java.getConstructor(Context::class.java, Display::class.java,
          windowless).newInstance(context, display, manager) as SurfaceControlViewHost
        val surface = NativeFocusSurface(root, host)
        val view = View(context).apply {
          setBackgroundColor(Color.TRANSPARENT)
          setOnTouchListener { _, event ->
            when (event.actionMasked) {
              MotionEvent.ACTION_DOWN -> onDown()
              MotionEvent.ACTION_CANCEL -> onCancel()
            }
            true
          }
        }
        view.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
          override fun onPreDraw(): Boolean {
            view.viewTreeObserver.removeOnPreDrawListener(this)
            if (cancelled()) return true
            try {
              setVisible(root, true)
              view.postDelayed({ if (!cancelled()) onReady() }, 300L)
            } catch (error: Throwable) { onFailure(error) }
            return true
          }
        })
        val attributes = WindowManager.LayoutParams(size.x, size.y,
          PrivilegedExecution.FOCUS_SHIELD_WINDOW_TYPE, WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
          PixelFormat.TRANSLUCENT).apply { title = PrivilegedExecution.FOCUS_SHIELD_TITLE }
        SurfaceControlViewHost::class.java.getMethod("setView", View::class.java,
          WindowManager.LayoutParams::class.java).invoke(host, view, attributes)
        return surface
      } catch (error: Throwable) {
        try { closeResources(root, host) } catch (cleanupError: Throwable) { error.addSuppressed(cleanupError) }
        throw error
      }
    }
  }
}
