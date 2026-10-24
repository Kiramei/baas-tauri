package io.github.kiramei.baas_tauri

import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** A manual lease authenticates a view; it never pauses the script. Automation
 * takes priority at complete-operation boundaries, cancelling the manual stream
 * first. No waits for human fingers or UI threads are made here. */
internal class ManualInputGate(private val cancelManual: () -> Boolean = { true }) {
  private class OperationPermit(val generation: Long, private val release: () -> Unit) : AutoCloseable {
    private val ended = AtomicBoolean(false)
    override fun close() { if (ended.compareAndSet(false, true)) release() }
  }
  private val lock = Object()
  // Spans an entire gesture/pinch/key/opaque shell operation, not one event.
  // Unlike a thread-owned lock, a permit may close on another Binder thread.
  private val operations = Semaphore(1, true)
  private var displayId = -1
  private var active = false
  private var suspended = false
  private var cancellationFailed = false
  private var generation = 0L
  private var serial = 0L
  private var lease = 0L
  private var automatedCalls = 0
  private var manualDownTime: Long? = null
  private var droppedDownTime: Long? = null

  fun own(id: Int) = synchronized(lock) {
    require(id > 0)
    displayId = id; active = false; suspended = false; cancellationFailed = false
    lease = 0; serial++; generation++; manualDownTime = null; droppedDownTime = null
    lock.notifyAll()
  }

  fun activate(id: Int) = synchronized(lock) {
    check(id > 0 && id == displayId)
    active = true
  }

  fun invalidate(cancel: () -> Unit, closed: Boolean = false) = synchronized(lock) {
    active = false; suspended = true; lease = 0; serial++; generation++
    try {
      // Preserve the result before lifecycle cleanup forgets the old snapshot.
      // A failed CANCEL cannot be reopened on the same display by canPrepare.
      try { cancelManualLocked() } finally {
        manualDownTime = null; droppedDownTime = null
        cancel()
      }
    } finally { if (closed) displayId = -1; lock.notifyAll() }
  }

  private fun cancelManualLocked(): Boolean {
    val previous = manualDownTime ?: return !cancellationFailed
    manualDownTime = null; droppedDownTime = previous
    val accepted = try { cancelManual() } catch (error: Throwable) {
      cancellationFailed = true
      throw error
    }
    if (!accepted) cancellationFailed = true
    return accepted
  }

  private fun operation(id: Int?, requireActive: Boolean): OperationPermit? {
    val ticket: Long
    synchronized(lock) {
      if (id != null && (id <= 0 || id != displayId || (requireActive && !active))) return null
      if (displayId > 0 && (suspended || cancellationFailed || !cancelManualLocked())) return null
      ticket = generation
      automatedCalls++
    }
    var acquired = false
    var handedOff = false
    try {
      // Only another automated operation can delay this, never a manual hold.
      acquired = operations.tryAcquire(12, TimeUnit.SECONDS)
      check(acquired) { "Another automated input operation did not finish within 12 seconds" }
      synchronized(lock) {
        if (ticket != generation || (displayId > 0 && cancellationFailed) || (id != null &&
            (id != displayId || (requireActive && !active)))) return null
      }
      return OperationPermit(ticket) {
        synchronized(lock) { automatedCalls--; lock.notifyAll() }
        operations.release()
      }.also { handedOff = true }
    } finally {
      if (!handedOff) {
        if (acquired) operations.release()
        synchronized(lock) { automatedCalls--; lock.notifyAll() }
      }
    }
  }

  fun automation(id: Int, requireActive: Boolean = true, work: () -> Boolean): Boolean {
    val permit = operation(id, requireActive) ?: return false
    return try {
      work().also { accepted ->
        // A real injection error is not a busy/manual collision. Its DOWN may
        // have reached Android despite a failed ACK; do not admit manual input
        // into an uncertain automated stream.
        if (!accepted) synchronized(lock) { if (permit.generation == generation) cancellationFailed = true }
      }
    } catch (error: Throwable) {
      synchronized(lock) { if (permit.generation == generation) cancellationFailed = true }
      throw error
    } finally { permit.close() }
  }

  /** Opaque shell commands use the same whole-operation arbitration. */
  fun shellPermit(): AutoCloseable? = operation(null, false)

  /** Opening a view is immediate, including while a script gesture is running. */
  fun acquire(id: Int, timeoutMs: Long = 3000L): Long = synchronized(lock) {
    require(timeoutMs in 1..3000L) // retained ABI; no automation draining
    check(id > 0 && id == displayId && active && !cancellationFailed) { "The owned game display is no longer active" }
    check(lease == 0L) { "Manual input is already active" }
    lease = ++serial
    lease
  }

  fun isManual(id: Int, token: Long): Boolean = synchronized(lock) {
    id > 0 && id == displayId && active && !cancellationFailed && token > 0 && token == lease
  }

  fun manual(id: Int, token: Long, frame: OwnedDisplayTouch.Frame, work: () -> Boolean): Boolean = synchronized(lock) {
    if (!isManual(id, token)) return false
    val action = frame.maskedAction
    if (frame.downTime == droppedDownTime) {
      if (action == OwnedDisplayTouch.UP || action == OwnedDisplayTouch.CANCEL) droppedDownTime = null
      return true // ignored MANUAL input, never a fake automation ACK
    }
    if (automatedCalls > 0) {
      if (action == OwnedDisplayTouch.DOWN) droppedDownTime = frame.downTime
      return true
    }
    if (action == OwnedDisplayTouch.DOWN) {
      if (manualDownTime != null) return false
      manualDownTime = frame.downTime
      droppedDownTime = null
    } else if (frame.downTime != manualDownTime) {
      // Old cleanup cannot cancel a different stream or automated operation.
      return action == OwnedDisplayTouch.CANCEL && manualDownTime == null
    }
    val accepted = try { work() } catch (error: Throwable) {
      cancelManualLocked()
      throw error
    }
    if (!accepted) cancelManualLocked()
    if (action == OwnedDisplayTouch.UP || action == OwnedDisplayTouch.CANCEL) manualDownTime = null
    accepted
  }

  /** Invalidate before CANCEL. Returning never changes automation admission. */
  fun release(id: Int, token: Long, cancel: () -> Unit): Boolean = synchronized(lock) {
    if (id <= 0 || id != displayId || token <= 0 || token != lease) return false
    lease = 0; serial++
    try {
      if (manualDownTime != null) {
        manualDownTime = null
        try { cancel() } catch (error: Throwable) { cancellationFailed = true; throw error }
      }
    } finally { droppedDownTime = null; lock.notifyAll() }
    true
  }

  /** Compatibility command: a manual view is not an automation pause. */
  fun resumeAutomation(id: Int, requireActive: Boolean = true): Boolean = synchronized(lock) {
    if (id <= 0 || id != displayId || (requireActive && !active) || cancellationFailed) return false
    suspended = false
    true
  }

  /** Destructive preparation still must not replace a live view/input call. */
  fun canPrepare(id: Int): Boolean = synchronized(lock) {
    if (id <= 0 || id != displayId || lease != 0L || automatedCalls != 0 || cancellationFailed) return false
    suspended = false
    true
  }
}
