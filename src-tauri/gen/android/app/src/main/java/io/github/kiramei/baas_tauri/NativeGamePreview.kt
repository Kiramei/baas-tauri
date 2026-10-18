package io.github.kiramei.baas_tauri

import android.app.Activity
import android.graphics.Color
import android.graphics.Outline
import android.graphics.SurfaceTexture
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/** Native GPU view above the WebView, positioned by the DOM placeholder, with native controls. */
class NativeGamePreview(private val activity: Activity) {
  private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
  private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
    setStroke(dp(1), 0x22ffffff)
  }
  companion object { var current: NativeGamePreview? = null }
  private val worker = Executors.newSingleThreadExecutor()
  private var container: FrameLayout? = null
  private var texture: TextureView? = null
  private var surface: Surface? = null
  private var controls: FrameLayout? = null
  private var status: TextView? = null
  private var badge: TextView? = null
  private var webView: WebView? = null
  private var visible = false
  private var paused = false
  @Volatile private var generation = 0

  init { current = this }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private fun create(): FrameLayout {
    container?.let { return it }
    webView = findWebView(activity.window.decorView)
    val host = FrameLayout(activity).apply {
      setBackgroundColor(Color.BLACK)
      clipToOutline = true
      outlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
          outline.setRoundRect(0, 0, view.width, view.height, 12 * resources.displayMetrics.density)
        }
      }
    }
    val view = TextureView(activity)
    texture = view
    view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(value: SurfaceTexture, width: Int, height: Int) {
        surface = Surface(value)
        attach()
      }
      override fun onSurfaceTextureSizeChanged(value: SurfaceTexture, width: Int, height: Int) = Unit
      override fun onSurfaceTextureUpdated(value: SurfaceTexture) = Unit
      override fun onSurfaceTextureDestroyed(value: SurfaceTexture): Boolean {
        detach()
        return true
      }
    }
    host.addView(view, FrameLayout.LayoutParams(-1, -1))
    val waiting = TextView(activity).apply {
      text = "Waiting for game frames…"; textSize = 13f; setTextColor(Color.WHITE)
      gravity = Gravity.CENTER; setPadding(16, 16, 16, 16)
    }
    status = waiting
    host.addView(waiting, FrameLayout.LayoutParams(-1, -1))
    val overlay = FrameLayout(activity).apply {
      setBackgroundColor(0x66000000)
      visibility = View.GONE
      setOnClickListener { visibility = View.GONE; badge?.visibility = View.VISIBLE }
    }
    controls = overlay
    val row = LinearLayout(activity).apply {
      gravity = Gravity.CENTER
      setPadding(dp(6), dp(6), dp(6), dp(6))
      background = rounded(0xdd101827.toInt(), 24)
      elevation = dp(4).toFloat()
    }
    val density = activity.resources.displayMetrics.density
    listOf("close" to R.drawable.preview_close,
      "takeover" to R.drawable.preview_takeover,
      "restart" to R.drawable.preview_restart).forEach { (action, icon) ->
      val button = ImageButton(activity).apply {
        setImageResource(icon)
        setColorFilter(Color.WHITE)
        contentDescription = action
        scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
        setPadding(dp(12), dp(12), dp(12), dp(12))
        background = RippleDrawable(ColorStateList.valueOf(0x44ffffff),
          rounded(if (action == "takeover") 0xff0891b2.toInt() else 0xff263449.toInt(), 18),
          rounded(Color.WHITE, 18))
        setOnClickListener {
          overlay.visibility = View.GONE
          badge?.visibility = View.VISIBLE
          webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-game-action',{detail:'$action'}))", null)
        }
      }
      row.addView(button, LinearLayout.LayoutParams((48 * density).toInt(), (48 * density).toInt()).apply {
        setMargins(dp(3), 0, dp(3), 0)
      })
    }
    overlay.addView(row, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = (12 * density).toInt() })
    host.addView(overlay, FrameLayout.LayoutParams(-1, -1))
    val live = TextView(activity).apply {
      text = "● Live"; textSize = 11f; setTextColor(Color.WHITE)
      background = rounded(0xcc101827.toInt(), 24)
      setPadding(dp(10), dp(4), dp(10), dp(4)); isClickable = false
    }
    badge = live
    host.addView(live, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { setMargins(dp(8), dp(8), dp(8), 0) })
    view.setOnClickListener {
      overlay.visibility = if (overlay.visibility == View.VISIBLE) View.GONE else View.VISIBLE
      live.visibility = if (overlay.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }
    val parent = activity.findViewById<ViewGroup>(android.R.id.content)
    parent.addView(host, FrameLayout.LayoutParams(1, 1))
    container = host
    return host
  }

  fun update(x: Double, y: Double, width: Double, height: Double, viewportWidth: Double, enabled: Boolean, clipTop: Double, clipBottom: Double) {
    visible = enabled
    if (!enabled || paused || width <= 0 || height <= 0) {
      container?.visibility = View.GONE
      detach()
      return
    }
    val host = create()
    val web = webView ?: return
    val webLocation = IntArray(2); val parentLocation = IntArray(2)
    web.getLocationOnScreen(webLocation)
    (host.parent as View).getLocationOnScreen(parentLocation)
    val scale = web.width.toDouble() / viewportWidth.coerceAtLeast(1.0)
    host.clipBounds = android.graphics.Rect(0, (clipTop * scale).toInt(), (width * scale).toInt(), ((height - clipBottom) * scale).toInt())
    host.layoutParams = FrameLayout.LayoutParams((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1)).apply {
      leftMargin = webLocation[0] - parentLocation[0] + (x * scale).toInt()
      topMargin = webLocation[1] - parentLocation[1] + (y * scale).toInt()
    }
    host.visibility = View.VISIBLE
    if (surface == null && texture?.isAvailable == true) surface = Surface(texture!!.surfaceTexture)
    if (surface != null) attach()
  }

  private fun attach() {
    val target = surface ?: return
    if (!visible || paused) return
    val ticket = ++generation
    worker.execute {
      if (ticket != generation) return@execute
      runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, target) }
        .onFailure {
          android.util.Log.w("BaasNativePreview", "Preview attach failed", it)
          activity.runOnUiThread { setStatus(false, it.message) }
        }
    }
  }

  private fun detach() {
    if (surface == null) return
    ++generation
    val old = surface
    surface = null
    worker.execute {
      runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, null) }
      old?.release()
    }
  }

  fun pause() {
    paused = true; container?.visibility = View.GONE
    // Keep the TextureView's Surface for resume; only disconnect the remote renderer.
    ++generation
    worker.execute { runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, null) } }
  }
  fun setStatus(ready: Boolean, error: String?) {
    status?.visibility = if (ready) View.GONE else View.VISIBLE
    status?.text = error ?: "Waiting for game frames…"
  }
  fun resume() { paused = false; if (visible) { container?.visibility = View.VISIBLE; attach() } }
  fun destroy() { visible = false; detach(); (container?.parent as? ViewGroup)?.removeView(container); container = null; worker.shutdown(); if (current === this) current = null }
}
