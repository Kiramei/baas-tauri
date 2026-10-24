package io.github.kiramei.baas_tauri

import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.util.UUID

internal enum class RetainedResultChannel(val launcher: String, val callback: String) {
  ACTIVITY("startActivityForResultLauncher", "startActivityForResultCallback"),
  INTENT_SENDER("startIntentSenderForResultLauncher", "startIntentSenderForResultCallback"),
  PERMISSIONS("requestPermissionsLauncher", "requestPermissionsCallback"),
}

/** Validate the audited Tauri 2.11.2 layout completely before mutating anything. */
internal class ActivityResultManagerFields(
  managerClass: Class<*>, ownerClass: Class<*>, launcherClass: Class<*>,
  activityCallbackClass: Class<*>, permissionCallbackClass: Class<*>,
) {
  private val fields: Map<String, Field>

  init {
    val expected = linkedMapOf("activity" to ownerClass)
    RetainedResultChannel.values().forEach { channel ->
      expected[channel.launcher] = launcherClass
      expected[channel.callback] = if (channel == RetainedResultChannel.PERMISSIONS) permissionCallbackClass else activityCallbackClass
    }
    fields = expected.mapValues { (name, type) ->
      managerClass.getDeclaredField(name).also { field ->
        check(field.type == type && Modifier.isStatic(field.modifiers) && !Modifier.isFinal(field.modifiers)) {
          "Unsupported Tauri ActivityResult field contract: $name"
        }
        field.isAccessible = true
      }
    }
  }

  fun owner(): Any? = checkNotNull(fields["activity"]).get(null)
  fun launcher(channel: RetainedResultChannel): Any? = checkNotNull(fields[channel.launcher]).get(null)
  fun setLauncher(channel: RetainedResultChannel, launcher: Any) = checkNotNull(fields[channel.launcher]).set(null, launcher)
  fun clearCallbacks() { RetainedResultChannel.values().forEach { checkNotNull(fields[it.callback]).set(null, null) } }
  fun takeCallback(channel: RetainedResultChannel): Any? = checkNotNull(fields[channel.callback]).let { field ->
    field.get(null).also { field.set(null, null) }
  }
}

/** Old registry results must never reuse a replacement Activity's request key. */
internal class ActivityResultOwnerEpoch<O : Any> {
  class Binding<O : Any> internal constructor(val owner: O, val prefix: String) {
    fun key(channel: RetainedResultChannel): String = "$prefix.${channel.name}"
  }
  private var current: Binding<O>? = null

  fun replace(owner: O, previousOwner: O?, previousRetired: Boolean): Binding<O> {
    check(previousOwner == null || previousOwner === owner || previousRetired) { "The previous ActivityResult owner is still live" }
    if (current?.owner === owner) return checkNotNull(current)
    return Binding(owner, "baas.tauri.result.${UUID.randomUUID()}").also { current = it }
  }

  fun isCurrent(binding: Binding<O>): Boolean = current === binding
  fun invalidate(binding: Binding<O>) { if (current === binding) current = null }
}
