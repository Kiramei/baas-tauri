package io.github.kiramei.baas_tauri

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ActivityResultRebindStateTest {
  private class Owner
  private class Launcher
  private interface ResultCallback
  private interface PermissionCallback
  private object Manager {
    @JvmField var activity: Owner? = null
    @JvmField var startActivityForResultLauncher: Launcher? = null
    @JvmField var startIntentSenderForResultLauncher: Launcher? = null
    @JvmField var requestPermissionsLauncher: Launcher? = null
    @JvmField var startActivityForResultCallback: ResultCallback? = null
    @JvmField var startIntentSenderForResultCallback: ResultCallback? = null
    @JvmField var requestPermissionsCallback: PermissionCallback? = null
  }
  private object MissingManager { @JvmField var activity: Owner? = null }
  private object FinalManager { @JvmField val activity: Owner? = null }
  private class InstanceManager { @JvmField var activity: Owner? = null }

  @Before fun reset() {
    Manager.activity = null
    Manager.startActivityForResultLauncher = null; Manager.startIntentSenderForResultLauncher = null; Manager.requestPermissionsLauncher = null
    Manager.startActivityForResultCallback = null; Manager.startIntentSenderForResultCallback = null; Manager.requestPermissionsCallback = null
  }

  private fun fields(manager: Class<*> = Manager::class.java, owner: Class<*> = Owner::class.java) =
    ActivityResultManagerFields(manager, owner, Launcher::class.java, ResultCallback::class.java, PermissionCallback::class.java)

  private fun rejects(work: () -> Unit) {
    try { work(); fail("An incompatible retained owner or field contract was accepted") }
    catch (_: ReflectiveOperationException) {}
    catch (_: IllegalStateException) {}
  }

  @Test fun theActualPinnedTauriDependencyHasTheAuditedSevenFieldContract() {
    fun unloaded(name: String) = Class.forName(name, false, javaClass.classLoader)
    ActivityResultManagerFields(
      unloaded("app.tauri.plugin.PluginManager"), unloaded("androidx.appcompat.app.AppCompatActivity"),
      unloaded("androidx.activity.result.ActivityResultLauncher"),
      unloaded("app.tauri.plugin.PluginManager\$ActivityResultCallback"),
      unloaded("app.tauri.plugin.PluginManager\$RequestPermissionsCallback"),
    )
  }

  @Test fun incompatibleOrMissingFieldsAreRejectedWithoutClearingCallbacks() {
    val callback = object : ResultCallback {}
    Manager.startActivityForResultCallback = callback
    rejects { fields(owner = String::class.java) }
    rejects { fields(MissingManager::class.java) }
    assertSame(callback, Manager.startActivityForResultCallback)
  }

  @Test fun aFinalOrInstanceOwnerFieldCannotBeRebound() {
    rejects { fields(FinalManager::class.java) }
    rejects { fields(InstanceManager::class.java) }
  }

  @Test fun allThreeNewLaunchersCanReplaceTheRetiredOnes() {
    val fields = fields()
    val replacements = RetainedResultChannel.values().associateWith { Launcher() }
    replacements.forEach { (channel, launcher) -> fields.setLauncher(channel, launcher) }
    replacements.forEach { (channel, launcher) -> assertSame(launcher, fields.launcher(channel)) }
  }

  @Test fun consumingAResultClearsItsCallbackBeforeAnyLaterDelivery() {
    val callback = object : ResultCallback {}
    Manager.startActivityForResultCallback = callback
    val fields = fields()
    assertSame(callback, fields.takeCallback(RetainedResultChannel.ACTIVITY))
    assertNull(fields.takeCallback(RetainedResultChannel.ACTIVITY))
  }

  @Test fun retiringAnOwnerClearsCallbacksForEveryResultChannel() {
    Manager.startActivityForResultCallback = object : ResultCallback {}
    Manager.startIntentSenderForResultCallback = object : ResultCallback {}
    Manager.requestPermissionsCallback = object : PermissionCallback {}
    val fields = fields(); fields.clearCallbacks()
    RetainedResultChannel.values().forEach { assertNull(fields.takeCallback(it)) }
  }

  @Test fun aStillLiveActivityCannotHaveItsLaunchersStolen() {
    val state = ActivityResultOwnerEpoch<Owner>()
    val first = Owner(); val current = state.replace(first, null, false)
    rejects { state.replace(Owner(), first, false) }
    assertTrue(state.isCurrent(current))
  }

  @Test fun lateOldPickerResultsCannotMatchAnyNewRegistryKey() {
    val state = ActivityResultOwnerEpoch<Owner>()
    val first = Owner(); val second = Owner()
    val old = state.replace(first, null, false)
    val next = state.replace(second, first, true)
    assertFalse(state.isCurrent(old)); assertTrue(state.isCurrent(next))
    val oldKeys = RetainedResultChannel.values().map(old::key).toSet()
    val nextKeys = RetainedResultChannel.values().map(next::key).toSet()
    assertEquals(3, oldKeys.size); assertEquals(3, nextKeys.size)
    assertTrue(oldKeys.intersect(nextKeys).isEmpty())
  }

  @Test fun repeatedCreateForTheSameOwnerDoesNotInvalidateItsActivePicker() {
    val state = ActivityResultOwnerEpoch<Owner>()
    val owner = Owner(); val binding = state.replace(owner, null, false)
    assertSame(binding, state.replace(owner, owner, false))
    assertTrue(state.isCurrent(binding))
  }

  @Test fun restoredOldRegistryKeysDoNotCollideAfterProcessDeath() {
    val before = ActivityResultOwnerEpoch<Owner>().replace(Owner(), null, false)
    val after = ActivityResultOwnerEpoch<Owner>().replace(Owner(), null, false)
    RetainedResultChannel.values().forEach { assertNotEquals(before.key(it), after.key(it)) }
  }

  @Test fun failedRegistrationInvalidatesItsCallbacksAndRetryUsesFreshKeys() {
    val state = ActivityResultOwnerEpoch<Owner>()
    val owner = Owner(); val failed = state.replace(owner, null, false)
    state.invalidate(failed)
    assertFalse(state.isCurrent(failed))
    val retry = state.replace(owner, null, false)
    assertTrue(state.isCurrent(retry))
    RetainedResultChannel.values().forEach { assertNotEquals(failed.key(it), retry.key(it)) }
    state.invalidate(failed)
    assertTrue(state.isCurrent(retry))
  }
}
