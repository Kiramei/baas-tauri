package io.github.kiramei.baas_tauri

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewFocusHandshakeTest {
  private fun window(
    name: String = PrivilegedExecution.FOCUS_SHIELD_TITLE,
    display: Int = 2,
    uid: Int = 10072,
    flags: String = "NOT_TOUCH_MODAL | HARDWARE_ACCELERATED",
    features: String = "0x0",
    visible: Boolean = true,
    token: Boolean = true,
    region: String = "[0,0][1280,720]",
    type: String = "PRESENTATION",
  ) = "      0: name='abc $name', id=412, displayId=$display, portalToDisplayId=-1, paused=false, focusable=true, " +
    "visible=$visible, alpha=1.00, flags=$flags, type=$type, frame=[0,0][1280,720], " +
    "touchableRegion=$region, inputFeatures=$features, ownerPid=8734, ownerUid=$uid, dispatchingTimeout=5000ms, hasToken=$token"

  @Test fun android12MayRecoverButAndroid13KeepsUidTargeting() {
    assertFalse(PrivilegedExecution.supportsPreviewFocus(30))
    for (sdk in listOf(31, 32)) {
      assertTrue(PrivilegedExecution.supportsPreviewFocus(sdk))
      assertFalse(PrivilegedExecution.usesTargetedFocusInput(sdk))
    }
    for (sdk in listOf(33, 34, 35, 36)) {
      assertTrue(PrivilegedExecution.supportsPreviewFocus(sdk))
      assertTrue(PrivilegedExecution.usesTargetedFocusInput(sdk))
    }
  }

  @Test fun publishedOwnedFullDisplayShieldMayReceiveFocusInput() {
    assertTrue(PrivilegedExecution.ownsFocusInputWindow("Input Dispatcher State:\n  Display: 2\n    Windows:\n" + window(), 2, 10072))
  }

  @Test fun android12UsesOnlyTheOwnedHighLayerShellShield() {
    assertTrue(PrivilegedExecution.FOCUS_SHIELD_WINDOW_TYPE == 2010)
    assertTrue(PrivilegedExecution.ownsFocusInputWindow(window(uid = 2000, type = "2010"), 2, 2000))
    assertTrue(PrivilegedExecution.ownsFocusInputWindow(window(uid = 2000, type = "SYSTEM_ERROR"), 2, 2000))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(uid = 2000, type = "2008"), 2, 2000))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(uid = 2000, type = "SYSTEM_DIALOG"), 2, 2000))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(uid = 2000), 2, 2000))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(uid = 10072, type = "2010"), 2, 2000))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(name = "game", uid = 10070) + "\n" +
      window(uid = 2000, type = "2010"), 2, 2000))
  }

  @Test fun otherDisplaysAndNonInputSurfaceLayersAreIgnored() {
    val snapshot = listOf(window(display = 0, uid = 10062),
      window(name = "SurfaceView[game](BLAST)", uid = 10070, features = "NO_INPUT_CHANNEL", token = false),
      window(name = "hidden overlay", uid = 10070, visible = false), window()).joinToString("\n")
    assertTrue(PrivilegedExecution.ownsFocusInputWindow(snapshot, 2, 10072))
  }

  @Test fun gameOrOtherTouchableWindowAboveShieldRejectsInput() {
    for (name in listOf("game Activity", "other dialog", "${PrivilegedExecution.FOCUS_SHIELD_TITLE} impostor")) {
      assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(name = name) + "\n" + window(), 2, 10072))
    }
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(uid = 10070) + "\n" + window(), 2, 10072))
  }

  @Test fun noShieldOrUnknownDumpFormatNeverFallsBackToGameInput() {
    assertFalse(PrivilegedExecution.ownsFocusInputWindow("", 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window().replace("visible=true, ", ""), 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window().replace("inputFeatures=0x0, ", ""), 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window().replace("paused=false", "paused=true"), 2, 10072))
  }

  @Test fun anUnknownWindowDisplayCannotBeSkippedAboveTheOwnedShield() {
    val shield = window(uid = 2000, type = "2010")
    val other = window(name = "other dialog", uid = 10070)
    for (unknown in listOf(other.replace("displayId=2, ", ""),
      other.replace("displayId=2", "displayId=unknown"),
      other.replace("displayId=2", "displayId="))) {
      assertFalse(PrivilegedExecution.ownsFocusInputWindow(unknown + "\n" + shield, 2, 2000))
    }
    // A positively identified other display is still unrelated to our input.
    assertTrue(PrivilegedExecution.ownsFocusInputWindow(window(name = "other dialog", display = 0, uid = 10070) +
      "\n" + shield, 2, 2000))
  }

  @Test fun pointMustLieInsideTheShieldsPublishedTouchableRegion() {
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(region = "<empty>"), 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(region = "[65,0][1280,720]"), 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(region = "[0,0][64,720]"), 2, 10072))
    assertFalse(PrivilegedExecution.ownsFocusInputWindow(window(token = false), 2, 10072))
  }

  @Test fun downWithoutCancelDoesNotAcknowledgeTheHandshake() {
    val handshake = PreviewFocusHandshake()
    assertFalse(handshake.complete())
    handshake.recordDown()
    assertFalse(handshake.complete())
    handshake.recordCancel()
    assertTrue(handshake.complete())
  }

  @Test fun cancelBeforeDownDoesNotAcknowledgeTheHandshake() {
    val handshake = PreviewFocusHandshake()
    handshake.recordCancel()
    handshake.recordDown()
    assertFalse(handshake.complete())
    handshake.recordCancel()
    assertTrue(handshake.complete())
  }

  @Test fun failedRecoveryBacksOffInsteadOfOccupyingTheRequestLaneEveryTwoSeconds() {
    val retry = PreviewFocusRetry()
    assertTrue(retry.acquire(2, 0))
    retry.finish(false, 0)
    assertFalse(retry.acquire(2, 3999))
    assertTrue(retry.acquire(2, 4000))
    retry.finish(false, 4000)
    assertFalse(retry.acquire(2, 11999))
    assertTrue(retry.acquire(2, 12000))
    retry.finish(false, 12000)
    assertFalse(retry.acquire(2, 27999))
    assertTrue(retry.acquire(2, 28000))
    retry.finish(false, 28000)
    assertFalse(retry.acquire(2, 57999))
    assertTrue(retry.acquire(2, 58000))
  }

  @Test fun hideShowOrANewDisplayImmediatelyRestartsRecovery() {
    val retry = PreviewFocusRetry()
    assertTrue(retry.acquire(2, 0))
    retry.finish(false, 0)
    retry.reset()
    assertTrue(retry.acquire(2, 1))
    retry.finish(false, 1)
    assertTrue(retry.acquire(3, 2))
    assertFalse(retry.acquire(3, 3))
  }

  @Test fun successfulRecoveryRestoresTheNormalShortCooldown() {
    val retry = PreviewFocusRetry()
    assertFalse(retry.acquire(0, 0))
    assertFalse(retry.acquire(-1, 0))
    assertTrue(retry.acquire(2, 0))
    retry.finish(false, 0)
    assertTrue(retry.acquire(2, 4000))
    retry.finish(true, 4000)
    assertFalse(retry.acquire(2, 5999))
    assertTrue(retry.acquire(2, 6000))
  }
}
