package io.github.kiramei.baas_tauri

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePreviewDismissalTest {
  @Test fun closeSurvivesRepeatedFrontendUpdates() {
    val visibility = NativePreviewDismissal()
    visibility.request(true)
    assertTrue(visibility.allows(true))
    visibility.dismiss()
    repeat(10) {
      visibility.request(true)
      assertFalse(visibility.allows(true))
    }
  }

  @Test fun activityHideDoesNotReopenANativelyClosedPreview() {
    val visibility = NativePreviewDismissal()
    visibility.dismiss()
    assertFalse(visibility.allows(false))
    assertFalse(visibility.allows(true))
  }

  @Test fun explicitFrontendCloseAndOpenCanStartANewPreview() {
    val visibility = NativePreviewDismissal()
    visibility.dismiss()
    visibility.request(false)
    assertFalse(visibility.allows(false))
    visibility.request(true)
    assertTrue(visibility.allows(true))
  }

  @Test fun explicitFullscreenRequestCanReopenANativeView() {
    val visibility = NativePreviewDismissal()
    visibility.dismiss()
    visibility.openExplicitly()
    assertTrue(visibility.allows(true))
  }
}
