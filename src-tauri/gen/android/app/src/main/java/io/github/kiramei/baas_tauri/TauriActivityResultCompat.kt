package io.github.kiramei.baas_tauri

import android.os.Looper
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import app.tauri.plugin.PluginManager

/** Application-local workaround for Tauri 2.11.2's retained launcher owner. */
internal object TauriActivityResultCompat {
  private val owners = ActivityResultOwnerEpoch<MainActivity>()

  fun onActivityCreate(activity: MainActivity) {
    check(Looper.myLooper() === Looper.getMainLooper()) { "ActivityResult rebinding requires the main thread" }
    check(!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) { "ActivityResult launchers must bind during onCreate" }
    check(!activity.isDestroyed && !activity.isFinishing) { "Cannot bind ActivityResult launchers to a retired Activity" }
    val fields = ActivityResultManagerFields(
      PluginManager::class.java, AppCompatActivity::class.java, ActivityResultLauncher::class.java,
      PluginManager.ActivityResultCallback::class.java, PluginManager.RequestPermissionsCallback::class.java,
    )
    val previous = fields.owner()
    // TauriActivity.super.onCreate initializes a fresh process normally.
    if (previous === activity) return
    check(previous == null || previous is MainActivity) { "The retained Tauri owner is not a BAAS MainActivity" }
    val old = previous as MainActivity?
    check(old == null || (old.application === activity.application && old.packageName == activity.packageName)) {
      "The retained Tauri owner belongs to another application"
    }
    val binding = owners.replace(activity, old, old == null || old.isDestroyed || old.isChangingConfigurations)
    val replacements = linkedMapOf<RetainedResultChannel, ActivityResultLauncher<*>>()
    try {
      val registry = activity.activityResultRegistry
      replacements[RetainedResultChannel.ACTIVITY] = registry.register(
        binding.key(RetainedResultChannel.ACTIVITY), activity, ActivityResultContracts.StartActivityForResult(),
      ) { result ->
        if (accepts(binding)) (fields.takeCallback(RetainedResultChannel.ACTIVITY) as? PluginManager.ActivityResultCallback)?.onResult(result)
      }
      replacements[RetainedResultChannel.INTENT_SENDER] = registry.register(
        binding.key(RetainedResultChannel.INTENT_SENDER), activity, ActivityResultContracts.StartIntentSenderForResult(),
      ) { result ->
        if (accepts(binding)) (fields.takeCallback(RetainedResultChannel.INTENT_SENDER) as? PluginManager.ActivityResultCallback)?.onResult(result)
      }
      replacements[RetainedResultChannel.PERMISSIONS] = registry.register(
        binding.key(RetainedResultChannel.PERMISSIONS), activity, ActivityResultContracts.RequestMultiplePermissions(),
      ) { result ->
        if (accepts(binding)) (fields.takeCallback(RetainedResultChannel.PERMISSIONS) as? PluginManager.RequestPermissionsCallback)?.onResult(result)
      }
      // Old keys stay unregistered. A result from an old picker cannot reach a
      // newly installed callback, even if the new UI has opened another picker.
      RetainedResultChannel.values().forEach { (fields.launcher(it) as? ActivityResultLauncher<*>)?.unregister() }
      fields.clearCallbacks()
      replacements.forEach { (channel, launcher) -> fields.setLauncher(channel, launcher) }
      PluginManager.activity = activity
    } catch (error: Throwable) {
      owners.invalidate(binding)
      replacements.values.forEach { runCatching { it.unregister() } }
      throw IllegalStateException("Cannot register the replacement BAAS ActivityResult launchers", error)
    }
    android.util.Log.i("BAASStartup", "activity_result_owner_rebound")
  }

  private fun accepts(binding: ActivityResultOwnerEpoch.Binding<MainActivity>): Boolean =
    owners.isCurrent(binding) && PluginManager.activity === binding.owner &&
      !binding.owner.isDestroyed && !binding.owner.isFinishing && !binding.owner.isChangingConfigurations
}
