package io.github.kiramei.baas_tauri

/**
 * A small input-only lock, independent of capture, task-placement and gesture locks.
 * Lifecycle owners invalidate it BEFORE releasing/reparenting a display. The sink
 * submits one event without waiting for the target app, so a validated session
 * cannot disappear between validation and injection.
 *
 * No Android types here: the exact production state machine is JVM-testable.
 */
internal class OwnedDisplayTouch(
  private val now: () -> Long,
  private val inject: (Int, Frame) -> Boolean,
) {
  data class Pointer(val id: Int, val x: Float, val y: Float)
  data class Frame(
    val action: Int,
    val downTime: Long,
    val eventTime: Long,
    val pointers: List<Pointer>,
  ) {
    val maskedAction: Int get() = action and 0xff
    val actionIndex: Int get() = (action shr 8) and 0xff
  }

  private var displayId = -1
  private var width = 0
  private var height = 0
  private var activePackage = ""
  // After POINTER_UP, this snapshot contains only the fingers still down.
  private var last: Frame? = null

  @Synchronized fun own(displayId: Int, width: Int, height: Int) {
    require(displayId > 0 && width > 0 && height > 0)
    clear()
    this.displayId = displayId
    this.width = width
    this.height = height
  }

  @Synchronized fun activate(packageName: String) {
    require(packageName.matches(Regex("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")))
    check(displayId > 0)
    if (activePackage != packageName) cancel()
    activePackage = packageName
  }

  /** Also used when placement fails; a stale UI must not keep touching the game. */
  @Synchronized fun deactivate() {
    cancel()
    activePackage = ""
  }

  @Synchronized fun clear() {
    deactivate()
    // The lifecycle owner is destroying/replacing this display. Never replay a
    // failed old-display CANCEL into a later display owned by this object.
    last = null
    displayId = -1
    width = 0
    height = 0
  }

  @Synchronized fun cancelStream(): Boolean = cancel()

  @Synchronized fun send(expectedDisplayId: Int, frame: Frame): Boolean {
    // In particular, stale CANCELs must not cancel a newer display's stream.
    if (expectedDisplayId <= 0 || expectedDisplayId != displayId || activePackage.isEmpty()) return false
    if (frame.maskedAction == CANCEL && validShape(frame) && frame.actionIndex == 0) {
      val previous = last ?: return true // UI cleanup after UP/failure is idempotent.
      // An old UI cleanup packet cannot cancel a newer gesture on the same VD.
      if (frame.downTime != previous.downTime || frame.eventTime < previous.eventTime) return false
      // A copied POINTER_UP includes the finger that just lifted. Cancel only the
      // backend's remaining fingers, not the UI's possibly transitional snapshot.
      return cancel()
    }
    if (!valid(frame)) {
      cancel()
      return false
    }
    val next = when (frame.maskedAction) {
      UP, CANCEL -> null
      POINTER_UP -> frame.copy(action = MOVE, pointers = frame.pointers.filterIndexed { index, _ -> index != frame.actionIndex })
      else -> frame.copy(action = MOVE)
    }
    // Keep a cancellation snapshot even if Android rejects/throws after DOWN.
    last = frame
    try {
      if (!inject(displayId, frame)) {
        cancel()
        return false
      }
      last = next
      return true
    } catch (error: Throwable) {
      cancel()
      throw error
    }
  }

  private fun validShape(frame: Frame): Boolean {
    if (frame.action and 0xffff.inv() != 0 || frame.pointers.size !in 1..10 ||
      frame.downTime < 0 || frame.eventTime < frame.downTime || frame.eventTime > now() + 1000L) return false
    val ids = frame.pointers.map { it.id }.toSet()
    if (ids.size != frame.pointers.size || ids.any { it !in 0..31 }) return false
    if (frame.pointers.any { !it.x.isFinite() || !it.y.isFinite() || it.x < 0f || it.x >= width || it.y < 0f || it.y >= height }) return false
    return true
  }

  private fun valid(frame: Frame): Boolean {
    if (!validShape(frame)) return false
    val ids = frame.pointers.map { it.id }.toSet()
    val previous = last
    val previousIds = previous?.pointers?.map { it.id }?.toSet().orEmpty()
    if (frame.maskedAction != DOWN && (previous == null || frame.downTime != previous.downTime || frame.eventTime < previous.eventTime)) return false
    return when (frame.maskedAction) {
      DOWN -> previous == null && frame.pointers.size == 1 && frame.actionIndex == 0
      MOVE, CANCEL -> frame.actionIndex == 0 && ids == previousIds
      UP -> frame.actionIndex == 0 && frame.pointers.size == 1 && ids == previousIds
      POINTER_DOWN -> frame.actionIndex in frame.pointers.indices && frame.pointers.size == previousIds.size + 1 &&
        ids.containsAll(previousIds) && frame.pointers[frame.actionIndex].id !in previousIds
      POINTER_UP -> frame.actionIndex in frame.pointers.indices && frame.pointers.size >= 2 && ids == previousIds
      else -> false
    }
  }

  private fun cancel(): Boolean {
    val frame = last ?: return true
    // Only internally remembered, validated coordinates can be used for cleanup.
    // Keep the snapshot until cancellation is accepted. A failed CANCEL must not
    // be mistaken for an empty stream by the automation handoff.
    val accepted = runCatching { inject(displayId, frame.copy(action = CANCEL, eventTime = maxOf(frame.eventTime, now()))) }.getOrDefault(false)
    if (accepted) last = null
    return accepted
  }

  companion object {
    // android.view.MotionEvent actions; kept Android-free for host unit tests.
    const val DOWN = 0
    const val UP = 1
    const val MOVE = 2
    const val CANCEL = 3
    const val POINTER_DOWN = 5
    const val POINTER_UP = 6
  }
}
