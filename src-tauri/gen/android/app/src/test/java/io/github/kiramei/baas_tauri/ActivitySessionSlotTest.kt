package io.github.kiramei.baas_tauri

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ActivitySessionSlotTest {
  private class Session : AutoCloseable {
    var closes = 0
    override fun close() { closes++ }
  }

  @Test fun relaunchReplacesDestroyedResourcesWithoutRevivingThem() {
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val firstActivity = Any(); val secondActivity = Any()
    val first = slot.attach(firstActivity)
    assertTrue(slot.detach(firstActivity))
    val second = slot.attach(secondActivity)
    assertNotSame(first, second)
    assertEquals(1, first.closes)
    assertEquals(0, second.closes)
    assertNull(slot.current(firstActivity))
    assertSame(second, slot.current(secondActivity))
  }

  @Test fun aLateOldActivityDestroyCannotCloseItsSuccessor() {
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val firstActivity = Any(); val secondActivity = Any()
    val first = slot.attach(firstActivity)
    val second = slot.attach(secondActivity)
    assertEquals(1, first.closes)
    assertFalse(slot.detach(firstActivity))
    assertEquals(0, second.closes)
    assertSame(second, slot.current(secondActivity))
    assertTrue(slot.detach(secondActivity))
    assertEquals(1, second.closes)
  }

  @Test fun repeatedCreateResumeCallbacksReuseOnlyTheLiveOwnersResources() {
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val activity = Any()
    val first = slot.attach(activity)
    repeat(5) { assertSame(first, slot.attach(activity)) }
    assertEquals(0, first.closes)
    assertTrue(slot.detach(activity))
    assertFalse(slot.detach(activity))
    assertEquals(1, first.closes)
    assertNotSame(first, slot.attach(activity))
  }

  @Test fun equalOwnersStillHaveDifferentIdentity() {
    data class Owner(val taskId: Int)
    val slot = ActivitySessionSlot<Owner, Session> { Session() }
    val firstOwner = Owner(288); val replacement = Owner(288)
    val first = slot.attach(firstOwner)
    val second = slot.attach(replacement)
    assertEquals(1, first.closes)
    assertFalse(slot.detach(firstOwner))
    assertSame(second, slot.current(replacement))
  }

  @Test fun replacingThePluginDisposesOnlyItsCurrentSessionOnce() {
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val owner = Any(); val session = slot.attach(owner)
    slot.clear(); slot.clear()
    assertEquals(1, session.closes)
    assertNull(slot.current(owner))
  }

  @Test fun queuedCommandsCannotMigrateToANewActivityOrRecreatedSession() {
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val first = Any(); val next = Any()
    slot.attach(first)
    val oldRequest = checkNotNull(slot.capture())
    assertTrue(slot.isCurrent(oldRequest))
    slot.attach(next)
    assertFalse(slot.isCurrent(oldRequest))
    val currentRequest = checkNotNull(slot.capture())
    assertTrue(slot.isCurrent(currentRequest))
    slot.detach(next); slot.attach(next)
    assertFalse(slot.isCurrent(currentRequest))
    assertNull(slot.current(first))
  }

  @Test fun displayMutationStaysBusyAcrossRecreationAndNotifiesTheNewOwnerOnCompletion() {
    var active: Any = Any()
    val invalidated = mutableListOf<Any>()
    val operations = NativeSessionOperations { invalidated.add(active) }
    val oldActivity = active
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    slot.attach(oldActivity)
    val mutation = operations.begin()
    assertEquals(1, operations.count)
    active = Any()
    slot.attach(active)
    assertEquals("A new preview must wait for the actual old mutation", 1, operations.count)
    mutation.close()
    assertEquals(0, operations.count)
    assertEquals(listOf(oldActivity, active), invalidated)
    mutation.close()
    assertEquals(2, invalidated.size)
  }

  @Test fun overlappingDisplayMutationsStayBusyUntilBothActuallyFinish() {
    val operations = NativeSessionOperations()
    val first = operations.begin(); val second = operations.begin()
    assertEquals(2, operations.count)
    first.close(); first.close()
    assertEquals(1, operations.count)
    second.close()
    assertEquals(0, operations.count)
  }

  @Test fun aRecreatedActivityDoesNotCreateAnotherLaneAroundARunningBinder() {
    val started = CountDownLatch(1); val release = CountDownLatch(1)
    val completed = CountDownLatch(1); val successor = CountDownLatch(1)
    val slot = ActivitySessionSlot<Any, Session> { Session() }
    val oldActivity = Any(); val newActivity = Any()
    val oldSession = slot.attach(oldActivity)
    BoundedNativeWorker("test-relaunch-native-lane", 1).use { lane ->
      try {
        lane.submit(2000, { started.countDown(); release.await() }, {}, { completed.countDown() })
        assertTrue(started.await(1, TimeUnit.SECONDS))
        val replacement = slot.attach(newActivity)
        assertEquals(1, oldSession.closes)
        assertTrue(lane.submit(2000, { assertEquals(0, replacement.closes); successor.countDown() }, {}))
        assertFalse("A replacement bypassed the existing native lane", successor.await(100, TimeUnit.MILLISECONDS))
      } finally { release.countDown() }
      assertTrue(completed.await(1, TimeUnit.SECONDS))
      assertTrue(successor.await(1, TimeUnit.SECONDS))
    }
  }
}
