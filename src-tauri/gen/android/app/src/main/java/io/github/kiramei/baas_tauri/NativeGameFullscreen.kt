package io.github.kiramei.baas_tauri

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Chrome beside the existing TextureView host. The host is never detached or reparented. */
internal class NativeGameFullscreen(private val activity: Activity, private val parent: ViewGroup,
  host: View, private val gameWidth: Int, private val gameHeight: Int,
  private var palette: NativePreviewPalette, private val language: String,
  private val onFrame: (FullscreenFrame) -> Unit, private val cancelTouch: () -> Unit,
  private val onReturn: () -> Unit, private val onCloseGame: () -> Unit) {
  private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
  private val chinese = language.startsWith("zh")
  private val backdrop = View(activity).apply { isClickable = true }
  private val chrome = FrameLayout(activity)
  private val dismissMenu = View(activity).apply {
    visibility = View.GONE; isClickable = true
    setOnClickListener { setMenu(false) }
  }
  private val menu = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; elevation = dp(10).toFloat() }
  private val floating = TextView(activity).apply {
    text = "⋮"; textSize = 26f; gravity = Gravity.CENTER
    contentDescription = if (chinese) "游戏菜单" else "Game menu"
    elevation = dp(6).toFloat()
  }
  private val entries = mutableListOf<TextView>()
  private val coexistenceHint = TextView(activity).apply {
    text = if (chinese) "手操不暂停脚本；脚本输入优先" else "Scripts keep running; script input takes priority"
    textSize = 12f
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(18), dp(8), dp(18), dp(8))
    isClickable = false; isFocusable = false
  }
  private var safe = FullscreenFrame(0, 0, 1, 1)
  private var positioned = false
  private var destroyed = false
  private val layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layout() }

  init {
    try {
    parent.addView(backdrop, parent.indexOfChild(host).coerceAtLeast(0), FrameLayout.LayoutParams(-1, -1))
    chrome.addView(dismissMenu, FrameLayout.LayoutParams(-1, -1))
    menu.addView(coexistenceHint, LinearLayout.LayoutParams(-1, dp(60)))
    listOf((if (chinese) "返回内嵌画面" else "Return to preview") to onReturn,
      (if (chinese) "关闭游戏" else "Close game") to onCloseGame).forEach { (label, action) ->
      val entry = TextView(activity).apply {
        text = label; textSize = 15f; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(18), 0, dp(18), 0); isClickable = true
        setOnClickListener { cancelTouch(); setMenu(false); action() }
      }
      entries.add(entry)
      menu.addView(entry, LinearLayout.LayoutParams(-1, dp(56)))
    }
    chrome.addView(menu, FrameLayout.LayoutParams(dp(220), -2))
    chrome.addView(floating, FrameLayout.LayoutParams(dp(48), dp(48)))
    parent.addView(chrome, FrameLayout.LayoutParams(-1, -1))
    floating.setOnClickListener { setMenu(menu.visibility != View.VISIBLE) }
    var downX = 0f; var downY = 0f; var initialX = 0f; var initialY = 0f; var dragged = false
    floating.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          cancelTouch(); downX = event.rawX; downY = event.rawY; initialX = floating.x; initialY = floating.y; dragged = false
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX; val dy = event.rawY - downY
          if (kotlin.math.abs(dx) + kotlin.math.abs(dy) > dp(8)) dragged = true
          if (dragged) { setMenu(false); floating.x = clampX(initialX + dx); floating.y = clampY(initialY + dy) }
        }
        MotionEvent.ACTION_UP -> if (!dragged) floating.performClick()
        MotionEvent.ACTION_CANCEL -> Unit
      }
      true
    }
    parent.addOnLayoutChangeListener(layoutListener)
    applyTheme(palette)
    parent.post { layout() }
    } catch (error: Throwable) {
      // Construction can fail before NativeGamePreview receives this instance.
      // Do not leave an opaque native backdrop above the restored WebView.
      destroyed = true
      parent.removeOnLayoutChangeListener(layoutListener)
      parent.removeView(chrome)
      parent.removeView(backdrop)
      throw error
    }
  }

  private fun clampX(value: Float) = value.coerceIn(safe.left.toFloat(), (safe.left + safe.width - dp(48)).coerceAtLeast(safe.left).toFloat())
  private fun clampY(value: Float) = value.coerceIn(safe.top.toFloat(), (safe.top + safe.height - dp(48)).coerceAtLeast(safe.top).toFloat())

  fun layout() {
    if (destroyed) return
    val root = ViewCompat.getRootWindowInsets(activity.window.decorView)
    val insets = root?.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val left = insets?.left ?: 0; val top = insets?.top ?: 0
    safe = FullscreenFrame(left, top, (parent.width - left - (insets?.right ?: 0)).coerceAtLeast(1),
      (parent.height - top - (insets?.bottom ?: 0)).coerceAtLeast(1))
    onFrame(FullscreenGeometry.fit(safe.left, safe.top, safe.width, safe.height, gameWidth, gameHeight))
    if (!positioned && parent.width > 0 && parent.height > 0) {
      floating.x = clampX((safe.left + safe.width - dp(60)).toFloat()); floating.y = clampY((safe.top + dp(12)).toFloat())
      positioned = true
    } else { floating.x = clampX(floating.x); floating.y = clampY(floating.y) }
    positionMenu()
  }

  private fun positionMenu() {
    val width = dp(220).coerceAtMost(safe.width)
    if (menu.layoutParams.width != width) menu.layoutParams = (menu.layoutParams as FrameLayout.LayoutParams).apply { this.width = width }
    menu.x = floating.x.coerceIn(safe.left.toFloat(), (safe.left + safe.width - width).coerceAtLeast(safe.left).toFloat())
    val below = floating.y + dp(56)
    val height = dp(172)
    menu.y = (if (below + height <= safe.top + safe.height) below else floating.y - height - dp(8))
      .coerceIn(safe.top.toFloat(), (safe.top + safe.height - height).coerceAtLeast(safe.top).toFloat())
  }

  private fun setMenu(shown: Boolean) {
    if (shown) cancelTouch()
    dismissMenu.visibility = if (shown) View.VISIBLE else View.GONE
    menu.visibility = dismissMenu.visibility
    if (shown) positionMenu()
  }

  fun applyTheme(theme: NativePreviewPalette) {
    palette = theme
    fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
      setColor(color); cornerRadius = dp(radius).toFloat(); setStroke(dp(1), theme.border)
    }
    backdrop.setBackgroundColor(theme.background)
    dismissMenu.setBackgroundColor(theme.alpha(theme.background, 96))
    menu.background = rounded(theme.background, 20)
    coexistenceHint.setTextColor(theme.alpha(theme.foreground, 180))
    entries.forEach { entry ->
      entry.setTextColor(theme.foreground)
      entry.background = RippleDrawable(ColorStateList.valueOf(theme.alpha(theme.foreground, 32)),
        rounded(theme.background, 16), rounded(theme.foreground, 16))
    }
    floating.setTextColor(theme.primaryForeground)
    floating.background = RippleDrawable(ColorStateList.valueOf(theme.alpha(theme.primaryForeground, 48)),
      rounded(theme.primary, 24), rounded(theme.primaryForeground, 24))
  }

  fun closeMenu() = setMenu(false)
  fun destroy() {
    if (destroyed) return
    destroyed = true
    cancelTouch(); parent.removeOnLayoutChangeListener(layoutListener)
    parent.removeView(chrome); parent.removeView(backdrop)
  }
}
