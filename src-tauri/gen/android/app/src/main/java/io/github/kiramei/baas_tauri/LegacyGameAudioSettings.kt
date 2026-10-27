package io.github.kiramei.baas_tauri

import android.content.Context

/** One-time recovery of audio settings saved by the previous embedded mute implementation. */
object LegacyGameAudioSettings {
  private fun preferences(context: Context) = context.getSharedPreferences("embedded-game-audio", Context.MODE_PRIVATE)

  @Synchronized fun restoreAll(context: Context) {
    val saved = preferences(context)
    for ((packageName, value) in saved.all) {
      require(packageName.matches(Regex("[A-Za-z0-9_.]+")))
      val mode = value as? String ?: continue
      require(mode in setOf("allow", "ignore", "deny", "default", "foreground"))
      ShizukuController.execute(context, "cmd appops set --user 0 $packageName PLAY_AUDIO $mode")
      check(saved.edit().remove(packageName).commit()) { "Cannot clear the game's audio setting" }
    }
  }
}
