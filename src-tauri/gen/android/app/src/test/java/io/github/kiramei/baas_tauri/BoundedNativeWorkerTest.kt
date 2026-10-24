package io.github.kiramei.baas_tauri

import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class BoundedNativeWorkerTest {
  private fun CountDownLatch.awaitTest() = assertTrue("worker callback did not arrive", await(3, TimeUnit.SECONDS))

  @Test fun workRunsOffTheCallerThread() {
    val caller = Thread.currentThread()
    val done = CountDownLatch(1)
    BoundedNativeWorker("test-native", 1).use { worker ->
      assertTrue(worker.submit(2_000, { Thread.currentThread() }, { result ->
        assertNotSame(caller, result.getOrThrow()); done.countDown()
      }))
      done.awaitTest()
    }
  }

  @Test fun aTimedOutBinderDoesNotGrowThreadsOrDeliverALateSuccess() {
    val started = CountDownLatch(1); val release = CountDownLatch(1); val timedOut = CountDownLatch(1)
    val finished = CountDownLatch(1); val calls = AtomicInteger(); val completions = AtomicInteger()
    BoundedNativeWorker("test-stuck-binder", 0).use { worker ->
      try {
        assertTrue(worker.submit(100, { calls.incrementAndGet(); started.countDown(); release.await(); 42 }, {
          assertTrue(it.exceptionOrNull() is TimeoutException); completions.incrementAndGet(); timedOut.countDown()
        }, { finished.countDown() }))
        started.awaitTest(); timedOut.awaitTest()
        repeat(20) {
          assertFalse(worker.submit(100, { calls.incrementAndGet() }, { result ->
            assertTrue(result.exceptionOrNull() is RejectedExecutionException)
          }))
        }
        assertEquals(1, calls.get())
      } finally { release.countDown() }
      finished.awaitTest()
      assertEquals(1, completions.get())
    }
  }

  @Test fun expiredQueuedMutationsAreRemovedAndNeverExecute() {
    val started = CountDownLatch(1); val release = CountDownLatch(1); val firstDone = CountDownLatch(1)
    val expired = CountDownLatch(1); val removed = CountDownLatch(1); val mutationCalls = AtomicInteger()
    BoundedNativeWorker("test-queued", 1).use { worker ->
      try {
        worker.submit(2_000, { started.countDown(); release.await() }, {}, { firstDone.countDown() })
        started.awaitTest()
        assertTrue(worker.submit(100, { mutationCalls.incrementAndGet() }, {
          assertTrue(it.exceptionOrNull() is TimeoutException); expired.countDown()
        }, { removed.countDown() }))
        assertFalse(worker.submit(2_000, { mutationCalls.incrementAndGet() }, {
          assertTrue(it.exceptionOrNull() is RejectedExecutionException)
        }))
        expired.awaitTest(); removed.awaitTest()
      } finally { release.countDown() }
      firstDone.awaitTest()
      assertEquals(0, mutationCalls.get())
    }
  }

  @Test fun closingRejectsNewWorkWithoutRunningIt() {
    val worker = BoundedNativeWorker("test-closed", 1)
    worker.close()
    var rejected = false
    assertFalse(worker.submit(100, { fail("closed worker ran a mutation") }, {
      rejected = it.exceptionOrNull() is RejectedExecutionException
    }))
    assertTrue(rejected)
  }

  @Test fun activityDestructionDoesNotRunAlreadyQueuedMutations() {
    val worker = BoundedNativeWorker("test-destroyed", 1)
    val started = CountDownLatch(1); val release = CountDownLatch(1); val skipped = CountDownLatch(1)
    val mutations = AtomicInteger()
    try {
      worker.submit(2_000, { started.countDown(); release.await() }, {})
      started.awaitTest()
      worker.submit(2_000, { mutations.incrementAndGet() }, { result ->
        assertTrue(result.exceptionOrNull() is RejectedExecutionException); skipped.countDown()
      })
      worker.close()
    } finally { release.countDown() }
    skipped.awaitTest()
    assertEquals(0, mutations.get())
  }

  @Test fun identicalPollsKeepTheirOwnerButHideAndShowNeverReuseIt() {
    val owner = LatestNativeRequest<String>()
    val shown = owner.update("shown")
    assertEquals(shown, owner.update("shown"))
    owner.update("hidden")
    assertFalse(owner.isCurrent(shown))
    val reshown = owner.update("shown")
    assertNotEquals(shown, reshown)
    assertFalse(owner.isCurrent(shown))
    assertTrue(owner.isCurrent(reshown))
  }

  @Test fun sessionAndActivityInvalidationRejectsResultsWithIdenticalGeometry() {
    val owner = LatestNativeRequest<String>()
    val before = owner.update("same-layout")
    owner.invalidate()
    assertFalse(owner.isCurrent(before))
    val after = owner.update("same-layout")
    assertTrue(owner.isCurrent(after))
    assertNotEquals(before, after)
  }
}
