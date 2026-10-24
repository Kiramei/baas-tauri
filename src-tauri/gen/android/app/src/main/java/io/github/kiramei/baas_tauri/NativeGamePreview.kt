package io.github.kiramei.baas_tauri

import android.app.Activity
import android.app.Presentation
import android.graphics.drawable.ColorDrawable
import android.hardware.display.DisplayManager
import android.os.SystemClock
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
import android.view.WindowManager
import android.view.MotionEvent
import android.view.InputDevice
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.doOnPreDraw
import java.util.concurrent.Executors

/** Native GPU view above the WebView, positioned by the DOM placeholder, with native controls. */
class NativeGamePreview(private val activity: Activity) {
  private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
  private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
    setStroke(dp(1), palette.border)
  }
  companion object {
    var current: NativeGamePreview? = null
      private set
    internal fun forActivity(activity: Activity): NativeGamePreview? = current?.takeIf { it.activity === activity }
    // Surface detach from an old Activity must complete before its successor's
    // attach. A new Activity must not create another lane around a stuck Binder.
    private val lifecycleWorker = Executors.newSingleThreadExecutor()
  }
  private val worker = lifecycleWorker
  private var destroyed = false
  private var container: FrameLayout? = null
  private var texture: TextureView? = null
  private var surface: Surface? = null
  private var attachedSurface: Surface? = null
  private var controls: FrameLayout? = null
  private var status: TextView? = null
  private var badge: TextView? = null
  private var controlRow: LinearLayout? = null
  private val controlButtons = mutableListOf<Pair<String, ImageButton>>()
  private var palette = NativePreviewPalette.DARK
  private var fullscreen: NativeGameFullscreen? = null
  private var fullscreenDisplayId = -1
  private var manualInputLease: NativeManualInputLease? = null
  internal var cancelPendingFullscreen: (() -> Boolean)? = null
  private var gameWidth = 1280
  private var gameHeight = 720
  private data class InlineLayout(val x: Double, val y: Double, val width: Double, val height: Double,
    val viewportWidth: Double, val enabled: Boolean, val clipTop: Double, val clipBottom: Double)
  private var inlineLayout: InlineLayout? = null
  private var previousAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
  private val touch: NativeTouchDispatcher = NativeTouchDispatcher(activity.applicationContext, ::reportTouchError)
  private var webView: WebView? = null
  private var visible = false
  private var paused = false
  @Volatile private var generation = 0
  @Volatile private var focusGeneration = 0
  private var focusShield: Presentation? = null
  private var focusing = false
  private var focusInputInFlight = false
  private val focusRetry = PreviewFocusRetry()
  private var previewLanguage = "en"
  private val displayedFrames = PreviewDisplayedFrames()

  // Read on the UI thread, alongside TextureView's consumer callback.
  internal fun displayedFrameCount(): Long = displayedFrames.count

  init { current = this }

  internal fun applyTheme(theme: NativePreviewPalette) {
    if (palette == theme) return
    palette = theme
    applyViewColors()
    fullscreen?.applyTheme(theme)
  }

  internal fun isFullscreen(): Boolean = fullscreen != null

  private fun reportTouchError(ticket: Long, error: String) {
    activity.runOnUiThread {
      if (fullscreen != null && touch.isCurrent(ticket)) setStatus(PreviewFrameState.WAITING, error)
    }
  }

  private fun dispatchAction(action: String) {
    webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-game-action',{detail:'$action'}))", null)
  }

  internal fun reportFullscreen(active: Boolean) {
    webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-game-fullscreen',{detail:{active:$active}}))", null)
  }

  internal fun consumeFullscreenBack(): Boolean = exitFullscreen() || cancelPendingFullscreen?.invoke() == true

  internal fun enterFullscreen(displayId: Int, width: Int, height: Int, language: String, lease: NativeManualInputLease) {
    check(displayId > 0 && width > 0 && height > 0 && lease.displayId == displayId && lease.token > 0) { "No active game input lease is available" }
    check(fullscreen == null) { "Fullscreen game control is already active" }
    val host = create()
    val parent = host.parent as ViewGroup
    previewLanguage = language
    gameWidth = width; gameHeight = height; fullscreenDisplayId = displayId
    manualInputLease = lease
    touch.beginSession(displayId, lease.token)
    controls?.visibility = View.GONE; badge?.visibility = View.GONE
    previousAccessibility = webView?.importantForAccessibility ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    webView?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    fullscreen = NativeGameFullscreen(activity, parent, host, width, height, palette, language, { frame ->
      host.clipBounds = null
      val old = host.layoutParams as? FrameLayout.LayoutParams
      if (old == null || old.width != frame.width || old.height != frame.height || old.leftMargin != frame.left || old.topMargin != frame.top) {
        touch.cancel()
        host.layoutParams = FrameLayout.LayoutParams(frame.width, frame.height).apply { leftMargin = frame.left; topMargin = frame.top }
      }
    }, { touch.cancel() }, { exitFullscreen() }, {
      exitFullscreen()
      dispatchAction("close")
    })
    visible = true; host.visibility = View.VISIBLE
    if (surface == null && texture?.isAvailable == true) surface = Surface(texture!!.surfaceTexture)
    attach()
    (activity as? MainActivity)?.setGameFullscreen(true)
    fullscreen?.layout()
    reportFullscreen(true)
  }

  internal fun exitFullscreen(): Boolean {
    val previous = fullscreen
    if (previous == null && manualInputLease == null) return false
    fullscreen = null
    fullscreenDisplayId = -1
    touch.cancel(); previous?.destroy()
    manualInputLease?.close(); manualInputLease = null
    webView?.importantForAccessibility = previousAccessibility
    controls?.visibility = View.GONE; badge?.visibility = View.VISIBLE
    (activity as? MainActivity)?.setGameFullscreen(false)
    inlineLayout?.let { layout -> update(layout.x, layout.y, layout.width, layout.height, layout.viewportWidth,
      layout.enabled, layout.clipTop, layout.clipBottom) }
    reportFullscreen(false)
    return previous != null
  }

  private fun mapTouch(event: MotionEvent, width: Int, height: Int): MotionEvent {
    val properties = Array(event.pointerCount) { MotionEvent.PointerProperties().also { value -> event.getPointerProperties(it, value) } }
    val coordinates = Array(event.pointerCount) { MotionEvent.PointerCoords().also { value ->
      event.getPointerCoords(it, value)
      value.x = FullscreenGeometry.coordinate(value.x, width, gameWidth)
      value.y = FullscreenGeometry.coordinate(value.y, height, gameHeight)
    } }
    return MotionEvent.obtain(event.downTime, event.eventTime, event.action, event.pointerCount, properties, coordinates,
      event.metaState, event.buttonState, event.xPrecision, event.yPrecision, event.deviceId, event.edgeFlags,
      InputDevice.SOURCE_TOUCHSCREEN, event.flags)
  }

  private fun buttonColors(button: ImageButton, primary: Boolean) {
    val foreground = if (primary) palette.primaryForeground else palette.foreground
    button.setColorFilter(foreground)
    button.background = RippleDrawable(ColorStateList.valueOf(palette.alpha(foreground, 48)),
      rounded(if (primary) palette.primary else palette.muted, 18), rounded(Color.WHITE, 18))
  }

  private fun applyViewColors() {
    container?.setBackgroundColor(palette.background)
    controls?.setBackgroundColor(palette.alpha(palette.background, 112))
    controlRow?.background = rounded(palette.alpha(palette.background, 245), 24)
    controlButtons.forEach { (action, button) -> buttonColors(button, action == "fullscreen") }
    status?.setTextColor(palette.foreground)
    status?.setBackgroundColor(palette.alpha(palette.background, 224))
    badge?.setTextColor(palette.mutedForeground)
    badge?.background = rounded(palette.alpha(palette.background, 224), 24)
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private fun create(): FrameLayout {
    check(!destroyed) { "Native preview activity was destroyed" }
    container?.let { return it }
    webView = findWebView(activity.window.decorView)
    val host = FrameLayout(activity).apply {
      setBackgroundColor(palette.background)
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
        if (destroyed) return
        displayedFrames.reset()
        surface = Surface(value)
        attach()
      }
      override fun onSurfaceTextureSizeChanged(value: SurfaceTexture, width: Int, height: Int) = Unit
      override fun onSurfaceTextureUpdated(value: SurfaceTexture) {
        if (visible && !paused && attachedSurface != null) displayedFrames.record(value.timestamp)
      }
      override fun onSurfaceTextureDestroyed(value: SurfaceTexture): Boolean {
        detach()
        return true
      }
    }
    host.addView(view, FrameLayout.LayoutParams(-1, -1))
    val waiting = TextView(activity).apply {
      text = "Waiting for game frames…"; textSize = 13f; setTextColor(palette.foreground)
      gravity = Gravity.CENTER; setPadding(16, 16, 16, 16)
    }
    status = waiting
    host.addView(waiting, FrameLayout.LayoutParams(-1, -1))
    val overlay = FrameLayout(activity).apply {
      setBackgroundColor(palette.alpha(palette.background, 112))
      visibility = View.GONE
      setOnClickListener { visibility = View.GONE; badge?.visibility = View.VISIBLE }
    }
    controls = overlay
    val row = LinearLayout(activity).apply {
      gravity = Gravity.CENTER
      setPadding(dp(6), dp(6), dp(6), dp(6))
      background = rounded(palette.alpha(palette.background, 245), 24)
      elevation = dp(4).toFloat()
    }
    controlRow = row
    val density = activity.resources.displayMetrics.density
    listOf("close" to R.drawable.preview_close,
      "fullscreen" to R.drawable.preview_takeover,
      "restart" to R.drawable.preview_restart).forEach { (action, icon) ->
      val button = ImageButton(activity).apply {
        setImageResource(icon)
        contentDescription = action
        scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
        setPadding(dp(12), dp(12), dp(12), dp(12))
        setOnClickListener {
          overlay.visibility = View.GONE
          badge?.visibility = View.VISIBLE
          dispatchAction(action)
        }
      }
      buttonColors(button, action == "fullscreen")
      controlButtons.add(action to button)
      row.addView(button, LinearLayout.LayoutParams((48 * density).toInt(), (48 * density).toInt()).apply {
        setMargins(dp(3), 0, dp(3), 0)
      })
    }
    overlay.addView(row, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = (12 * density).toInt() })
    host.addView(overlay, FrameLayout.LayoutParams(-1, -1))
    val live = TextView(activity).apply {
      text = "● Live"; textSize = 11f; setTextColor(palette.mutedForeground)
      background = rounded(palette.alpha(palette.background, 224), 24)
      setPadding(dp(10), dp(4), dp(10), dp(4)); isClickable = false
    }
    badge = live
    host.addView(live, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { setMargins(dp(8), dp(8), dp(8), 0) })
    view.setOnClickListener {
      overlay.visibility = if (overlay.visibility == View.VISIBLE) View.GONE else View.VISIBLE
      live.visibility = if (overlay.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }
    view.setOnTouchListener { _, event ->
      if (fullscreen == null) false else {
        if (!paused && !focusing && view.width > 0 && view.height > 0) touch.submit(mapTouch(event, view.width, view.height))
        true
      }
    }
    val parent = activity.findViewById<ViewGroup>(android.R.id.content)
    parent.addView(host, FrameLayout.LayoutParams(1, 1))
    container = host
    applyViewColors()
    return host
  }

  fun update(x: Double, y: Double, width: Double, height: Double, viewportWidth: Double, enabled: Boolean, clipTop: Double, clipBottom: Double, focusDisplayId: Int = -1) {
    if (destroyed) return
    if (fullscreen != null) {
      // DOM geometry may disappear or rotate behind native fullscreen. It cannot
      // hide/reparent the active game or resurrect the old portrait layout.
      if (paused) { container?.visibility = View.GONE; touch.cancel(); return }
      container?.visibility = View.VISIBLE
      fullscreen?.layout()
      attach()
      recoverFocus(focusDisplayId)
      return
    }
    inlineLayout = InlineLayout(x, y, width, height, viewportWidth, enabled, clipTop, clipBottom)
    visible = enabled
    if (!enabled || paused || width <= 0 || height <= 0) {
      container?.visibility = View.GONE
      cancelFocusRecovery()
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
    val layout = FrameLayout.LayoutParams((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1)).apply {
      leftMargin = webLocation[0] - parentLocation[0] + (x * scale).toInt()
      topMargin = webLocation[1] - parentLocation[1] + (y * scale).toInt()
    }
    val previous = host.layoutParams as? FrameLayout.LayoutParams
    if (previous == null || previous.width != layout.width || previous.height != layout.height ||
      previous.leftMargin != layout.leftMargin || previous.topMargin != layout.topMargin) {
      host.layoutParams = layout
    }
    host.visibility = View.VISIBLE
    if (surface == null && texture?.isAvailable == true) surface = Surface(texture!!.surfaceTexture)
    if (surface != null) attach()
    recoverFocus(focusDisplayId)
  }

  private fun recoverFocus(displayId: Int) {
    if (displayId <= 0 || focusing || touch.hasGesture()) return
    if (!focusRetry.acquire(displayId, SystemClock.uptimeMillis())) return
    val ticket = ++focusGeneration
    focusing = true
    if (!PrivilegedExecution.usesTargetedFocusInput(android.os.Build.VERSION.SDK_INT)) {
      // TYPE_PRESENTATION is behind application tasks on Android 12. The
      // privileged service owns, verifies and removes its higher input shield.
      focusInputInFlight = true
      worker.execute {
        val recovered = runCatching {
          if (ticket != focusGeneration) return@runCatching false
          check(ShizukuController.focusPreviewWindow(activity, displayId)) { "The privileged BAAS focus shield did not acknowledge DOWN+CANCEL" }
          if (ticket != focusGeneration) return@runCatching false
          ShizukuController.focusGameTask(activity, displayId)
          true
        }.onFailure { android.util.Log.w("BaasNativePreview", "Game focus recovery failed", it) }
        activity.runOnUiThread {
          if (ticket == focusGeneration) focusRetry.finish(recovered.getOrDefault(false), SystemClock.uptimeMillis())
          focusInputInFlight = false; focusing = false
        }
      }
      return
    }
    worker.execute {
      val display = runCatching { activity.getSystemService(DisplayManager::class.java).getDisplay(displayId) }
      activity.runOnUiThread {
        if (ticket != focusGeneration || worker.isShutdown) return@runOnUiThread
        val target = display.getOrNull()
        if (target == null) {
          cancelFocusRecovery(resetRetry = false)
          focusRetry.finish(false, SystemClock.uptimeMillis())
        } else showFocusShield(displayId, target, ticket)
      }
    }
  }

  private fun showFocusShield(displayId: Int, display: android.view.Display, ticket: Int) {
    try {
      val shield = Presentation(activity, display)
      focusShield = shield
      shield.setCancelable(false)
      val handshake = PreviewFocusHandshake()
      val view = View(shield.context).apply { setOnTouchListener { _, event ->
        when (event.actionMasked) {
          android.view.MotionEvent.ACTION_DOWN -> handshake.recordDown()
          android.view.MotionEvent.ACTION_CANCEL -> handshake.recordCancel()
        }
        true
      } }
      shield.setContentView(view)
      shield.window?.setTitle(PrivilegedExecution.FOCUS_SHIELD_TITLE)
      shield.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      shield.window?.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      // Untrusted displays require a touch before they may receive focus. Route
      // it only to our own UID (or verified shield on Android 12), then focus
      // the game after our View acknowledges DOWN+CANCEL and we remove it.
      // Input windows are published after drawing; injection before that is rejected.
      view.doOnPreDraw { view.postDelayed({
        if (ticket != focusGeneration || worker.isShutdown) return@postDelayed
        focusInputInFlight = true
        worker.execute {
          val accepted = runCatching {
            ticket == focusGeneration && ShizukuController.focusPreviewWindow(activity, displayId)
          }
          activity.runOnUiThread {
            shield.dismiss()
            if (focusShield === shield) focusShield = null
            focusInputInFlight = false
            focusing = false
            if (ticket != focusGeneration || worker.isShutdown) return@runOnUiThread
            worker.execute focusGame@{
              if (ticket != focusGeneration) return@focusGame
              val recovered = runCatching {
                check(accepted.getOrThrow() && handshake.complete()) { "The BAAS focus window did not acknowledge DOWN+CANCEL" }
                ShizukuController.focusGameTask(activity, displayId)
              }.onFailure { android.util.Log.w("BaasNativePreview", "Game focus recovery failed", it) }
              activity.runOnUiThread {
                if (ticket == focusGeneration) focusRetry.finish(recovered.isSuccess, SystemClock.uptimeMillis())
              }
            }
          }
        }
      }, 300L) }
      shield.show()
      // Dialog.show can restore the context package as its initial title.
      shield.window?.setTitle(PrivilegedExecution.FOCUS_SHIELD_TITLE)
      shield.window?.setLayout(-1, -1)
    } catch (error: Exception) {
      cancelFocusRecovery(resetRetry = false)
      focusRetry.finish(false, SystemClock.uptimeMillis())
      android.util.Log.w("BaasNativePreview", "Unable to create the BAAS focus window", error)
    }
  }

  private fun cancelFocusRecovery(resetRetry: Boolean = true) {
    ++focusGeneration
    // A real hide/show or a new display gets an immediate fresh opportunity.
    if (resetRetry) focusRetry.reset()
    // In Android 12 untargeted DOWN may already be queued. Keep its consuming
    // window alive until the worker has sent CANCEL, even when UI is hidden.
    if (focusInputInFlight) return
    focusShield?.dismiss()
    focusShield = null
    focusing = false
  }

  private fun attach() {
    if (destroyed) return
    val target = surface ?: return
    if (!visible || paused) return
    if (attachedSurface === target) return
    attachedSurface = target
    val ticket = ++generation
    worker.execute {
      if (ticket != generation) return@execute
      runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, target) }
        .onFailure {
          android.util.Log.w("BaasNativePreview", "Preview attach failed", it)
          activity.runOnUiThread {
            if (ticket == generation) {
              attachedSurface = null
              setStatus(PreviewFrameState.WAITING, it.message)
            }
          }
        }
    }
  }

  private fun detach() {
    if (surface == null) return
    ++generation
    attachedSurface = null
    val old = surface
    surface = null
    worker.execute {
      runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, null) }
      old?.release()
    }
  }

  fun pause() {
    if (destroyed) return
    touch.cancel()
    cancelFocusRecovery()
    paused = true; container?.visibility = View.GONE
    // Keep the TextureView's Surface for resume; only disconnect the remote renderer.
    ++generation
    attachedSurface = null
    worker.execute { runCatching { ShizukuController.setPreviewSurface(activity.applicationContext, null) } }
  }
  internal fun setStatus(state: PreviewFrameState, error: String?, language: String? = null) {
    if (language != null) previewLanguage = language
    val chinese = previewLanguage.startsWith("zh")
    val label = when (state) {
      PreviewFrameState.WAITING -> if (chinese) "等待画面" else "Waiting for frames"
      PreviewFrameState.BLACK -> if (chinese) "黑屏" else "Black screen"
      PreviewFrameState.STILL -> if (chinese) "画面未更新" else "No frame updates"
      PreviewFrameState.LIVE -> if (chinese) "实时" else "Live"
    }
    status?.visibility = if (error != null || state == PreviewFrameState.WAITING || state == PreviewFrameState.BLACK) View.VISIBLE else View.GONE
    status?.text = error ?: label
    badge?.text = if (error != null) (if (chinese) "连接异常" else "Preview error") else label
  }
  fun resume() { if (destroyed) return; paused = false; if (visible) { container?.visibility = View.VISIBLE; attach() } }
  fun destroy() {
    if (destroyed) return
    destroyed = true
    consumeFullscreenBack(); reportFullscreen(false); touch.close(); visible = false
    cancelFocusRecovery(); detach()
    (container?.parent as? ViewGroup)?.removeView(container)
    container = null; cancelPendingFullscreen = null
    if (current === this) current = null
  }
}
