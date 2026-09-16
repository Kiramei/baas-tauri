package io.github.kiramei.baas_tauri

import android.content.Context
import android.os.ParcelFileDescriptor
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter

class PrivilegedDisplayBridge private constructor(
  private val inputFd: ParcelFileDescriptor,
  private val outputFd: ParcelFileDescriptor,
) : Closeable {
  private val writer = BufferedWriter(OutputStreamWriter(FileOutputStream(inputFd.fileDescriptor)))
  private val reader = BufferedReader(InputStreamReader(FileInputStream(outputFd.fileDescriptor)))

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
    runCatching { inputFd.close() }
    runCatching { outputFd.close() }
  }

  companion object {
    init {
      System.loadLibrary("baas_display_launcher")
    }

    @JvmStatic
    private external fun spawnBackend(apkPath: String, mainClass: String): IntArray?

    fun start(context: Context): PrivilegedDisplayBridge {
      val fds = spawnBackend(
        context.applicationInfo.sourceDir,
        PrivilegedDisplayMain::class.java.name,
      ) ?: throw IllegalStateException("Unable to start privileged display backend")
      if (fds.size != 3) throw IllegalStateException("Invalid privileged display descriptors")
      return PrivilegedDisplayBridge(
        ParcelFileDescriptor.adoptFd(fds[1]),
        ParcelFileDescriptor.adoptFd(fds[2]),
      ).also { it.request("PING") }
    }
  }
}
