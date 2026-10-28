package io.github.kiramei.baas_tauri

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

class ShellProcessIdentityTest {
  class Info(@JvmField val packageName: String?)
  class Bound(@JvmField var appInfo: Info? = null)
  class Application(val packageName: String?)
  class Thread {
    @JvmField var mBoundApplication: Bound? = null
    @JvmField var mInitialApplication: Application? = null
    fun currentPackageName(): String? = mBoundApplication?.appInfo?.packageName
    fun currentOpPackageName(): String? = mInitialApplication?.packageName
  }

  private val shell = ShellProcessIdentity.PACKAGE_NAME
  private val host = "io.github.kiramei.baas_tauri"
  private fun prepare(thread: Thread, info: Info = Info(shell), uid: Int = 2000, factory: () -> Any = { Application(shell) }) =
    ShellProcessIdentity.prepare(thread, info, host, uid, factory) { (it as Application).packageName }

  @Test fun unboundAppProcessGetsNonNullFrameworkAndOpPackageNames() {
    val thread = Thread()
    assertNull(thread.currentPackageName())
    assertNull(thread.currentOpPackageName())
    val info = Info(shell)
    prepare(thread, info)
    assertSame(info, thread.mBoundApplication!!.appInfo)
    assertEquals(shell, thread.currentPackageName())
    assertEquals(shell, thread.currentOpPackageName())
  }

  @Test fun initializationReusesTheExistingShellApplicationAndBoundData() {
    val thread = Thread()
    prepare(thread)
    val bound = thread.mBoundApplication
    val application = thread.mInitialApplication
    prepare(thread, factory = { fail("Already initialized identities must not be recreated"); Application(shell) })
    assertSame(bound, thread.mBoundApplication)
    assertSame(application, thread.mInitialApplication)
  }

  @Test fun systemMainPlaceholderAndIncompleteBindDataAreFilledForShell() {
    val thread = Thread().apply {
      mBoundApplication = Bound()
      mInitialApplication = Application("android")
    }
    val bound = thread.mBoundApplication
    prepare(thread)
    assertSame(bound, thread.mBoundApplication)
    assertEquals(shell, thread.currentPackageName())
    assertEquals(shell, thread.currentOpPackageName())
  }

  @Test fun foreignBoundIdentityIsNeverOverwritten() {
    val thread = Thread().apply { mBoundApplication = Bound(Info("other.app")) }
    try { prepare(thread); fail("Foreign identities must fail closed") } catch (_: IllegalStateException) { }
    assertEquals("other.app", thread.currentPackageName())
    assertNull(thread.mInitialApplication)
  }

  @Test fun foreignApplicationIdentityIsNeverOverwritten() {
    val thread = Thread().apply { mInitialApplication = Application("other.app") }
    try { prepare(thread); fail("Foreign applications must fail closed") } catch (_: IllegalStateException) { }
    assertNull(thread.mBoundApplication)
    assertEquals("other.app", thread.currentOpPackageName())
  }

  @Test fun invalidPackageOrFailedApplicationCreationDoesNotPartiallyBind() {
    val thread = Thread()
    try { prepare(thread, Info("other.app")); fail("A real shell ApplicationInfo is required") } catch (_: IllegalStateException) { }
    assertNull(thread.mBoundApplication)
    try { prepare(thread, factory = { throw IllegalStateException("No application") }); fail("Creation must succeed first") } catch (_: IllegalStateException) { }
    assertNull(thread.mBoundApplication)
    assertNull(thread.mInitialApplication)
  }

  @Test fun factoryCannotIntroduceAnUnexpectedApplicationIdentity() {
    val thread = Thread()
    try { prepare(thread, factory = { Application("other.app") }); fail("The prepared application must be shell-owned") } catch (_: IllegalStateException) { }
    assertNull(thread.mBoundApplication)
    assertNull(thread.mInitialApplication)
  }

  @Test fun shizukuHostApplicationIsAcceptedOnlyBeforeARealIdentityIsBound() {
    for (incompleteBound in listOf(null, Bound(), Bound(Info(null)))) {
      val thread = Thread().apply {
        mBoundApplication = incompleteBound
        mInitialApplication = Application(host)
      }
      prepare(thread)
      assertEquals(shell, thread.currentPackageName())
      assertEquals(shell, thread.currentOpPackageName())
    }
  }

  @Test fun boundShellIdentityDoesNotAuthorizeReplacingAHostApplication() {
    val thread = Thread().apply {
      mBoundApplication = Bound(Info(shell))
      mInitialApplication = Application(host)
    }
    try { prepare(thread); fail("The host exception is only for an unbound bootstrap") } catch (error: IllegalStateException) {
      org.junit.Assert.assertTrue(error.message!!.contains("application=$host"))
      org.junit.Assert.assertTrue(error.message!!.contains("bound=$shell"))
    }
    assertEquals(shell, thread.currentPackageName())
    assertEquals(host, thread.currentOpPackageName())
  }

  @Test fun bootstrapCannotRunInTheHostAppOrAnyOtherNonShellUid() {
    for (uid in listOf(0, 1000, 10072)) {
      val thread = Thread().apply { mInitialApplication = Application(host) }
      try { prepare(thread, uid = uid); fail("Only the existing shell service may initialize its identity") } catch (error: IllegalStateException) {
        org.junit.Assert.assertTrue(error.message!!.contains("uid=$uid"))
      }
      assertNull(thread.mBoundApplication)
      assertEquals(host, thread.currentOpPackageName())
    }
  }

  @Test fun foreignUnboundApplicationIsRejectedWithItsPackageInDiagnostics() {
    val thread = Thread().apply { mInitialApplication = Application("other.app") }
    try { prepare(thread); fail("An unbound process does not authorize arbitrary applications") } catch (error: IllegalStateException) {
      org.junit.Assert.assertTrue(error.message!!.contains("application=other.app"))
      org.junit.Assert.assertTrue(error.message!!.contains("host=$host"))
      org.junit.Assert.assertTrue(error.message!!.contains("uid=2000"))
    }
    assertNull(thread.mBoundApplication)
    assertEquals("other.app", thread.currentOpPackageName())
  }
}
