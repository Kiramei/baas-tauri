package io.github.kiramei.baas_tauri

import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

object BaasScriptToggle {
  private const val TAG = "BAAS"

  fun toggleBackend(onComplete: (String) -> Unit = {}) {
    thread(name = "baas-notification-toggle", isDaemon = true) {
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
        Log.i(TAG, "Notification toggle backend response: $statusCode $body")
        connection.disconnect()
        onComplete(responseText(statusCode, body))
      } catch (error: Throwable) {
        Log.w(TAG, "Notification toggle request failed", error)
        onComplete("脚本启停失败：后端未响应")
      }
    }
  }

  private fun responseText(statusCode: Int, body: String): String {
    if (statusCode !in 200..299) {
      return "脚本启停失败：HTTP $statusCode"
    }
    return when {
      body.contains("\"status\":\"started\"") -> "脚本已启动"
      body.contains("\"status\":\"stopped\"") -> "脚本已停止"
      body.contains("\"status\":\"error\"") -> "脚本启停失败"
      else -> "脚本启停请求已发送"
    }
  }
}
