package io.github.kiramei.baas_tauri

internal enum class PreviewFrameState { WAITING, BLACK, STILL, LIVE }

internal class PreviewFrameProgress {
  private var previousPresented: Long? = null
  private var advancedAt: Long? = null

  @Synchronized fun update(captured: Long, presented: Long, hasContent: Boolean, now: Long): PreviewFrameState {
    val previous = previousPresented
    if (previous == null || presented < previous) advancedAt = null
    else if (presented > previous) advancedAt = now
    previousPresented = presented
    if (captured <= 0 || presented <= 0) return PreviewFrameState.WAITING
    if (!hasContent) return PreviewFrameState.BLACK
    return if (advancedAt?.let { now - it < 2000 } == true) PreviewFrameState.LIVE else PreviewFrameState.STILL
  }
}
