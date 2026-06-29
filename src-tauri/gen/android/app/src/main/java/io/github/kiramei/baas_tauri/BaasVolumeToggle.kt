package io.github.kiramei.baas_tauri

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

object BaasVolumeToggle {
  private const val TAG = "BAAS"
  private const val DOUBLE_PRESS_WINDOW_MS = 650L
  private var lastVolumeDownAt = 0L

  @Synchronized
  fun tryHandle(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN || event.keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
      return false
    }

    return handleVolumeDownPress()
  }

  @Synchronized
  fun handleVolumeDownPress(): Boolean {
    val now = SystemClock.elapsedRealtime()
    if (now - lastVolumeDownAt <= DOUBLE_PRESS_WINDOW_MS) {
      lastVolumeDownAt = 0L
      Log.i(TAG, "Double volume-down detected; toggling backend")
      toggleBackend()
      return true
    }

    lastVolumeDownAt = now
    return false
  }

  private fun toggleBackend() {
    thread(name = "baas-volume-toggle", isDaemon = true) {
      try {
        val connection = URL("http://127.0.0.1:8190/android/toggle").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 1500
        connection.readTimeout = 5000
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(ByteArray(0)) }
        val statusCode = connection.responseCode
        val body = if (statusCode in 200..299) {
          connection.inputStream.use { String(it.readBytes()) }
        } else {
          connection.errorStream?.use { String(it.readBytes()) }.orEmpty()
        }
        Log.i(TAG, "Volume toggle backend response: $statusCode $body")
        connection.disconnect()
      } catch (error: Throwable) {
        Log.w(TAG, "Volume toggle request failed", error)
      }
    }
  }
}
