package io.github.kiramei.baas_tauri

import org.junit.Assert.*
import org.junit.Test

class FullscreenGeometryTest {
  @Test fun landscapeUsesTheSameAspectRatioWithoutStretching() {
    assertEquals(FullscreenFrame(0, 0, 1280, 720), FullscreenGeometry.fit(0, 0, 1280, 720, 1280, 720))
    assertEquals(FullscreenFrame(320, 0, 1920, 1080), FullscreenGeometry.fit(0, 0, 2560, 1080, 1280, 720))
  }

  @Test fun cutoutAndSystemInsetsAreOutsideTheFittedGame() {
    val frame = FullscreenGeometry.fit(80, 40, 2200, 1000, 1280, 720)
    assertTrue(frame.left >= 80); assertTrue(frame.top >= 40)
    assertTrue(frame.left + frame.width <= 2280); assertTrue(frame.top + frame.height <= 1040)
    assertEquals(1280.0 / 720, frame.width.toDouble() / frame.height, 0.002)
  }

  @Test fun theTransientPortraitLayoutIsStillAspectFit() {
    val frame = FullscreenGeometry.fit(0, 0, 720, 1280, 1280, 720)
    assertEquals(720, frame.width); assertEquals(405, frame.height)
    assertEquals(437, frame.top)
  }

  @Test fun touchCoordinatesUseTheGameSizeAndNeverTheLetterboxOrPrimaryDisplay() {
    assertEquals(640f, FullscreenGeometry.coordinate(960f, 1920, 1280), 0f)
    assertEquals(360f, FullscreenGeometry.coordinate(540f, 1080, 720), 0f)
    assertEquals(0f, FullscreenGeometry.coordinate(-10f, 1920, 1280), 0f)
    assertEquals(1279f, FullscreenGeometry.coordinate(1920f, 1920, 1280), 0f)
    assertEquals(719f, FullscreenGeometry.coordinate(5000f, 1080, 720), 0f)
  }

  private data class Event(val name: String, val moveKey: String? = null)

  @Test fun adjacentMovesCoalesceButNeverCrossPointerTransitions() {
    val discarded = mutableListOf<String>()
    val queue = CoalescingTouchQueue<Event>(8, { it.moveKey }, { discarded.add(it.name) })
    listOf(Event("DOWN"), Event("old move", "one"), Event("latest move", "one"), Event("POINTER_DOWN"),
      Event("two move", "two"), Event("POINTER_UP"), Event("UP")).forEach { assertTrue(queue.offer(it)) }
    val kept = generateSequence { queue.poll() }.map { it.name }.toList()
    assertEquals(listOf("DOWN", "latest move", "POINTER_DOWN", "two move", "POINTER_UP", "UP"), kept)
    assertEquals(listOf("old move"), discarded)
  }

  @Test fun queuePressureDiscardsMovesBeforeAnyDownOrUp() {
    val discarded = mutableListOf<String>()
    val queue = CoalescingTouchQueue<Event>(3, { it.moveKey }, { discarded.add(it.name) })
    listOf(Event("DOWN"), Event("MOVE", "one"), Event("UP"), Event("next DOWN")).forEach { assertTrue(queue.offer(it)) }
    assertEquals(listOf("DOWN", "UP", "next DOWN"), generateSequence { queue.poll() }.map { it.name }.toList())
    assertEquals(listOf("MOVE"), discarded)
  }

  @Test fun transitionOnlyOverflowFailsClosedAndCanBeExplicitlyCancelled() {
    val discarded = mutableListOf<String>()
    val queue = CoalescingTouchQueue<Event>(3, { it.moveKey }, { discarded.add(it.name) })
    listOf(Event("DOWN"), Event("POINTER_DOWN"), Event("POINTER_UP")).forEach { assertTrue(queue.offer(it)) }
    assertFalse(queue.offer(Event("UP")))
    queue.clear()
    assertEquals(listOf("DOWN", "POINTER_DOWN", "POINTER_UP"), discarded)
    assertTrue(queue.offer(Event("CANCEL")))
    assertEquals("CANCEL", queue.poll()?.name)
    assertNull(queue.poll())
  }
}
