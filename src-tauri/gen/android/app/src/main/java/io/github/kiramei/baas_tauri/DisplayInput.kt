package io.github.kiramei.baas_tauri

import android.os.SystemClock
import android.view.InputDevice
import android.view.InputEvent
import android.view.MotionEvent

/** Cached hidden APIs; no per-gesture process startup. Must run in the privileged process. */
object DisplayInput {
  private val manager by lazy {
    Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null)
  }
  private val inject by lazy {
    manager.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType)
  }
  private val setDisplay by lazy {
    InputEvent::class.java.getDeclaredMethod("setDisplayId", Int::class.javaPrimitiveType).apply { isAccessible = true }
  }

  @Synchronized fun key(displayId: Int, keyCode: Int): Boolean {
    if (displayId < 0) return false
    val now = SystemClock.uptimeMillis()
    for (action in listOf(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.ACTION_UP)) {
      val event = android.view.KeyEvent(now, SystemClock.uptimeMillis(), action, keyCode, 0)
      setDisplay.invoke(event, displayId)
      if (!(inject.invoke(manager, event, if (action == android.view.KeyEvent.ACTION_DOWN) 2 else 0) as Boolean)) return false
    }
    return true
  }

  @Synchronized fun gesture(displayId: Int, x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
    require(displayId >= 0)
    val downAt = SystemClock.uptimeMillis()
    fun send(action: Int, x: Float, y: Float, mode: Int): Boolean {
      val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, x, y, 0)
      try {
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        setDisplay.invoke(event, displayId)
        return inject.invoke(manager, event, mode) as Boolean
      } finally { event.recycle() }
    }
    if (!send(MotionEvent.ACTION_DOWN, x1.toFloat(), y1.toFloat(), 2)) return false
    var released = false
    try {
      val duration = durationMs.coerceIn(1, 10_000)
      if (x1 != x2 || y1 != y2 || duration > 250) {
        val start = SystemClock.uptimeMillis()
        do {
          val elapsed = (SystemClock.uptimeMillis() - start).coerceAtMost(duration.toLong())
          val fraction = elapsed.toFloat() / duration
          if (!send(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * fraction, y1 + (y2 - y1) * fraction, 0)) return false
          if (elapsed >= duration) break
          SystemClock.sleep(8)
        } while (true)
      }
      released = send(MotionEvent.ACTION_UP, x2.toFloat(), y2.toFloat(), 0)
      return released
    } finally {
      if (!released) runCatching { send(MotionEvent.ACTION_CANCEL, x2.toFloat(), y2.toFloat(), 0) }
    }
  }
}
