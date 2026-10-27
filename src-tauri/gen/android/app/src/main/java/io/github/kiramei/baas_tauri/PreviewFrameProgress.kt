package io.github.kiramei.baas_tauri

internal enum class PreviewFrameState { WAITING, BLACK, STILL, LIVE }

internal class PreviewDisplayedFrames {
  var count = 0L
    private set
  private var timestamp: Long? = null

  fun reset() { count = 0; timestamp = null }

  fun record(next: Long) {
    if (next <= 0 || next == timestamp) return
    timestamp = next
    count++
  }
}

internal class PreviewFrameProgress {
  private var previousCaptured: Long? = null
  private var previousPresented: Long? = null
  private var previousDisplayed: Long? = null
  private var capturedAt: Long? = null
  private var presentedAt: Long? = null
  private var displayedAt: Long? = null

  @Synchronized fun reset() {
    previousCaptured = null
    previousPresented = null
    previousDisplayed = null
    capturedAt = null
    presentedAt = null
    displayedAt = null
  }

  @Synchronized fun update(captured: Long, presented: Long, displayed: Long, hasContent: Boolean, now: Long): PreviewFrameState {
    if (previousCaptured?.let { captured < it } == true ||
      previousPresented?.let { presented < it } == true ||
      previousDisplayed?.let { displayed < it } == true) reset()
    if (previousCaptured?.let { captured > it } == true) capturedAt = now
    if (previousPresented?.let { presented > it } == true) presentedAt = now
    if (previousDisplayed?.let { displayed > it } == true) displayedAt = now
    previousCaptured = captured
    previousPresented = presented
    previousDisplayed = displayed
    if (captured <= 0 || presented <= 0 || displayed <= 0) return PreviewFrameState.WAITING
    if (!hasContent) return PreviewFrameState.BLACK
    // A successful GPU swap does not establish that TextureView consumed it.
    return if (listOf(capturedAt, presentedAt, displayedAt).all { it != null && now - it < 2000 }) {
      PreviewFrameState.LIVE
    } else PreviewFrameState.STILL
  }
}
