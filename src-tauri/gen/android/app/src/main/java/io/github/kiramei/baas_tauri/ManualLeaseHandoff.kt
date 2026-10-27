package io.github.kiramei.baas_tauri

/** An expired native command must release even an acquire that completes late. */
internal class ManualLeaseHandoff<T : AutoCloseable> {
  private var settled = false
  private var value: T? = null
  fun offer(lease: T): Boolean {
    val accepted = synchronized(this) { if (settled) false else { value = lease; true } }
    if (!accepted) lease.close()
    return accepted
  }
  @Synchronized fun take(): T? {
    if (settled) return null
    settled = true
    return value.also { value = null }
  }
  fun cancel() {
    val old = synchronized(this) { settled = true; value.also { value = null } }
    old?.close()
  }
}

internal class NativeManualInputLease(val displayId: Int, val token: Long, private val release: () -> Unit) : AutoCloseable {
  private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
  override fun close() { if (closed.compareAndSet(false, true)) release() }
}
