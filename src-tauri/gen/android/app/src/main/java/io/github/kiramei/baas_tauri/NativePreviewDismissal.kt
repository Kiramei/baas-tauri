package io.github.kiramei.baas_tauri

/** A native close must survive repeated geometry updates from an unresponsive WebView. */
internal class NativePreviewDismissal {
  private var dismissed = false

  fun request(enabled: Boolean) {
    if (!enabled) dismissed = false
  }

  fun allows(enabled: Boolean): Boolean = enabled && !dismissed
  fun dismiss() { dismissed = true }
  fun openExplicitly() { dismissed = false }
}
