package io.github.kiramei.baas_tauri

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class BaasKeyToggleAccessibilityService : AccessibilityService() {
  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onKeyEvent(event: KeyEvent): Boolean {
    return BaasVolumeToggle.tryHandle(event) || super.onKeyEvent(event)
  }
}
