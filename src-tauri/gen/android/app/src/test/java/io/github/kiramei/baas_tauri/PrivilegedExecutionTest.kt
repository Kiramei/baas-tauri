package io.github.kiramei.baas_tauri

import java.io.IOException
import java.lang.reflect.InvocationTargetException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PrivilegedExecutionTest {
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
