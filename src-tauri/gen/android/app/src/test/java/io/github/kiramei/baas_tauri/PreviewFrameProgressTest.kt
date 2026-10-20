package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewFrameProgressTest {
  @Test fun oldCountersDoNotEstablishLiveness() {
    assertEquals(PreviewFrameState.STILL, PreviewFrameProgress().update(100, 90, true, 1000))
  }

  @Test fun requiresACapturedAndPresentedFrame() {
    val tracker = PreviewFrameProgress()
    assertEquals(PreviewFrameState.WAITING, tracker.update(0, 0, false, 0))
    assertEquals(PreviewFrameState.WAITING, tracker.update(1, 0, true, 100))
    assertEquals(PreviewFrameState.LIVE, tracker.update(2, 1, true, 200))
  }

  @Test fun advancingBlackFramesAreNotLive() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, false, 0)
    assertEquals(PreviewFrameState.BLACK, tracker.update(10, 10, false, 1000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(11, 11, true, 1100))
  }

  @Test fun captureProgressCannotHideAStoppedRenderer() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, true, 0)
    assertEquals(PreviewFrameState.LIVE, tracker.update(2, 2, true, 1000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(20, 2, true, 2999))
    assertEquals(PreviewFrameState.STILL, tracker.update(30, 2, true, 3000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(31, 3, true, 3100))
  }

  @Test fun newCaptureSessionDiscardsPreviousLiveness() {
    val tracker = PreviewFrameProgress()
    tracker.update(9, 8, true, 0)
    tracker.update(10, 9, true, 100)
    assertEquals(PreviewFrameState.STILL, tracker.update(1, 1, true, 200))
  }
}
