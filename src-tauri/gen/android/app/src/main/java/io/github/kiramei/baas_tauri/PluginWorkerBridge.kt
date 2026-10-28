package io.github.kiramei.baas_tauri

import android.content.Context
import android.content.Intent
import android.os.Process
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

/** Private same-UID worker lifecycle. These processes are not a security sandbox. */
object PluginWorkerBridge {
  private data class Lease(
    val token: String,
    val jobDir: File,
    var pid: Int = 0,
    var startTicks: String = "",
  )
  private val locks = arrayOf(Any(), Any())
  private val leases = ConcurrentHashMap<Int, Lease>()

  @JvmStatic fun getApplicationContext(): Context =
    (Python.getPlatform() as? AndroidPlatform)?.application
      ?: error("Android Python platform is unavailable")

  internal fun workerClass(slot: Int): Class<out PluginWorkerService> = when (slot) {
    0 -> PluginWorkerService0::class.java
    1 -> PluginWorkerService1::class.java
    else -> error("Invalid plugin worker slot")
  }

  internal fun privateDirectory(context: Context, path: String): File {
    val directory = File(path).absoluteFile
    val canonical = directory.canonicalFile
    check(directory.path == canonical.path && canonical.isDirectory) { "Invalid private worker directory" }
    val allowed = listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir)
    check(allowed.any { canonical.path.startsWith(it.canonicalPath + File.separator) }) {
      "Worker directory is outside private app storage"
    }
    return canonical
  }

  internal fun privateInput(directory: File, name: String, maximum: Long): File {
    val file = File(directory, name)
    check(file.canonicalFile == file.absoluteFile && file.isFile && file.length() in 1..maximum) {
      "Invalid private worker input"
    }
    return file
  }

  internal fun processName(context: Context, slot: Int) = "${context.packageName}:baas_plugin_worker$slot"

  private fun processStat(pid: Int): List<String>? = runCatching {
    val stat = File("/proc/$pid/stat").readText()
    stat.substring(stat.lastIndexOf(')') + 1).trim().split(Regex("\\s+"))
  }.getOrNull()

  internal fun startTicks(pid: Int): String? = processStat(pid)?.getOrNull(19)
  internal fun processGroup(pid: Int): Int? = processStat(pid)?.getOrNull(2)?.toIntOrNull()

  private fun identityMatches(context: Context, slot: Int, lease: Lease): Boolean = runCatching {
    lease.pid > 1 && lease.pid != Process.myPid() &&
      Os.stat("/proc/${lease.pid}").st_uid == Process.myUid() &&
      File("/proc/${lease.pid}/cmdline").readText().substringBefore('\u0000') == processName(context, slot) &&
      startTicks(lease.pid) == lease.startTicks && processGroup(lease.pid) == lease.pid
  }.getOrDefault(false)

  /** Called from a backend thread. Only the native ready marker supplies process identity. */
  @JvmStatic fun start(slot: Int, jobDir: String, packageDir: String): String {
    workerClass(slot)
    val context = getApplicationContext()
    synchronized(locks[slot]) {
      leases[slot]?.let { check(!identityMatches(context, slot, it)) { "Plugin worker slot is busy" } }
      val directory = privateDirectory(context, jobDir)
      val packageRoot = privateDirectory(context, packageDir)
      privateInput(directory, "request.json", 131072)
      privateInput(directory, "worker.py", 131072)
      check(!File(directory, "result.json").exists() && !File(directory, "worker.json").exists()) {
        "Plugin worker job directory must be fresh"
      }
      val lease = Lease(UUID.randomUUID().toString(), directory)
      leases[slot] = lease
      val intent = Intent(context, workerClass(slot)).putExtra("token", lease.token)
        .putExtra("jobDir", directory.path).putExtra("packageDir", packageRoot.path)
        .putExtra("ownerPid", Process.myPid()).putExtra("ownerStartTicks", startTicks(Process.myPid()))
      try {
        check(context.startService(intent) != null) { "Plugin worker service unavailable" }
        val deadline = SystemClock.elapsedRealtime() + 10000
        val marker = File(directory, "worker.json")
        while (SystemClock.elapsedRealtime() < deadline) {
          if (marker.isFile && marker.length() in 1..4096) {
            val ready = JSONObject(marker.readText(Charsets.UTF_8))
            check(ready.getString("token") == lease.token && ready.getInt("slot") == slot) {
              "Invalid plugin worker identity"
            }
            lease.pid = ready.getInt("pid")
            lease.startTicks = ready.getString("startTicks")
            check(ready.getInt("group") == lease.pid && lease.pid > 1 && lease.pid != Process.myPid()) {
              "Plugin worker process is not independent"
            }
            check(identityMatches(context, slot, lease) || File(directory, "result.json").isFile) {
              "Plugin worker exited before startup"
            }
            return JSONObject().put("slot", slot).put("token", lease.token)
              .put("pid", lease.pid).put("group", lease.pid).toString()
          }
          SystemClock.sleep(10)
        }
        error("Plugin worker startup timed out")
      } catch (error: Throwable) {
        if (identityMatches(context, slot, lease)) runCatching { Os.kill(-lease.pid, OsConstants.SIGKILL) }
        context.stopService(Intent(context, workerClass(slot)))
        leases.remove(slot, lease)
        throw IllegalStateException("Plugin worker could not start")
      }
    }
  }

  @JvmStatic fun status(slot: Int, token: String, expectedPid: Int): Boolean {
    if (slot !in 0..1) return false
    synchronized(locks[slot]) {
      val lease = leases[slot] ?: return false
      return lease.token == token && lease.pid == expectedPid && identityMatches(getApplicationContext(), slot, lease)
    }
  }

  /** Never accept a PID alone: a stale cancellation must not kill a reused slot. */
  @JvmStatic fun stop(slot: Int, token: String, expectedPid: Int): Boolean {
    if (slot !in 0..1) return false
    synchronized(locks[slot]) {
      val lease = leases[slot] ?: return false
      if (lease.token != token || lease.pid != expectedPid) return false
      val context = getApplicationContext()
      val running = identityMatches(context, slot, lease)
      if (running) {
        try { Os.kill(-lease.pid, OsConstants.SIGKILL) }
        catch (error: ErrnoException) { if (error.errno != OsConstants.ESRCH) throw error }
      }
      context.stopService(Intent(context, workerClass(slot)))
      val deadline = SystemClock.elapsedRealtime() + 2000
      while (identityMatches(context, slot, lease) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(10)
      check(!identityMatches(context, slot, lease)) { "Plugin worker has not exited" }
      leases.remove(slot, lease)
      return running
    }
  }
}
