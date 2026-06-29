package io.github.kiramei.baas_tauri

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class BaasKeyToggleAccessibilityService : AccessibilityService() {
  override fun onServiceConnected() {
    super.onServiceConnected()
    val currentInfo = serviceInfo ?: AccessibilityServiceInfo()
    currentInfo.flags = currentInfo.flags or AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
    currentInfo.eventTypes = AccessibilityEvent.TYPES_ALL_MASK
    currentInfo.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
    serviceInfo = currentInfo
    Log.i("BAAS", "Volume-key accessibility service connected")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onKeyEvent(event: KeyEvent): Boolean {
    return BaasVolumeToggle.tryHandle(event) || super.onKeyEvent(event)
  }
}
