package io.github.kiramei.baas_tauri

import android.content.Context
import android.view.MotionEvent
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** One physical worker, bounded packets, adjacent MOVE coalescing; never Binder on the UI thread. */
internal class NativeTouchDispatcher(private val context: Context, private val onError: (Long, String) -> Unit) {
  private data class Packet(val epoch: Long, val displayId: Int, val leaseId: Long, val event: MotionEvent, val cancellation: Boolean = false)
  private val lock = Any()
  private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "baas-game-touch").apply { isDaemon = true } }
  private val deadlines = ScheduledThreadPoolExecutor(1) { task -> Thread(task, "baas-touch-deadline").apply { isDaemon = true } }
    .apply { removeOnCancelPolicy = true }
  private val pending = CoalescingTouchQueue<Packet>(64, { packet ->
    if (packet.event.actionMasked != MotionEvent.ACTION_MOVE) null
    else Triple(packet.epoch, packet.leaseId, (0 until packet.event.pointerCount).map { packet.event.getPointerId(it) })
  }, { it.event.recycle() })
  private val deadlineState = TouchDeadlineState()
  private val epoch: Long get() = deadlineState.epoch
  private var displayId = -1
  private var leaseId = 0L
  private var running = false
  private var closed = false
  private val stalled: Boolean get() = deadlineState.stalled
  private var acceptingGesture: Boolean
    get() = deadlineState.acceptingGesture
    set(value) { deadlineState.acceptingGesture = value }
  private var lastSent: Packet? = null

  fun beginSession(expectedDisplayId: Int, token: Long) = synchronized(lock) {
    require(expectedDisplayId > 0 && token > 0)
    cancelLocked()
    displayId = expectedDisplayId
    leaseId = token
  }

  /** Takes ownership of the copied/mapped event, including rejection paths. */
  fun submit(event: MotionEvent): Boolean = synchronized(lock) {
    if (closed || stalled || displayId <= 0 || leaseId <= 0) { event.recycle(); return@synchronized false }
    if (event.actionMasked == MotionEvent.ACTION_DOWN) acceptingGesture = true
    if (!acceptingGesture) { event.recycle(); return@synchronized false }
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) acceptingGesture = false
    if (!pending.offer(Packet(epoch, displayId, leaseId, event))) {
      event.recycle()
      // A bounded queue cannot retain unlimited taps behind a stuck Binder.
      // Fail the entire stream closed, rather than lose a lone UP or inject a stale DOWN later.
      cancelLocked(force = true)
      onError(epoch, "Game input queue is full; cancellation was requested")
      return@synchronized false
    }
    scheduleLocked()
    true
  }

  fun hasGesture(): Boolean = synchronized(lock) { acceptingGesture || running }
  fun isCurrent(ticket: Long): Boolean = synchronized(lock) { !closed && epoch == ticket }
  fun cancel() = synchronized(lock) { cancelLocked() }

  private fun cancelLocked(force: Boolean = false) {
    deadlineState.invalidate { pending.clear() }
    queueCancellationLocked(force)
    scheduleLocked()
  }

  private fun queueCancellationLocked(force: Boolean) {
    lastSent?.let { previous ->
      if (force || previous.event.actionMasked !in listOf(MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL)) {
        val event = MotionEvent.obtainNoHistory(previous.event).apply { action = MotionEvent.ACTION_CANCEL }
        pending.offer(Packet(epoch, previous.displayId, previous.leaseId, event, cancellation = true))
      }
    }
  }

  private fun scheduleLocked() {
    if (!running && !worker.isShutdown) {
      running = true
      worker.execute { drain() }
    }
  }

  private fun drain() {
    while (true) {
      val packet = synchronized(lock) {
        var next = pending.poll()
        while (next != null && !next.cancellation && next.epoch != epoch) { next.event.recycle(); next = pending.poll() }
        if (next == null) {
          running = false
          if (closed) { lastSent?.event?.recycle(); lastSent = null; deadlines.shutdown() }
          return
        }
        lastSent?.event?.recycle()
        lastSent = next.copy(event = MotionEvent.obtainNoHistory(next.event))
        next
      }
      val completed = AtomicBoolean(false)
      val deadline = deadlines.schedule({
        if (completed.compareAndSet(false, true)) synchronized(lock) {
          deadlineState.timedOut(packet.cancellation, { pending.clear() }, { queueCancellationLocked(force = true) })
          onError(epoch, "Game input timed out; cancellation is pending")
        }
      }, 1500, TimeUnit.MILLISECONDS)
      try {
        val success = ShizukuController.touch(context, packet.displayId, packet.leaseId, packet.event)
        if (completed.compareAndSet(false, true) && !success && !packet.cancellation) synchronized(lock) {
          if (packet.epoch == epoch) {
            cancelLocked(force = true)
            onError(epoch, "The game session no longer accepts input")
          }
        }
      } catch (error: Exception) {
        if (completed.compareAndSet(false, true) && !packet.cancellation) synchronized(lock) {
          if (packet.epoch == epoch) {
            cancelLocked(force = true)
            onError(epoch, error.message ?: "Game input failed")
          }
        }
      } finally {
        deadline.cancel(false)
        packet.event.recycle()
        synchronized(lock) { deadlineState.completed() }
      }
    }
  }

  fun close() = synchronized(lock) {
    if (!closed) {
      cancelLocked()
      closed = true
      worker.shutdown()
      // The final drain sends CANCEL and then closes its deadline scheduler.
    }
  }
}
