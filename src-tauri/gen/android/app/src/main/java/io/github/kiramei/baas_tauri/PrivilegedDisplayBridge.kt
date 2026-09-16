package io.github.kiramei.baas_tauri

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.InputStreamReader
import java.io.OutputStreamWriter

class PrivilegedDisplayBridge private constructor(
  private val process: Process,
) : Closeable {
  private val writer = BufferedWriter(OutputStreamWriter(process.outputStream))
  private val reader = BufferedReader(InputStreamReader(process.inputStream))

  @Synchronized
  fun request(command: String): String {
    writer.write(command)
    writer.newLine()
    writer.flush()
    val response = reader.readLine() ?: throw IllegalStateException("Privileged display backend stopped")
    if (response == "OK") return ""
    if (response.startsWith("OK ")) return response.substring(3)
    if (response.startsWith("ERR ")) {
      val message = String(android.util.Base64.decode(response.substring(4), android.util.Base64.NO_WRAP))
      throw IllegalStateException(message)
    }
    throw IllegalStateException("Invalid privileged display response")
  }

  override fun close() {
    runCatching { request("EXIT") }
    runCatching { writer.close() }
    runCatching { reader.close() }
    process.destroy()
  }

  companion object {
    fun start(context: Context): PrivilegedDisplayBridge {
      // The Shizuku service is already privileged. ProcessBuilder keeps the child
      // lifecycle attached to that service without forking an initialized ART VM,
      // which can invalidate Shizuku's Binder connection on some OEM builds.
      val mainCommand = listOf(
        "/system/bin/app_process", "/system/bin",
        "--nice-name=baas_display_backend", PrivilegedDisplayMain::class.java.name,
      )
      val command = if (android.os.Process.myUid() == android.os.Process.ROOT_UID) {
        // DisplayManager validates that the owner package belongs to the caller.
        // Magisk's root Shizuku mode therefore launches the isolated backend as
        // Android's system uid, matching the identity used by MAA-Meow.
        listOf("/system/bin/su", "-p", android.os.Process.SYSTEM_UID.toString(), "-c", mainCommand.joinToString(" "))
      } else {
        mainCommand
      }
      val process = ProcessBuilder(command).apply {
        environment()["CLASSPATH"] = context.applicationInfo.sourceDir
      }.start()
      Thread({
        try {
          process.errorStream.bufferedReader().useLines { lines ->
            lines.forEach { Log.w("BaasPrivilegedDisplay", it) }
          }
        } catch (_: java.io.InterruptedIOException) {
          // Shizuku may interrupt auxiliary readers after a Binder transaction.
          // Losing diagnostic stderr must never terminate the owning service.
        } catch (error: Throwable) {
          if (process.isAlive) Log.w("BaasPrivilegedDisplay", "Diagnostic stream closed", error)
        }
      }, "baas-display-stderr").apply {
        isDaemon = true
        start()
      }
      return PrivilegedDisplayBridge(process).also { bridge ->
        try {
          bridge.request("PING")
        } catch (error: Throwable) {
          bridge.close()
          throw error
        }
      }
    }
  }
}
