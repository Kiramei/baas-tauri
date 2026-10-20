package io.github.kiramei.baas_tauri

import java.io.IOException
import java.lang.reflect.InvocationTargetException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PrivilegedExecutionTest {
  @Test fun independentFocusIsRequestedOnlyOnSupportedAndroidVersions() {
    assertEquals(1355, PrivilegedExecution.trustedDisplayFlags(331, 33))
    for (sdk in listOf(34, 35, 36)) {
      assertEquals(83275, PrivilegedExecution.trustedDisplayFlags(331, sdk))
    }
  }

  @Test fun deniedTrustedDisplayDoesNotKeepPrivilegedFocusFlags() {
    val requested = mutableListOf<Int>()
    PrivilegedExecution.createShellDisplay(331, 35) {
      requested.add(it)
      if (requested.size == 1) throw SecurityException("denied")
      7
    }
    assertEquals(listOf(83275, 331), requested)
  }

  @Test fun trustedDisplayPreservesOtherFlags() {
    for (flags in listOf(0, 331, 6479)) {
      val trusted = PrivilegedExecution.trustedDisplayFlags(flags)
      assertTrue(trusted and (1 shl 10) != 0)
      assertEquals(flags, trusted and (1 shl 10).inv())
      assertEquals(trusted, PrivilegedExecution.trustedDisplayFlags(trusted))
    }
  }

  @Test fun shellRetriesWithoutTrustedFlagOnlyForPermissionDenial() {
    val requests = mutableListOf<Int>()
    val result = PrivilegedExecution.createShellDisplay(331) { flags ->
      requests.add(flags)
      if (flags and (1 shl 10) != 0) throw SecurityException("ADD_TRUSTED_DISPLAY")
      "display"
    }
    assertEquals("display", result)
    assertEquals(listOf(1355, 331), requests)
  }

  @Test fun successfulTrustedCreationDoesNotCreateAnotherDisplay() {
    var calls = 0
    assertEquals(17, PrivilegedExecution.createShellDisplay(331) { calls++; 17 })
    assertEquals(1, calls)
  }

  @Test fun nonPermissionFailuresAreNotRetried() {
    var calls = 0
    try {
      PrivilegedExecution.createShellDisplay<Int>(331) { calls++; throw IllegalArgumentException("invalid surface") }
      fail("Invalid surface must fail")
    } catch (_: IllegalArgumentException) {
      assertEquals(1, calls)
    }
  }

  @Test fun fallbackPermissionDenialIsReported() {
    var calls = 0
    try {
      PrivilegedExecution.createShellDisplay<Int>(331) { calls++; throw SecurityException("denied") }
      fail("Both attempts denied")
    } catch (_: SecurityException) {
      assertEquals(2, calls)
    }
  }

  @Test fun resolvesDeviceSuInsteadOfAssumingSystemBin() {
    val command = PrivilegedExecution.systemCommand(listOf("/system/bin/app_process", "a b"),
      "/system/bin:/product/bin") { it == "/product/bin/su" }
    assertEquals("/product/bin/su", command.first())
    assertEquals(listOf("-p", "1000", "-c"), command.subList(1, 4))
    assertEquals("'/system/bin/app_process' 'a b'", command.last())
  }

  @Test fun resolvesMagiskFallbackWhenServicePathOmitsIt() {
    val command = PrivilegedExecution.systemCommand(listOf("app_process"), "/system/bin") {
      it == "/debug_ramdisk/su"
    }
    assertEquals("/debug_ramdisk/su", command.first())
  }

  @Test fun missingSuFailsBeforeAnyLaunch() {
    try {
      PrivilegedExecution.systemCommand(listOf("app_process"), "/system/bin") { false }
      fail("Missing su must fail")
    } catch (error: IllegalStateException) {
      assertTrue(error.message!!.contains("Cannot find an executable su"))
    }
  }

  @Test fun ioFailuresBecomeBinderSupportedErrors() {
    try {
      PrivilegedExecution.binderResult<Int> { throw IOException("Cannot run su") }
      fail("IOException must not escape Binder")
    } catch (error: IllegalStateException) {
      assertTrue(error.message!!.contains("IOException: Cannot run su"))
    }
  }

  @Test fun reflectionErrorsKeepTheirActualCause() {
    try {
      PrivilegedExecution.binderResult<Int> {
        throw InvocationTargetException(IllegalArgumentException("Display rejected"))
      }
      fail("Reflection failure must not escape Binder")
    } catch (error: IllegalStateException) {
      assertTrue(error.message!!.contains("IllegalArgumentException: Display rejected"))
    }
  }

  @Test fun invalidDisplayNeverReachesLaunchAction() {
    for (id in listOf(-1, 0)) {
      var launched = false
      try {
        PrivilegedExecution.virtualDisplayId(id)
        launched = true
        fail("Main or missing display must not launch")
      } catch (_: IllegalStateException) {
        assertFalse(launched)
      }
    }
    assertEquals(7, PrivilegedExecution.virtualDisplayId(7))
    assertEquals(42, PrivilegedExecution.binderResult { 42 })
  }
}
