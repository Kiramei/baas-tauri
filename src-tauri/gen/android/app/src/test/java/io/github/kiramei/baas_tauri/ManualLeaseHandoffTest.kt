package io.github.kiramei.baas_tauri

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

class ManualLeaseHandoffTest {
  @Test fun backPauseTimeoutAndDestroyedCommandsReleaseALateAcquire() {
    for (reason in listOf("back", "pause", "timeout", "destroy")) {
      var releases = 0
      val handoff = ManualLeaseHandoff<NativeManualInputLease>()
      handoff.cancel()
      val lease = NativeManualInputLease(7, 42) { releases++ }
      assertFalse(reason, handoff.offer(lease))
      handoff.cancel(); lease.close()
      assertEquals(1, releases)
      assertNull(handoff.take())
    }
  }
  @Test fun rejectedStaleCommitReleasesButSuccessfulHandoffDoesNot() {
    var releases = 0
    val stale = ManualLeaseHandoff<NativeManualInputLease>()
    assertTrue(stale.offer(NativeManualInputLease(7, 1) { releases++ }))
    stale.cancel(); stale.cancel()
    assertEquals(1, releases)
    val valid = ManualLeaseHandoff<NativeManualInputLease>()
    assertTrue(valid.offer(NativeManualInputLease(7, 2) { releases++ }))
    val transferred = valid.take()
    valid.cancel()
    assertEquals(1, releases)
    transferred!!.close(); transferred.close()
    assertEquals(2, releases)
  }
  @Test fun realNativeWorkerDeadlineReleasesAcquireEvenWhenItDropsTheLateSuccess() {
    val worker = BoundedNativeWorker("manual-lease-handoff-test", 0)
    val started = CountDownLatch(1); val finishAcquire = CountDownLatch(1)
    val settled = CountDownLatch(1); val finished = CountDownLatch(1)
    val releases = AtomicInteger(0)
    val failed = AtomicBoolean(false)
    val handoff = ManualLeaseHandoff<NativeManualInputLease>()
    try {
      assertTrue(worker.submit(100L, {
        started.countDown()
        check(finishAcquire.await(2, TimeUnit.SECONDS))
        val lease = NativeManualInputLease(7, 55) { releases.incrementAndGet() }
        handoff.offer(lease) // late offer closes it even though worker drops the value
        lease
      }, { result ->
        failed.set(result.isFailure)
        handoff.cancel(); settled.countDown()
      }, { finished.countDown() }))
      assertTrue(started.await(1, TimeUnit.SECONDS))
      assertTrue(settled.await(1, TimeUnit.SECONDS))
      assertTrue(failed.get())
      finishAcquire.countDown()
      assertTrue(finished.await(1, TimeUnit.SECONDS))
      assertEquals(1, releases.get())
      assertNull(handoff.take())
    } finally { finishAcquire.countDown(); worker.close() }
  }
  @Test fun commitFailureAfterTakingOwnershipClosesExactlyOnce() {
    var releases = 0
    val handoff = ManualLeaseHandoff<NativeManualInputLease>()
    handoff.offer(NativeManualInputLease(7, 90) { releases++ })
    try {
      val lease = handoff.take()!!
      try { throw IllegalStateException("Native fullscreen construction failed") }
      catch (error: Throwable) { lease.close(); throw error }
    } catch (_: IllegalStateException) {
    } finally { handoff.cancel() }
    assertEquals(1, releases)
  }
}
