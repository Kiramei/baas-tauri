package io.github.kiramei.baas_tauri

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Process
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.json.JSONObject

/** Each manifest slot owns a fresh same-UID process and runs exactly one job. */
abstract class PluginWorkerService(private val slot: Int) : Service() {
  private val claimed = AtomicBoolean(false)
  private val stopping = AtomicBoolean(false)
  @Volatile private var ownsProcess = false
  @Volatile private var ownsGroup = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null || !claimed.compareAndSet(false, true)) return START_NOT_STICKY
    val token = intent.getStringExtra("token")
    val jobPath = intent.getStringExtra("jobDir")
    val packagePath = intent.getStringExtra("packageDir")
    thread(name = "baas-plugin-worker-$slot", isDaemon = true) {
      var directory: File? = null
      try {
        val name = File("/proc/self/cmdline").readText().substringBefore('\u0000')
        check(name == PluginWorkerBridge.processName(this, slot)) { "Wrong plugin worker process" }
        ownsProcess = true
        val pid = Process.myPid()
        if (PluginWorkerBridge.processGroup(pid) != pid) Os.setsid()
        check(PluginWorkerBridge.processGroup(pid) == pid) { "Plugin worker has no independent process group" }
        ownsGroup = true
        val ownerPid = checkNotNull(intent).getIntExtra("ownerPid", 0)
        val ownerTicks = checkNotNull(intent.getStringExtra("ownerStartTicks"))
        check(ownerPid > 1 && ownerPid != pid && ownerTicks.isNotBlank())
        // This Java watchdog survives a stuck Python GIL/native extension and
        // reclaims an orphan if its owning backend process dies or is replaced.
        val deadline = SystemClock.elapsedRealtime() + 135000
        thread(name = "baas-plugin-watchdog-$slot", isDaemon = true) {
          while (!stopping.get()) {
            if (SystemClock.elapsedRealtime() >= deadline || PluginWorkerBridge.startTicks(ownerPid) != ownerTicks) {
              stopping.set(true)
              stopSelf(startId)
              terminateOwnedProcess()
              break
            }
            SystemClock.sleep(100)
          }
        }
        check(!stopping.get()) { "Plugin worker was stopped" }
        check(token != null && token.matches(Regex("[a-f0-9-]{36}"))) { "Missing plugin worker token" }
        directory = PluginWorkerBridge.privateDirectory(this, checkNotNull(jobPath))
        val packageRoot = PluginWorkerBridge.privateDirectory(this, checkNotNull(packagePath))
        val request = PluginWorkerBridge.privateInput(directory, "request.json", 131072)
        PluginWorkerBridge.privateInput(directory, "worker.py", 131072)
        check(!File(directory, "worker.json").exists() && !File(directory, "result.json").exists())
        writeAtomic(File(directory, "worker.json"), JSONObject().put("slot", slot).put("token", token)
          .put("pid", pid).put("group", pid).put("startTicks", checkNotNull(PluginWorkerBridge.startTicks(pid))).toString())
        // Silence native descriptor writes as well as Python's separate streams.
        val sink = Os.open("/dev/null", OsConstants.O_WRONLY, 0)
        try { Os.dup2(sink, 1); Os.dup2(sink, 2) } finally { Os.close(sink) }
        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        check(!stopping.get()) { "Plugin worker was stopped" }
        Python.getInstance().getModule("android_backend.plugin_worker").callAttr(
          "run", packageRoot.path, request.path, File(directory, "result.json").path)
      } catch (_: Throwable) {
        directory?.let {
          runCatching { writeAtomic(File(it, "result.json"), """{"ok":false,"code":"ACTION_FAILED","message":"Plugin action failed."}""") }
        }
      } finally {
        stopSelf(startId)
        terminateOwnedProcess()
      }
    }
    // A killed action must never be replayed by Android.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopping.set(true)
    super.onDestroy()
    terminateOwnedProcess()
  }

  private fun terminateOwnedProcess() {
    if (!ownsProcess) return
    val pid = Process.myPid()
    if (ownsGroup && PluginWorkerBridge.processGroup(pid) == pid)
      runCatching { Os.kill(-pid, OsConstants.SIGKILL) }
    Process.killProcess(pid)
  }

  private fun writeAtomic(destination: File, content: String) {
    val temporary = File(destination.parentFile, destination.name + ".native-tmp")
    check(!temporary.exists() && destination.canonicalFile == destination.absoluteFile)
    FileOutputStream(temporary).use { stream ->
      stream.write(content.toByteArray(Charsets.UTF_8))
      stream.fd.sync()
    }
    check(temporary.renameTo(destination)) { "Unable to publish plugin worker result" }
  }
}

class PluginWorkerService0 : PluginWorkerService(0)
class PluginWorkerService1 : PluginWorkerService(1)
