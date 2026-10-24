package io.github.kiramei.baas_tauri

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.BlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** Binder calls cannot reliably be interrupted. Never replace a stuck worker with another thread. */
internal class BoundedNativeWorker(name: String, capacity: Int) : AutoCloseable {
  private val closed = AtomicBoolean(false)
  private val queue: BlockingQueue<Runnable> = if (capacity == 0) SynchronousQueue() else ArrayBlockingQueue(capacity)
  private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, queue,
    { task -> Thread(task, name).apply { isDaemon = true } }, ThreadPoolExecutor.AbortPolicy())
  private val deadlines = ScheduledThreadPoolExecutor(1) { task -> Thread(task, "$name-deadline").apply { isDaemon = true } }
    .apply { removeOnCancelPolicy = true }

  fun <T> submit(timeoutMs: Long, work: () -> T, complete: (Result<T>) -> Unit,
    finished: () -> Unit = {}): Boolean {
    val settled = AtomicBoolean(false)
    val finishedOnce = AtomicBoolean(false)
    fun finish() { if (finishedOnce.compareAndSet(false, true)) finished() }
    fun settle(result: Result<T>) { if (settled.compareAndSet(false, true)) complete(result) }
    if (closed.get()) {
      settle(Result.failure(RejectedExecutionException("Android native worker is closed")))
      finish()
      return false
    }
    var deadline: java.util.concurrent.ScheduledFuture<*>? = null
    val task = Runnable {
      try {
        // Expired queued mutations must not run after their caller has given up.
        if (!settled.get()) {
          if (closed.get()) settle(Result.failure(RejectedExecutionException("Android native worker is closed")))
          else settle(runCatching(work))
        }
      } finally {
        deadline?.cancel(false)
        finish()
      }
    }
    return try {
      deadline = deadlines.schedule({
        try { settle(Result.failure(TimeoutException("Android native operation timed out; an already running Binder call may still finish"))) }
        finally { if (executor.remove(task)) finish() }
      }, timeoutMs, TimeUnit.MILLISECONDS)
      executor.execute(task)
      true
    } catch (error: RejectedExecutionException) {
      deadline?.cancel(false)
      settle(Result.failure(RejectedExecutionException("Android native worker is busy", error)))
      finish()
      false
    }
  }

  override fun close() {
    // Do not interrupt a mutation midway through its lifecycle. Existing deadlines
    // still settle queued/running callers; no new work or replacement threads.
    closed.set(true)
    executor.shutdown()
    deadlines.shutdown()
  }
}

/** UI-thread-owned epoch: identical polls share an owner; hide/show and sessions never do. */
internal class LatestNativeRequest<T> {
  private var current: T? = null
  private var epoch = 0L
  fun update(request: T): Long {
    if (current != request) { current = request; epoch++ }
    return epoch
  }
  fun invalidate() { epoch++ }
  fun isCurrent(ticket: Long): Boolean = ticket == epoch
}
