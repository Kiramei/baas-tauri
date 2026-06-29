package io.github.kiramei.baas_tauri

import android.content.Context
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
    if (!Python.isStarted()) {
      Python.start(AndroidPlatform(appContext))
    }
    if (!started.compareAndSet(false, true)) {
      return
    }
    thread(name = "baas-python-bootstrap", isDaemon = true) {
      try {
        val androidDataRoot = resolveAndroidDataRoot(appContext)
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
        started.set(false)
        Log.e(TAG, "Python backend bootstrap failed", error)
      }
    }
  }

  private fun resolveAndroidDataRoot(context: Context): File {
    val packageRoot = context.getExternalFilesDir(null)?.parentFile
      ?: File(context.filesDir, context.packageName)
    packageRoot.mkdirs()

    File(context.filesDir, "baas-android-storage-root.txt")
      .writeText(packageRoot.absolutePath)

    return packageRoot
  }
}
