package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class OwnedDisplayTouchTest {
  private val sent = mutableListOf<Pair<Int, OwnedDisplayTouch.Frame>>()
  private var time = 1000L
  private fun session() = OwnedDisplayTouch({ time }) { id, frame -> sent.add(id to frame); true }.apply {
    own(7, 1280, 720)
    activate("com.example.game")
  }
  private fun frame(action: Int, vararg ids: Int, down: Long = 100L, at: Long = 100L) = OwnedDisplayTouch.Frame(
    action, down, at, ids.map { OwnedDisplayTouch.Pointer(it, 200f + it, 300f + it) },
  )

  @Test fun downAndMovesAreInjectedImmediatelyBeforeUp() {
    val input = session()
    assertTrue(input.send(7, frame(0, 4)))
    assertEquals(listOf(0), sent.map { it.second.action })
    assertTrue(input.send(7, frame(2, 4, at = 125)))
    assertEquals(listOf(0, 2), sent.map { it.second.action })
    assertTrue(input.send(7, frame(1, 4, at = 150)))
    assertEquals(listOf(0, 2, 1), sent.map { it.second.action })
    assertTrue(sent.all { it.first == 7 })
  }

  @Test fun preservesMultiplePointerIdsActionsAndCoordinates() {
    val input = session()
    assertTrue(input.send(7, frame(0, 4)))
    assertTrue(input.send(7, frame(5 or (1 shl 8), 4, 9, at = 110)))
    val move = frame(2, 4, 9, at = 120).copy(pointers = listOf(
      OwnedDisplayTouch.Pointer(4, 2f, 3f), OwnedDisplayTouch.Pointer(9, 1250f, 700f),
    ))
    assertTrue(input.send(7, move))
    assertEquals(move, sent.last().second)
    assertTrue(input.send(7, frame(6, 4, 9, at = 130))) // pointer 4 lifts, pointer 9 remains
    assertTrue(input.send(7, frame(2, 9, at = 140)))
    assertTrue(input.send(7, frame(1, 9, at = 150)))
    assertEquals(listOf(0, 261, 2, 6, 2, 1), sent.map { it.second.action })
  }

  @Test fun acceptsTenPointersButNeverEleven() {
    val input = session()
    assertTrue(input.send(7, frame(0, 0)))
    for (index in 1..9) assertTrue(input.send(7, frame(5 or (index shl 8), *(0..index).toList().toIntArray(), at = 100L + index)))
    assertEquals(10, sent.last().second.pointers.size)
    assertFalse(input.send(7, frame(5 or (10 shl 8), *(0..10).toList().toIntArray(), at = 120)))
    assertEquals(3, sent.last().second.action)
    assertEquals(10, sent.last().second.pointers.size)
  }

  @Test fun rejectsPrimaryMissingStaleAndInactiveDisplaysWithoutInjection() {
    val input = OwnedDisplayTouch({ time }) { id, event -> sent.add(id to event); true }
    for (id in listOf(-1, 0, 7)) assertFalse(input.send(id, frame(0, 0)))
    input.own(7, 1280, 720)
    assertFalse(input.send(7, frame(0, 0)))
    input.activate("com.example.game")
    for (id in listOf(-1, 0, 8)) assertFalse(input.send(id, frame(0, 0)))
    assertTrue(sent.isEmpty())
    assertTrue(input.send(7, frame(0, 0)))
    input.own(8, 1280, 720) // cancellation is still sent only to the old owned display
    assertEquals(7, sent.last().first)
    assertEquals(3, sent.last().second.action)
    input.activate("com.example.game")
    assertTrue(input.send(8, frame(0, 0, down = 200, at = 200)))
    val count = sent.size
    assertFalse(input.send(7, frame(3, 0))) // stale cleanup cannot cancel the new session
    assertEquals(count, sent.size)
    input.clear()
    assertEquals(8, sent.last().first)
    assertEquals(3, sent.last().second.action)
    assertFalse(input.send(8, frame(0, 0)))
  }

  @Test fun malformedCoordinatesCancelUsingOnlyThePreviousValidatedSnapshot() {
    val invalidPoints = listOf(
      Float.NaN to 20f, Float.POSITIVE_INFINITY to 20f, 20f to Float.NEGATIVE_INFINITY,
      -0.1f to 20f, 1280f to 20f, 20f to -1f, 20f to 720f,
    )
    for ((x, y) in invalidPoints) {
      sent.clear()
      val input = session()
      assertTrue(input.send(7, frame(0, 0)))
      assertFalse(input.send(7, frame(2, 0, at = 110).copy(pointers = listOf(OwnedDisplayTouch.Pointer(0, x, y)))))
      assertEquals(listOf(0, 3), sent.map { it.second.action })
      assertEquals(200f, sent.last().second.pointers.single().x)
      assertEquals(300f, sent.last().second.pointers.single().y)
      assertFalse(input.send(7, frame(1, 0, at = 120)))
    }
  }

  @Test fun rejectsInvalidActionsPointerSetsIndicesAndTimeOrder() {
    val invalid = listOf(
      frame(2, 1, at = 120), // no matching finger
      frame(5, 0, 1, at = 120), // index points at the existing finger
      frame(5 or (2 shl 8), 0, 1, at = 120),
      frame(6, 0, at = 120),
      frame(2 or (1 shl 8), 0, at = 120),
      frame(7, 0, at = 120), // hover is not a touchscreen gesture
      frame(2 or (1 shl 16), 0, at = 120),
      frame(2, 0, down = 101, at = 120),
      frame(2, 0, at = 99),
      frame(2, 0, at = 2001),
      frame(2, 0, 0, at = 120),
      frame(5 or (1 shl 8), 0, 32, at = 120),
      frame(2, at = 120),
    )
    for (event in invalid) {
      sent.clear()
      val input = session()
      assertFalse(input.send(7, frame(2, 0))) // no DOWN yet
      assertTrue(input.send(7, frame(0, 0)))
      assertFalse(input.send(7, event))
      assertEquals(listOf(0, 3), sent.map { it.second.action })
    }
  }

  @Test fun cancelAndDeactivateAllowANewGestureWithoutStuckFingers() {
    val input = session()
    assertTrue(input.send(7, frame(0, 2)))
    assertTrue(input.send(7, frame(5 or (1 shl 8), 2, 5, at = 110)))
    assertTrue(input.send(7, frame(3, 2, 5, at = 120)))
    input.deactivate() // already cancelled: never injects twice
    assertEquals(listOf(0, 261, 3), sent.map { it.second.action })
    assertFalse(input.send(7, frame(0, 1, down = 200, at = 200)))
    input.activate("com.example.game")
    assertTrue(input.send(7, frame(0, 1, down = 200, at = 200)))
    input.deactivate()
    assertEquals(3, sent.last().second.action)
    assertEquals(listOf(1), sent.last().second.pointers.map { it.id })
  }

  @Test fun cancellationIsIdempotentAndUsesOnlyTheStillDownPointers() {
    val input = session()
    assertTrue(input.send(7, frame(3, 4))) // cleanup before DOWN
    assertTrue(sent.isEmpty())
    assertTrue(input.send(7, frame(0, 4)))
    assertTrue(input.send(7, frame(5 or (1 shl 8), 4, 9, at = 110)))
    assertTrue(input.send(7, frame(6, 4, 9, at = 120)))
    assertTrue(input.send(7, frame(3, 4, 9, at = 120))) // UI copied the POINTER_UP
    assertEquals(listOf(9), sent.last().second.pointers.map { it.id })
    val count = sent.size
    assertTrue(input.send(7, frame(3, 4, 9, at = 120)))
    assertEquals(count, sent.size)
    assertTrue(input.send(7, frame(0, 1, down = 200, at = 200)))
    assertFalse(input.send(7, frame(3, 4, 9, at = 120))) // stale cancel from the previous gesture
    assertTrue(input.send(7, frame(1, 1, down = 200, at = 210)))
    assertTrue(input.send(7, frame(3, 1, down = 200, at = 210))) // cleanup after UP
    assertEquals(1, sent.last().second.action)
  }

  @Test fun injectionFailureOrExceptionCancelsAndResetsTheStream() {
    for (throws in listOf(false, true)) {
      sent.clear()
      var failure = true
      val input = OwnedDisplayTouch({ time }) { id, event ->
        sent.add(id to event)
        if (event.action == 0 && failure) {
          if (throws) throw IllegalStateException("injection failed")
          false
        } else true
      }.apply { own(7, 1280, 720); activate("com.example.game") }
      val result = runCatching { input.send(7, frame(0, 0)) }
      assertTrue(if (throws) result.exceptionOrNull() is IllegalStateException else result.getOrThrow() == false)
      assertEquals(listOf(0, 3), sent.map { it.second.action })
      failure = false
      assertTrue(input.send(7, frame(0, 0)))
    }
  }

  @Test fun rejectedCancelKeepsItsSnapshotUntilAConfirmedCancellation() {
    var allowCancel = false
    val input = OwnedDisplayTouch({ time }) { id, event ->
      sent.add(id to event)
      event.maskedAction != OwnedDisplayTouch.CANCEL || allowCancel
    }.apply { own(7, 1280, 720); activate("com.example.game") }
    assertTrue(input.send(7, frame(0, 0)))
    assertFalse(input.cancelStream())
    assertFalse(input.cancelStream())
    assertEquals(listOf(0, 3, 3), sent.map { it.second.maskedAction })
    allowCancel = true
    assertTrue(input.cancelStream())
    val count = sent.size
    assertTrue(input.cancelStream())
    assertEquals(count, sent.size)
    assertTrue(input.send(7, frame(0, 0, down = 200, at = 200)))
  }

  @Test fun destroyingDisplayDiscardsAFailedOldCancelWithoutReplayingItIntoTheNextDisplay() {
    val input = OwnedDisplayTouch({ time }) { id, event ->
      sent.add(id to event)
      event.maskedAction != OwnedDisplayTouch.CANCEL
    }.apply { own(7, 1280, 720); activate("com.example.game") }
    assertTrue(input.send(7, frame(0, 0)))
    input.clear() // old VD will be released, even when its target cannot ACK
    val count = sent.size
    input.own(8, 1280, 720); input.activate("com.example.game")
    assertEquals(count, sent.size)
    assertTrue(input.send(8, frame(0, 0, down = 200, at = 200)))
    assertEquals(8, sent.last().first)
    assertEquals(OwnedDisplayTouch.DOWN, sent.last().second.maskedAction)
  }

  @Test fun lifecycleInvalidationCannotReleaseTheDisplayDuringAnInjection() {
    val injecting = CountDownLatch(1)
    val finishInjection = CountDownLatch(1)
    val clearing = CountDownLatch(1)
    val cleared = CountDownLatch(1)
    val input = OwnedDisplayTouch({ time }) { _, event ->
      if (event.action == 0) {
        injecting.countDown()
        check(finishInjection.await(2, TimeUnit.SECONDS))
      }
      true
    }.apply { own(7, 1280, 720); activate("com.example.game") }
    val workers = Executors.newFixedThreadPool(2)
    try {
      val injection = workers.submit<Boolean> { input.send(7, frame(0, 0)) }
      assertTrue(injecting.await(1, TimeUnit.SECONDS))
      val lifecycle = workers.submit {
        clearing.countDown()
        input.clear() // callers may release/reparent only after this returns
        cleared.countDown()
      }
      assertTrue(clearing.await(1, TimeUnit.SECONDS))
      assertFalse(cleared.await(20, TimeUnit.MILLISECONDS))
      finishInjection.countDown()
      assertTrue(injection.get(1, TimeUnit.SECONDS))
      lifecycle.get(1, TimeUnit.SECONDS)
      assertTrue(cleared.await(1, TimeUnit.SECONDS))
      assertFalse(input.send(7, frame(2, 0, at = 110)))
      assertFalse(input.send(7, frame(0, 0, down = 200, at = 200)))
    } finally {
      finishInjection.countDown()
      workers.shutdownNow()
    }
  }
}
