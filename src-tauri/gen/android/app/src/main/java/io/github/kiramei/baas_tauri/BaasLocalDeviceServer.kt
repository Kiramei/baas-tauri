package io.github.kiramei.baas_tauri

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.concurrent.Executors

/** Authenticated loopback adapter used by the embedded Python automation runtime. */
object BaasLocalDeviceServer {
  private const val TAG = "BaasLocalDeviceServer"
  private const val PORT = 7912
  private const val TOKEN_HEADER = "x-baas-token"
  private const val TOKEN_FILE = "android-local-device-token"
  private val lock = Any()

  @Volatile private var serverSocket: ServerSocket? = null
  @Volatile private var authToken = ""
  private val clients = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "baas-local-device-client").apply { isDaemon = true }
  }

  fun start(context: Context) {
    if (serverSocket != null) return
    synchronized(lock) {
      if (serverSocket != null) return
      val appContext = context.applicationContext
      authToken = loadOrCreateToken(appContext)
      val socket = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(InetAddress.getLoopbackAddress(), PORT))
      }
      serverSocket = socket
      Thread({ acceptLoop(appContext, socket) }, "baas-local-device-server").apply {
        isDaemon = true
        start()
      }
    }
  }

  private fun loadOrCreateToken(context: Context): String {
    val tokenFile = File(context.filesDir, TOKEN_FILE)
    tokenFile.takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.length >= 32 }?.let { return it }
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val token = Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE)
    tokenFile.writeText(token)
    tokenFile.setReadable(false, false)
    tokenFile.setWritable(false, false)
    tokenFile.setReadable(true, true)
    tokenFile.setWritable(true, true)
    return token
  }

  private fun acceptLoop(context: Context, socket: ServerSocket) {
    while (!socket.isClosed) {
      try {
        val client = socket.accept()
        clients.execute { handleClient(context, client) }
      } catch (error: Exception) {
        if (!socket.isClosed) Log.e(TAG, "Loopback accept failed", error)
      }
    }
  }

  private fun handleClient(context: Context, client: Socket) {
    client.use { socket ->
      socket.soTimeout = 75_000
      val input = BufferedInputStream(socket.getInputStream())
      val output = BufferedOutputStream(socket.getOutputStream())
      try {
        val requestLine = readLine(input) ?: return
        val requestParts = requestLine.split(' ', limit = 3)
        if (requestParts.size < 2) return
        val method = requestParts[0]
        val path = requestParts[1].substringBefore('?')
        val headers = linkedMapOf<String, String>()
        while (true) {
          val line = readLine(input) ?: break
          if (line.isEmpty()) break
          val separator = line.indexOf(':')
          if (separator > 0) {
            headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
          }
        }
        val length = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 16 * 1024 * 1024) ?: 0
        val body = ByteArray(length)
        var offset = 0
        while (offset < length) {
          val count = input.read(body, offset, length - offset)
          if (count < 0) break
          offset += count
        }

        when {
          method == "GET" && path == "/version" -> writeResponse(output, 200, "text/plain", "baas-shizuku-display-1")
          headers[TOKEN_HEADER] != authToken -> writeJson(output, 403, JSONObject().put("error", "forbidden"))
          method == "GET" && path == "/info" -> writeJson(output, 200, deviceInfo(context))
          method == "POST" && path == "/jsonrpc/0" -> writeJson(
            output,
            200,
            handleJsonRpc(context, JSONObject(String(body, 0, offset, StandardCharsets.UTF_8))),
          )
          method == "POST" && path == "/shell" -> writeJson(
            output,
            200,
            handleShell(context, String(body, 0, offset, StandardCharsets.UTF_8)),
          )
          else -> writeJson(output, 404, JSONObject().put("error", "not found"))
        }
      } catch (error: Exception) {
        runCatching { writeJson(output, 500, JSONObject().put("error", error.message ?: "request failed")) }
      }
    }
  }

  private fun handleJsonRpc(context: Context, request: JSONObject): JSONObject {
    val response = JSONObject().put("jsonrpc", "2.0").put("id", request.opt("id"))
    return try {
      val params = request.optJSONArray("params") ?: JSONArray()
      val result: Any = when (val method = request.getString("method")) {
        "deviceInfo" -> deviceInfo(context)
        "takeScreenshot" -> ShizukuController.captureVirtualDisplay(context).ifBlank {
          throw IllegalStateException("The Shizuku virtual display has not produced a frame yet")
        }
        "click" -> requireGesture(
          ShizukuController.gesture(context, params.getInt(0), params.getInt(1), params.getInt(0), params.getInt(1), 1)
        )
        "swipe" -> requireGesture(
          ShizukuController.gesture(
            context,
            params.getInt(0),
            params.getInt(1),
            params.getInt(2),
            params.getInt(3),
            (params.optInt(4, 20) * 5).coerceIn(1, 10_000),
          )
        )
        "pressKey" -> executeKey(context, keyCodeFor(params.optString(0)))
        "pressKeyCode" -> executeKey(context, params.getInt(0))
        "wakeUp" -> executeKey(context, 224)
        "sleep" -> executeKey(context, 223)
        "dumpWindowHierarchy" -> "<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy rotation=\"0\"/>"
        else -> throw IllegalArgumentException("Unsupported local-device method: $method")
      }
      response.put("result", result)
    } catch (error: Exception) {
      response.put(
        "error",
        JSONObject().put("code", -32000).put("message", error.message ?: "local-device request failed"),
      )
    }
  }

  private fun deviceInfo(context: Context): JSONObject {
    val displayId = ShizukuController.virtualDisplayId(context)
    if (displayId < 0) throw IllegalStateException("The Shizuku virtual display is not running")
    val size = ShizukuController.virtualDisplaySize(context)
    return JSONObject()
      .put("currentPackageName", "")
      .put("displayWidth", size[0])
      .put("displayHeight", size[1])
      .put("display", JSONObject().put("width", size[0]).put("height", size[1]))
      .put("screenOn", true)
  }

  private fun handleShell(context: Context, encodedBody: String): JSONObject {
    val args = encodedBody.split('&').associate { entry ->
      val separator = entry.indexOf('=')
      val key = if (separator >= 0) entry.substring(0, separator) else entry
      val value = if (separator >= 0) entry.substring(separator + 1) else ""
      URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
    }
    val command = args["command"]?.trim().orEmpty()
    if (command.isEmpty()) return JSONObject().put("output", "").put("exitCode", 0)
    return try {
      JSONObject().put("output", ShizukuController.execute(context, command)).put("exitCode", 0)
    } catch (error: Exception) {
      JSONObject().put("output", error.message ?: "command failed").put("exitCode", 1)
    }
  }

  private fun executeKey(context: Context, keyCode: Int): Boolean {
    ShizukuController.execute(context, "input keyevent ${keyCode.coerceIn(0, 300)}")
    return true
  }

  private fun keyCodeFor(name: String): Int = when (name.lowercase()) {
    "home" -> 3
    "back" -> 4
    "menu" -> 82
    "power" -> 26
    "enter" -> 66
    "recent", "recent_apps" -> 187
    "volume_up" -> 24
    "volume_down" -> 25
    else -> throw IllegalArgumentException("Unsupported Android key: $name")
  }

  private fun requireGesture(success: Boolean): Boolean {
    if (!success) throw IllegalStateException("Shizuku could not control the game display")
    return true
  }

  private fun readLine(input: BufferedInputStream): String? {
    val bytes = ArrayList<Byte>()
    while (bytes.size < 16_384) {
      val value = input.read()
      if (value < 0) return if (bytes.isEmpty()) null else bytes.toByteArray().toString(StandardCharsets.UTF_8)
      if (value == '\n'.code) break
      if (value != '\r'.code) bytes.add(value.toByte())
    }
    return bytes.toByteArray().toString(StandardCharsets.UTF_8)
  }

  private fun writeJson(output: BufferedOutputStream, status: Int, value: JSONObject) {
    writeResponse(output, status, "application/json", value.toString())
  }

  private fun writeResponse(output: BufferedOutputStream, status: Int, contentType: String, body: String) {
    val payload = body.toByteArray(StandardCharsets.UTF_8)
    val reason = when (status) {
      200 -> "OK"
      403 -> "Forbidden"
      404 -> "Not Found"
      else -> "Internal Server Error"
    }
    output.write(
      "HTTP/1.1 $status $reason\r\nContent-Type: $contentType\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
        .toByteArray(StandardCharsets.US_ASCII)
    )
    output.write(payload)
    output.flush()
  }
}
