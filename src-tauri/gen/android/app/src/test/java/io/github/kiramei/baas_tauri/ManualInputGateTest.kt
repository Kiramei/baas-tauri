package io.github.kiramei.baas_tauri

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ManualInputGateTest {
  private fun frame(action: Int, down: Long = 100L, at: Long = down, ids: List<Int> = listOf(0)) =
    OwnedDisplayTouch.Frame(action, down, at, ids.map { OwnedDisplayTouch.Pointer(it, 20f + it, 30f + it) })

  private class Harness {
    val events = Collections.synchronizedList(mutableListOf<String>())
    var cancelAccepted = true
    val touch = OwnedDisplayTouch({ 1000L }) { id, event ->
      events.add("$id:${event.maskedAction}:${event.pointers.joinToString { it.id.toString() }}")
      event.maskedAction != OwnedDisplayTouch.CANCEL || cancelAccepted
    }.apply { own(7, 1280, 720); activate("com.example.game") }
    val gate = ManualInputGate(touch::cancelStream).apply { own(7); activate(7) }
    fun send(token: Long, frame: OwnedDisplayTouch.Frame, id: Int = 7) =
      gate.manual(id, token, frame) { touch.send(id, frame) }
    fun release(token: Long) = gate.release(7, token) { check(touch.cancelStream()) }
  }

  @Test fun manualLeaseAndReturnNeverPauseAutomation() {
    val h = Harness(); val token = h.gate.acquire(7)
    for (entry in listOf("gesture", "pinch", "key", "stdin-gesture", "stdin-key")) {
      assertTrue(entry, h.gate.automation(7) { true })
    }
    assertTrue(h.gate.resumeAutomation(7))
    assertTrue(h.send(token, frame(0)))
    assertTrue(h.release(token))
    assertEquals(listOf("7:0:0", "7:3:0"), h.events)
    assertTrue(h.gate.automation(7) { true })
    assertFalse(h.send(token, frame(0, 200)))
  }

  @Test fun automaticGestureCancelsWholeManualMultiTouchBeforeItsFirstDown() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0)))
    assertTrue(h.send(token, frame(5 or (1 shl 8), at = 110, ids = listOf(0, 1))))
    assertTrue(h.gate.automation(7) { h.events.add("auto-down"); h.events.add("auto-up"); true })
    assertEquals(listOf("7:0:0", "7:5:0, 1", "7:3:0, 1", "auto-down", "auto-up"), h.events)
    val count = h.events.size
    assertTrue(h.send(token, frame(2, at = 120, ids = listOf(0, 1))))
    assertTrue(h.send(token, frame(6 or (1 shl 8), at = 130, ids = listOf(0, 1))))
    assertTrue(h.send(token, frame(1, at = 140)))
    assertEquals(count, h.events.size)
    assertTrue(h.send(token, frame(0, 200)))
    assertEquals("7:0:0", h.events.last())
  }

  @Test fun openingViewDuringLongAutomationIsImmediateAndDoesNotInterruptIt() {
    val h = Harness(); val running = CountDownLatch(1); val finish = CountDownLatch(1)
    val workers = Executors.newSingleThreadExecutor()
    try {
      val auto = workers.submit<Boolean> { h.gate.automation(7) { running.countDown(); finish.await(2, TimeUnit.SECONDS) } }
      assertTrue(running.await(1, TimeUnit.SECONDS))
      val token = h.gate.acquire(7, 1) // no waiting for this running operation
      assertTrue(h.gate.isManual(7, token))
      assertTrue(h.gate.resumeAutomation(7))
      assertFalse(h.gate.canPrepare(7))
      assertFalse(auto.isDone)
      finish.countDown(); assertTrue(auto.get(1, TimeUnit.SECONDS))
    } finally { finish.countDown(); workers.shutdownNow() }
  }

  @Test fun newManualDownDuringAutomationDropsTheEntireStreamEvenAfterAutomationEnds() {
    val h = Harness(); val token = h.gate.acquire(7)
    val running = CountDownLatch(1); val finish = CountDownLatch(1)
    val workers = Executors.newSingleThreadExecutor()
    try {
      val auto = workers.submit<Boolean> { h.gate.automation(7) { running.countDown(); finish.await(2, TimeUnit.SECONDS) } }
      assertTrue(running.await(1, TimeUnit.SECONDS))
      assertTrue(h.send(token, frame(0)))
      assertTrue(h.send(token, frame(5 or (1 shl 8), at = 110, ids = listOf(0, 1))))
      finish.countDown(); assertTrue(auto.get(1, TimeUnit.SECONDS))
      assertTrue(h.send(token, frame(2, at = 120, ids = listOf(0, 1))))
      assertTrue(h.send(token, frame(6 or (1 shl 8), at = 130, ids = listOf(0, 1))))
      assertTrue(h.send(token, frame(1, at = 140)))
      assertTrue(h.events.isEmpty())
      assertTrue(h.send(token, frame(0, 200)))
      assertEquals(listOf("7:0:0"), h.events)
    } finally { finish.countDown(); workers.shutdownNow() }
  }

  @Test fun releaseAndLateCancellationCannotCancelAnAutomaticGesture() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0)))
    val running = CountDownLatch(1); val finish = CountDownLatch(1)
    val workers = Executors.newSingleThreadExecutor()
    try {
      val auto = workers.submit<Boolean> { h.gate.automation(7) { h.events.add("auto-down"); running.countDown(); finish.await(2, TimeUnit.SECONDS); h.events.add("auto-up"); true } }
      assertTrue(running.await(1, TimeUnit.SECONDS))
      assertTrue(h.send(token, frame(3, at = 150))) // timeout/Back cleanup
      assertTrue(h.release(token))
      assertFalse(h.send(token, frame(3, at = 160)))
      assertEquals(listOf("7:0:0", "7:3:0", "auto-down"), h.events)
      finish.countDown(); assertTrue(auto.get(1, TimeUnit.SECONDS))
      assertEquals("auto-up", h.events.last())
    } finally { finish.countDown(); workers.shutdownNow() }
  }

  @Test fun cancellationFailureNeverFakesAutomationSuccessOrInjectsItsDown() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0))); h.cancelAccepted = false
    assertFalse(h.gate.automation(7) { fail("CANCEL was not accepted"); true })
    assertFalse(h.gate.automation(7) { fail("Failure must remain closed"); true })
    assertFalse(h.gate.resumeAutomation(7))
    assertNull(h.gate.shellPermit())
    assertFalse(h.send(token, frame(2, at = 110)))
    assertEquals(listOf("7:0:0", "7:3:0"), h.events)
  }

  @Test fun cancellationExceptionRemainsVisibleAndFailsClosed() {
    val gate = ManualInputGate { throw IllegalStateException("cancel failed") }.apply { own(7); activate(7) }
    val token = gate.acquire(7)
    assertTrue(gate.manual(7, token, frame(0)) { true })
    try { gate.automation(7) { fail("Unsafe automatic input"); true }; fail("Keep failure") }
    catch (error: IllegalStateException) { assertEquals("cancel failed", error.message) }
    assertFalse(gate.automation(7) { true })
  }

  @Test fun failedManualInputKeepsItsCauseWhenCancellationAlsoThrows() {
    val injectionFailure = IllegalStateException("manual injection failed")
    val cancellationFailure = IllegalStateException("manual cancellation failed")
    val gate = ManualInputGate { throw cancellationFailure }.apply { own(7); activate(7) }
    val token = gate.acquire(7)
    try {
      gate.manual(7, token, frame(0)) { throw injectionFailure }
      fail("The original injection failure must propagate")
    } catch (error: IllegalStateException) {
      assertSame(injectionFailure, error)
      assertArrayEquals(arrayOf(cancellationFailure), error.suppressed)
    }
    assertFalse(gate.isManual(7, token))
    assertFalse(gate.automation(7) { fail("Unconfirmed manual cancellation"); true })
    assertFalse(gate.canPrepare(7)); assertNull(gate.shellPermit())
  }

  @Test fun manualInputAndCancellationMayThrowTheSameErrorWithoutMaskingIt() {
    val failure = IllegalStateException("disconnected input endpoint")
    val gate = ManualInputGate { throw failure }.apply { own(7); activate(7) }
    val token = gate.acquire(7)
    try {
      gate.manual(7, token, frame(0)) { throw failure }
      fail("The endpoint failure must propagate")
    } catch (error: IllegalStateException) {
      assertSame(failure, error)
      assertTrue(error.suppressed.isEmpty())
    }
    assertFalse(gate.resumeAutomation(7))
  }

  @Test fun lifecycleCancellationFailureCannotBeReopenedOnTheSameDisplay() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0))); h.cancelAccepted = false
    h.gate.invalidate({ h.touch.deactivate() })
    h.gate.activate(7)
    assertFalse(h.gate.canPrepare(7)); assertFalse(h.gate.resumeAutomation(7))
    assertFalse(h.gate.automation(7) { fail("Unconfirmed old manual CANCEL"); true })
  }

  @Test fun closedDisplayStillAllowsExistingOpaqueShellCleanupAfterAnInputFailure() {
    val h = Harness()
    assertFalse(h.gate.automation(7) { false })
    assertNull(h.gate.shellPermit())
    h.gate.invalidate({ h.touch.clear() }, closed = true)
    h.gate.shellPermit()!!.close() // legacy app_stop/cleanup, no owned touch endpoint
    assertFalse(h.gate.automation(7) { fail("Destroyed display"); true })
    assertFalse(h.gate.automation(0) { fail("Primary display"); true })
  }

  @Test fun automaticOperationsRemainSerializedAsWholeGestures() {
    val h = Harness(); val started = CountDownLatch(1); val finish = CountDownLatch(1)
    val secondEntered = CountDownLatch(1); val workers = Executors.newFixedThreadPool(2)
    try {
      val first = workers.submit<Boolean> { h.gate.automation(7) { h.events.add("first-down"); started.countDown(); finish.await(2, TimeUnit.SECONDS); h.events.add("first-up"); true } }
      assertTrue(started.await(1, TimeUnit.SECONDS))
      val second = workers.submit<Boolean> { h.gate.automation(7) { secondEntered.countDown(); h.events.add("second-down"); h.events.add("second-up"); true } }
      assertFalse(secondEntered.await(20, TimeUnit.MILLISECONDS))
      finish.countDown(); assertTrue(first.get(1, TimeUnit.SECONDS)); assertTrue(second.get(1, TimeUnit.SECONDS))
      assertEquals(listOf("first-down", "first-up", "second-down", "second-up"), h.events)
    } finally { finish.countDown(); workers.shutdownNow() }
  }

  @Test fun shellPermitPreemptsManualAndSuppressesInputUntilWholeCommandCompletes() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0)))
    val permit = h.gate.shellPermit()!!
    assertEquals(listOf("7:0:0", "7:3:0"), h.events)
    assertTrue(h.send(token, frame(1, at = 110)))
    assertTrue(h.send(token, frame(0, 200)))
    permit.close(); permit.close()
    assertTrue(h.send(token, frame(2, 200, 210)))
    assertTrue(h.send(token, frame(1, 200, 220)))
    assertEquals(2, h.events.size)
    assertTrue(h.send(token, frame(0, 300)))
    assertEquals(3, h.events.size)
  }

  @Test fun shellPermitCanCloseOnAnotherBinderThreadAndFailedAutomationFailsClosed() {
    val h = Harness(); val permit = h.gate.shellPermit()!!
    val worker = Executors.newSingleThreadExecutor()
    try { worker.submit { permit.close(); permit.close() }.get(1, TimeUnit.SECONDS) }
    finally { worker.shutdownNow() }
    try { h.gate.automation(7) { throw IllegalStateException("real input failure") }; fail("Failure must propagate") }
    catch (error: IllegalStateException) { assertEquals("real input failure", error.message) }
    assertFalse(h.gate.automation(7) { true })
    h.gate.own(7); h.gate.activate(7)
    assertTrue(h.gate.canPrepare(7)) // no leaked operation permit after failure
    assertTrue(h.gate.automation(7) { true })
  }

  @Test fun rejectedAutomaticInjectionCannotBeFollowedByManualInputInAnUncertainStream() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertFalse(h.gate.automation(7) { false })
    assertFalse(h.send(token, frame(0)))
    assertTrue(h.events.isEmpty())
  }

  @Test fun aLateOldAutomaticFailureCannotPoisonTheNewOwnedDisplay() {
    for (throws in listOf(false, true)) {
      val h = Harness(); val started = CountDownLatch(1); val finish = CountDownLatch(1)
      val worker = Executors.newSingleThreadExecutor()
      try {
        val old = worker.submit<Boolean> {
          runCatching { h.gate.automation(7) {
            started.countDown(); check(finish.await(2, TimeUnit.SECONDS))
            if (throws) throw IllegalStateException("old display failed")
            false
          } }.getOrDefault(false)
        }
        assertTrue(started.await(1, TimeUnit.SECONDS))
        h.gate.invalidate({}, closed = true)
        h.gate.own(8); h.gate.activate(8)
        finish.countDown(); assertFalse(old.get(1, TimeUnit.SECONDS))
        assertTrue(h.gate.automation(8) { true })
        assertTrue(h.gate.acquire(8) > 0)
      } finally { finish.countDown(); worker.shutdownNow() }
    }
  }

  @Test fun oldLeaseReleaseAndPacketsNeverAffectNewManualOrAutomaticInput() {
    val h = Harness(); val old = h.gate.acquire(7)
    assertTrue(h.release(old)); val current = h.gate.acquire(7)
    assertNotEquals(old, current)
    assertTrue(h.send(current, frame(0, 200)))
    assertFalse(h.release(old)); assertFalse(h.send(old, frame(3, 200, 210)))
    assertEquals(listOf("7:0:0"), h.events)
    assertTrue(h.gate.automation(7) { true })
    assertEquals(listOf("7:0:0", "7:3:0"), h.events)
  }

  @Test fun primaryForeignInactiveAndInvalidatedDisplaysRemainRejected() {
    val h = Harness(); val token = h.gate.acquire(7)
    for (id in listOf(-1, 0, 8)) {
      assertFalse(h.gate.automation(id) { fail("Foreign display"); true })
      assertFalse(h.send(token, frame(0), id))
      assertFalse(h.gate.resumeAutomation(id))
      try { h.gate.acquire(id); fail("Foreign lease") } catch (_: IllegalStateException) {}
    }
    h.gate.invalidate({ h.touch.deactivate() })
    assertFalse(h.gate.automation(7) { true }); assertFalse(h.send(token, frame(0)))
    assertFalse(h.gate.resumeAutomation(7))
    h.gate.own(8)
    assertFalse(h.gate.automation(8) { true })
    assertTrue(h.gate.automation(8, requireActive = false) { true })
    h.gate.activate(8)
    assertFalse(h.gate.isManual(8, token))
  }

  @Test fun prepareCannotResizeManualViewOrInFlightOperationButResumeIsIdempotent() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertFalse(h.gate.canPrepare(7)); assertTrue(h.gate.resumeAutomation(7))
    assertTrue(h.gate.isManual(7, token)); assertTrue(h.release(token))
    val permit = h.gate.shellPermit()!!
    assertFalse(h.gate.canPrepare(7)); assertTrue(h.gate.resumeAutomation(7))
    permit.close(); assertTrue(h.gate.canPrepare(7))
    h.gate.invalidate({})
    assertNull(h.gate.shellPermit()); assertTrue(h.gate.canPrepare(7))
    h.gate.shellPermit()!!.close()
  }

  @Test fun releaseInvalidatesBeforeCancellationAndCancellationFailureIsNotHidden() {
    val h = Harness(); val token = h.gate.acquire(7)
    assertTrue(h.send(token, frame(0)))
    try {
      h.gate.release(7, token) {
        assertFalse(h.gate.isManual(7, token))
        throw IllegalStateException("cancel failed")
      }
      fail("Cancellation failure")
    } catch (_: IllegalStateException) {}
    assertFalse(h.gate.automation(7) { true })
    assertFalse(h.gate.isManual(7, token))
  }

  @Test fun invalidationRejectsQueuedAutomationAndDoesNotLeakItsPermit() {
    val h = Harness(); val first = h.gate.shellPermit()!!
    val waiting = CountDownLatch(1); val worker = Executors.newSingleThreadExecutor()
    try {
      val late = worker.submit<Boolean> { waiting.countDown(); h.gate.automation(7) { fail("Display was invalidated"); true } }
      assertTrue(waiting.await(1, TimeUnit.SECONDS))
      h.gate.invalidate({}, closed = true)
      first.close()
      assertFalse(late.get(1, TimeUnit.SECONDS))
      h.gate.own(8); h.gate.activate(8)
      assertTrue(h.gate.automation(8) { true })
    } finally { first.close(); worker.shutdownNow() }
  }

  @Test fun interruptedAutomaticWaitDoesNotLeakAdmissionOrExecuteWork() {
    val h = Harness(); val permit = h.gate.shellPermit()!!
    val started = CountDownLatch(1); val stopped = CountDownLatch(1)
    val thread = Thread {
      started.countDown()
      try { h.gate.automation(7) { fail("Interrupted work must not execute"); true } }
      catch (_: InterruptedException) { stopped.countDown() }
    }
    try {
      thread.start(); assertTrue(started.await(1, TimeUnit.SECONDS)); thread.interrupt()
      assertTrue(stopped.await(1, TimeUnit.SECONDS))
      permit.close(); assertTrue(h.gate.canPrepare(7))
      assertTrue(h.gate.automation(7) { true })
    } finally { thread.interrupt(); permit.close(); thread.join(1000) }
  }
}
