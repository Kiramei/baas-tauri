package io.github.kiramei.baas_tauri

internal data class FullscreenFrame(val left: Int, val top: Int, val width: Int, val height: Int)

internal object FullscreenGeometry {
  fun fit(left: Int, top: Int, width: Int, height: Int, gameWidth: Int, gameHeight: Int): FullscreenFrame {
    if (width <= 0 || height <= 0 || gameWidth <= 0 || gameHeight <= 0) return FullscreenFrame(left, top, 1, 1)
    val scale = minOf(width.toDouble() / gameWidth, height.toDouble() / gameHeight)
    val fittedWidth = (gameWidth * scale).toInt().coerceIn(1, width)
    val fittedHeight = (gameHeight * scale).toInt().coerceIn(1, height)
    return FullscreenFrame(left + (width - fittedWidth) / 2, top + (height - fittedHeight) / 2, fittedWidth, fittedHeight)
  }

  fun coordinate(position: Float, extent: Int, gameExtent: Int): Float =
    (position * gameExtent / extent.coerceAtLeast(1)).coerceIn(0f, (gameExtent - 1).coerceAtLeast(0).toFloat())
}

/** Caller owns synchronization. Only redundant MOVE samples may be discarded under pressure. */
internal class CoalescingTouchQueue<T>(private val capacity: Int, private val moveKey: (T) -> Any?,
  private val dispose: (T) -> Unit) {
  private val items = java.util.ArrayDeque<T>()
  fun offer(value: T): Boolean {
    val key = moveKey(value)
    if (key != null && items.peekLast()?.let(moveKey) == key) dispose(items.removeLast())
    while (items.size >= capacity) {
      val iterator = items.iterator()
      var removed = false
      while (iterator.hasNext()) {
        val item = iterator.next()
        if (moveKey(item) != null) { iterator.remove(); dispose(item); removed = true; break }
      }
      if (!removed) return false
    }
    items.addLast(value)
    return true
  }
  fun poll(): T? = items.pollFirst()
  fun clear() { while (items.isNotEmpty()) dispose(items.removeFirst()) }
}
