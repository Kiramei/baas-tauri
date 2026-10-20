package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GameTaskTransferTest {
  private val game = "example.game"

  @Test fun previewRecoversOnlyAnExistingSelectedGame() {
    val target = GameTaskTransfer.Location(2, 9, game)
    val host = GameTaskTransfer.Location(1, 0, "example.baas")
    assertTrue(GameTaskTransfer.needsPreviewFocus(game, 9, listOf(target, host), host))
    assertTrue(GameTaskTransfer.needsPreviewFocus(game, 9, listOf(target), null))
    assertFalse(GameTaskTransfer.needsPreviewFocus(game, 9, listOf(target), target))
    assertFalse(GameTaskTransfer.needsPreviewFocus(game, 9, listOf(host), host))
    assertFalse(GameTaskTransfer.needsPreviewFocus("", 9, listOf(target), host))
    assertFalse(GameTaskTransfer.needsPreviewFocus(game, 9, listOf(target.copy(displayId = 0)), host))
  }

  @Test fun previewFocusNeverTargetsThePhysicalDisplay() {
    for (display in listOf(0, -1)) {
      try {
        GameTaskTransfer.needsPreviewFocus(game, display, emptyList(), null)
        fail("A physical or missing display must be rejected")
      } catch (_: IllegalStateException) { }
    }
  }

  @Test fun onlyReparentsSelectedGameTasksThatDrifted() {
    var tasks = listOf(
      GameTaskTransfer.Location(1, 0, game),
      GameTaskTransfer.Location(2, 9, game),
      GameTaskTransfer.Location(3, 0, "example.other"),
    )
    val moved = mutableListOf<Int>()
    GameTaskTransfer.reconcile(game, 9, { tasks }) { id, target ->
      moved.add(id)
      tasks = tasks.map { if (it.taskId == id) it.copy(displayId = target) else it }
    }
    assertEquals(listOf(1), moved)
    assertEquals(0, tasks.last().displayId)
  }

  @Test fun missingTaskDoesNotLaunchOrRestartGame() {
    GameTaskTransfer.reconcile(game, 9, { emptyList() }) { _, _ -> fail("Must not move missing task") }
  }

  @Test fun rejectedMoveIsNotReportedAsSuccessful() {
    val tasks = listOf(GameTaskTransfer.Location(1, 0, game))
    try {
      GameTaskTransfer.reconcile(game, 9, { tasks }) { _, _ -> Unit }
      fail("Ignored move must fail verification")
    } catch (_: IllegalStateException) { }
  }

  @Test fun placementNeverFallsBackToMainScreen() {
    for (display in listOf(0, -1)) {
      try {
        GameTaskTransfer.reconcile(game, display, { fail("Must validate before reading"); emptyList() }) { _, _ -> fail("Must not move") }
        fail("Invalid target must fail")
      } catch (_: IllegalStateException) { }
    }
  }
}
