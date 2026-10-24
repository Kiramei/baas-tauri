package io.github.kiramei.baas_tauri

/** Caller holds the dispatcher lock. A timed-out physical call invalidates ALL
 * queued input, including a new epoch queued behind an old cleanup CANCEL. */
internal class TouchDeadlineState {
  var epoch = 0L
    private set
  var acceptingGesture = false
  var stalled = false
    private set

  fun invalidate(discardPending: () -> Unit) {
    epoch++
    acceptingGesture = false
    discardPending()
  }

  fun timedOut(cancellation: Boolean, discardPending: () -> Unit, requestCancellation: () -> Unit) {
    stalled = true
    invalidate(discardPending)
    // Do not generate an infinite chain of cleanup CANCELs if CANCEL itself stalls.
    if (!cancellation) requestCancellation()
  }

  fun completed() { stalled = false }
}
