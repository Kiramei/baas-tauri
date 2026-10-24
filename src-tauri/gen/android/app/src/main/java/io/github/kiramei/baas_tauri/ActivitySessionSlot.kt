package io.github.kiramei.baas_tauri

/** Identity, rather than Activity equality or callback order, owns UI resources. */
internal class ActivitySessionSlot<O : Any, S : AutoCloseable>(private val create: (O) -> S) {
  private var owner: O? = null
  private var session: S? = null
  private var epoch = Any()
  class Ticket<O : Any> internal constructor(internal val owner: O, internal val epoch: Any)

  @Synchronized fun capture(): Ticket<O>? = owner?.let { Ticket(it, epoch) }
  @Synchronized fun isCurrent(ticket: Ticket<O>): Boolean = ticket.epoch === epoch && ticket.owner === owner

  @Synchronized fun attach(next: O): S {
    if (owner === next) return checkNotNull(session)
    val previous = session
    owner = null; session = null; epoch = Any()
    previous?.close()
    return create(next).also { owner = next; session = it }
  }

  @Synchronized fun current(expected: O): S? = if (owner === expected) session else null

  @Synchronized fun detach(expected: O): Boolean {
    if (owner !== expected) return false
    val previous = session
    owner = null; session = null; epoch = Any()
    previous?.close()
    return true
  }

  @Synchronized fun clear() {
    val previous = session
    owner = null; session = null; epoch = Any()
    previous?.close()
  }
}

/** UI-owned display mutations outlive an Activity, including their real completion. */
internal class NativeSessionOperations(private val changed: () -> Unit = {}) {
  var count = 0
    private set

  fun begin(): AutoCloseable {
    count++
    changed()
    var finished = false
    return AutoCloseable {
      if (!finished) {
        finished = true
        check(count > 0)
        count--
        changed()
      }
    }
  }
}
