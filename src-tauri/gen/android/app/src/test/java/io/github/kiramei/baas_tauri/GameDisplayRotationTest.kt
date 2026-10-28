package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GameDisplayRotationTest {
  class ModernManager(private val readyAfter: Int = 1) {
    val calls = mutableListOf<String>()
    private var attempts = 0
    fun freezeDisplayRotation(display: Int, rotation: Int, caller: String) {
      calls.add("freeze:$display:$rotation:$caller")
      attempts++
    }
    fun isDisplayRotationFrozen(display: Int): Boolean {
      calls.add("check:$display")
      return attempts >= readyAfter
    }
    fun setIgnoreOrientationRequest(display: Int, ignore: Boolean) { calls.add("ignore:$display:$ignore") }
  }

  class LegacyManager {
    val calls = mutableListOf<String>()
    fun freezeDisplayRotation(display: Int, rotation: Int) { calls.add("freeze:$display:$rotation") }
    fun isDisplayRotationFrozen(display: Int): Boolean { calls.add("check:$display"); return true }
    fun freezeRotation(rotation: Int) { fail("Must never change physical-display rotation: $rotation") }
  }

  @Test fun waitsForWindowManagerBeforeApplyingOrientationPolicy() {
    val manager = ModernManager(3)
    var pauses = 0
    GameDisplayRotation.configure(manager, 21) { pauses++ }
    assertEquals(2, pauses)
    assertEquals(listOf("freeze:21:0:BAAS Game", "check:21", "freeze:21:0:BAAS Game", "check:21",
      "freeze:21:0:BAAS Game", "check:21", "ignore:21:true"), manager.calls)
  }

  @Test fun supportsOlderDisplayScopedSignatureWithoutGlobalFallback() {
    val manager = LegacyManager()
    GameDisplayRotation.configure(manager, 9) { fail("Display is ready") }
    assertEquals(listOf("freeze:9:0", "check:9"), manager.calls)
  }

  @Test fun rejectsPhysicalOrMissingDisplayWithoutCallingManager() {
    for (display in listOf(0, -1)) {
      val manager = ModernManager()
      try {
        GameDisplayRotation.configure(manager, display) { fail("Must not wait") }
        fail("Invalid display accepted")
      } catch (_: IllegalStateException) { }
      assertTrue(manager.calls.isEmpty())
    }
  }

  @Test fun missingDisplayHasBoundedWaitAndDoesNotApplyOrientationPolicy() {
    val manager = ModernManager(41)
    var pauses = 0
    try {
      GameDisplayRotation.configure(manager, 8) { pauses++ }
      fail("Unregistered display accepted")
    } catch (_: IllegalStateException) { }
    assertEquals(39, pauses)
    assertEquals(40, manager.calls.count { it.startsWith("freeze:") })
    assertTrue(manager.calls.none { it.startsWith("ignore:") })
  }
}
