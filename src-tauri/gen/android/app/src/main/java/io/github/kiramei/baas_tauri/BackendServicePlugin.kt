package io.github.kiramei.baas_tauri

import android.app.Activity
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class BackendServicePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun ensureStarted(invoke: Invoke) {
    try {
      val context = activity.applicationContext
      val intent = Intent(context, BaasForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      val result = JSObject()
      result.put("pipePath", File(context.filesDir, "baas-service.sock").absolutePath)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }
}
