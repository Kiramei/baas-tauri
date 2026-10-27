package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewFrameProgressTest {
  @Test fun textureRedrawsWithoutANewBufferDoNotCountAsDisplayedFrames() {
    val frames = PreviewDisplayedFrames()
    frames.record(1000)
    repeat(20) { frames.record(1000) }
    assertEquals(1L, frames.count)
    frames.record(2000)
    assertEquals(2L, frames.count)
  }

  @Test fun anUninitializedTextureDoesNotCountAsAFrame() {
    val frames = PreviewDisplayedFrames()
    frames.record(0)
    frames.record(-1)
    assertEquals(0L, frames.count)
  }

  @Test fun aNewTextureResetsTheObservedBufferSequence() {
    val frames = PreviewDisplayedFrames()
    frames.record(1000)
    frames.reset()
    assertEquals(0L, frames.count)
    frames.record(1000)
    assertEquals(1L, frames.count)
  }

  @Test fun oldCountersDoNotEstablishLiveness() {
    assertEquals(PreviewFrameState.STILL, PreviewFrameProgress().update(100, 90, 80, true, 1000))
  }

  @Test fun requiresACapturedSubmittedAndDisplayedFrame() {
    val tracker = PreviewFrameProgress()
    assertEquals(PreviewFrameState.WAITING, tracker.update(0, 0, 0, false, 0))
    assertEquals(PreviewFrameState.WAITING, tracker.update(1, 0, 0, true, 100))
    assertEquals(PreviewFrameState.WAITING, tracker.update(2, 1, 0, true, 200))
    assertEquals(PreviewFrameState.LIVE, tracker.update(3, 2, 1, true, 300))
  }

  @Test fun advancingBlackFramesAreNotLive() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, 1, false, 0)
    assertEquals(PreviewFrameState.BLACK, tracker.update(10, 10, 10, false, 1000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(11, 11, 11, true, 1100))
  }

  @Test fun captureProgressCannotHideAStoppedRenderer() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, 1, true, 0)
    assertEquals(PreviewFrameState.LIVE, tracker.update(2, 2, 2, true, 1000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(20, 2, 2, true, 2999))
    assertEquals(PreviewFrameState.STILL, tracker.update(30, 2, 2, true, 3000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(31, 3, 3, true, 3100))
  }

  @Test fun newCaptureSessionDiscardsPreviousLiveness() {
    val tracker = PreviewFrameProgress()
    tracker.update(9, 8, 7, true, 0)
    tracker.update(10, 9, 8, true, 100)
    assertEquals(PreviewFrameState.STILL, tracker.update(1, 1, 9, true, 200))
  }

  @Test fun successfulSwapsCannotHideAFrozenTextureView() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, 1, true, 0)
    assertEquals(PreviewFrameState.LIVE, tracker.update(2, 2, 2, true, 1000))
    assertEquals(PreviewFrameState.STILL, tracker.update(90, 90, 2, true, 3000))
    assertEquals(PreviewFrameState.LIVE, tracker.update(91, 91, 3, true, 3100))
  }

  @Test fun displayingTheSameCaptureAgainDoesNotEstablishSourceProgress() {
    val tracker = PreviewFrameProgress()
    tracker.update(1, 1, 1, true, 0)
    tracker.update(2, 2, 2, true, 1000)
    assertEquals(PreviewFrameState.STILL, tracker.update(2, 90, 90, true, 3000))
  }

  @Test fun textureRecreationDiscardsPreviousLiveness() {
    val tracker = PreviewFrameProgress()
    tracker.update(9, 8, 7, true, 0)
    tracker.update(10, 9, 8, true, 100)
    assertEquals(PreviewFrameState.WAITING, tracker.update(11, 10, 0, true, 200))
    assertEquals(PreviewFrameState.LIVE, tracker.update(12, 11, 1, true, 300))
  }

  @Test fun hidingTheHostDiscardsPreviousLiveness() {
    val tracker = PreviewFrameProgress()
    tracker.update(9, 8, 7, true, 0)
    tracker.update(10, 9, 8, true, 100)
    tracker.reset()
    assertEquals(PreviewFrameState.STILL, tracker.update(11, 10, 9, true, 200))
  }
}
