package io.github.kiramei.baas_tauri

import org.junit.Assert.*
import org.junit.Test

class TouchDeadlineStateTest {
  @Test fun cleanupCancelTimeoutDropsQueuedNewGesturesAndInvalidatesTheirEpoch() {
    val state = TouchDeadlineState()
    val queued = mutableListOf("DOWN", "MOVE", "UP")
    state.acceptingGesture = true
    val previousEpoch = state.epoch
    var cleanup = 0
    state.timedOut(true, { queued.clear() }, { cleanup++ })
    assertTrue(state.stalled)
    assertFalse(state.acceptingGesture)
    assertTrue(queued.isEmpty())
    assertTrue(state.epoch > previousEpoch)
    assertEquals(0, cleanup) // no infinite CANCEL retry chain
    state.completed()
    assertFalse(state.stalled)
    assertFalse(state.acceptingGesture) // MOVE/UP cannot resurrect the lost DOWN
  }
  @Test fun oldEpochTimeoutAlsoInvalidatesANewSessionWaitingBehindIt() {
    val state = TouchDeadlineState()
    val physicalEpoch = state.epoch
    state.invalidate {}
    state.acceptingGesture = true
    val queuedEpoch = state.epoch
    var discarded = false; var cleanup = 0
    state.timedOut(false, { discarded = true }, { cleanup++ })
    assertTrue(discarded)
    assertTrue(state.epoch > queuedEpoch && queuedEpoch > physicalEpoch)
    assertEquals(1, cleanup)
    assertFalse(state.acceptingGesture)
  }
}
