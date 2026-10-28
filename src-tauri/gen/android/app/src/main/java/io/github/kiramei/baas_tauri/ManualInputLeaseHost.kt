package io.github.kiramei.baas_tauri

import android.os.IBinder

/** The client Binder's death cannot leave a daemon permanently in manual mode. */
internal class ManualInputLeaseHost(private val gate: ManualInputGate, private val cancel: () -> Unit) {
  private data class Registration(val displayId: Int, val token: Long, val owner: IBinder, val death: IBinder.DeathRecipient)
  private var registration: Registration? = null

  fun acquire(displayId: Int, owner: IBinder): Long {
    val token = gate.acquire(displayId)
    val death = IBinder.DeathRecipient { release(displayId, token) }
    try {
      synchronized(this) {
        check(gate.isManual(displayId, token)) { "The manual input request was superseded" }
        registration?.let { runCatching { it.owner.unlinkToDeath(it.death, 0) } }
        registration = Registration(displayId, token, owner, death)
        owner.linkToDeath(death, 0)
        check(owner.isBinderAlive && gate.isManual(displayId, token)) { "The manual input client disconnected" }
      }
      return token
    } catch (error: Throwable) {
      release(displayId, token)
      throw error
    }
  }

  fun release(displayId: Int, token: Long): Boolean {
    synchronized(this) {
      registration?.takeIf { it.displayId == displayId && it.token == token }?.let {
        registration = null
        runCatching { it.owner.unlinkToDeath(it.death, 0) }
      }
    }
    return gate.release(displayId, token, cancel)
  }
}
