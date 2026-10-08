package io.github.kiramei.baas_tauri

import android.content.Context
import android.app.ActivityManager
import android.app.Application
import android.os.Build
import android.os.Process
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

object BaasBackend {
  private const val TAG = "BAAS"
  private val started = AtomicBoolean(false)

  fun ensureStarted(context: Context) {
    val appContext = context.applicationContext
    val processName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      Application.getProcessName()
    } else {
      appContext.getSystemService(ActivityManager::class.java).runningAppProcesses
        ?.firstOrNull { it.pid == Process.myPid() }?.processName
    }
    if (processName != "${appContext.packageName}:baas_backend") {
      Log.e(TAG, "Refusing Python bootstrap outside backend process: $processName")
      return
    }
    if (!started.compareAndSet(false, true)) {
      return
    }
    thread(name = "baas-python-bootstrap", isDaemon = true) {
      try {
        val androidDataRoot = resolveAndroidDataRoot(appContext)
        if (!Python.isStarted()) Python.start(AndroidPlatform(appContext))
        Python.getInstance()
          .getModule("android_backend.bootstrap")
          .callAttr(
            "start",
            appContext.filesDir.absolutePath,
            androidDataRoot.absolutePath,
            8190,
            appContext.applicationInfo.nativeLibraryDir,
          )
      } catch (error: Throwable) {
        Log.e(TAG, "Python backend bootstrap failed", error)
        val failure = org.json.JSONObject().put("stage", "failed").put("error", error.toString())
          .put("traceback", error.stackTraceToString())
        File(appContext.filesDir, "baas/android-bootstrap-status.json").writeText(failure.toString())
      } finally {
        started.set(false)
      }
    }
  }

  private fun resolveAndroidDataRoot(context: Context): File {
    val packageRoot = File(context.filesDir, "baas")
    packageRoot.mkdirs()

    File(context.filesDir, "baas-android-storage-root.txt")
      .writeText(packageRoot.absolutePath)
    File(packageRoot, "android-bootstrap-status.json").writeText(
      """{"stage":"storage","installMessage":"Checking private app data directory."}""")
    val legacy = context.getExternalFilesDir(null)?.parentFile
    val migrationMarker = File(packageRoot, ".android-storage-migrated-v1")
    if (!migrationMarker.exists() && legacy != null && File(legacy, "main.service.py").exists()) {
      File(packageRoot, "android-bootstrap-status.json").writeText(
        """{"stage":"storage","installMessage":"Migrating legacy app data; original files are retained."}""")
      // Stage separately: an interrupted copy must never look like a complete runtime.
      val staging = File(context.filesDir, "baas-migration")
      staging.mkdirs()
      legacy.walkTopDown().onEnter { it.name != "__pycache__" && it.name != "files" && it.name != ".baas-next" }.forEach { source ->
        val destination = File(staging, source.relativeTo(legacy).path)
        if (source.isDirectory) destination.mkdirs()
        else {
          source.copyTo(destination, overwrite = true)
          check(source.length() == destination.length()) { "Migration size mismatch: ${source.name}" }
        }
      }
      staging.copyRecursively(packageRoot, overwrite = true, onError = { _, error -> throw error })
      migrationMarker.writeText(legacy.absolutePath)
      // Only our validated staging directory is removed. Never remove legacy user data.
      staging.deleteRecursively()
    }
    return packageRoot
  }
}
