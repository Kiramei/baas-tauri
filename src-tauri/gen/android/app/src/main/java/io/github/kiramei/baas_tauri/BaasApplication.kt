package io.github.kiramei.baas_tauri

import android.app.Application
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import kotlin.concurrent.thread

class BaasApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    if (!Python.isStarted()) {
      Python.start(AndroidPlatform(this))
    }
    thread(name = "baas-python-bootstrap", isDaemon = true) {
      try {
        val androidDataRoot = resolveAndroidDataRoot()
        Python.getInstance()
          .getModule("android_backend.bootstrap")
          .callAttr(
            "start",
            applicationContext.filesDir.absolutePath,
            androidDataRoot.absolutePath,
            8190,
            applicationInfo.nativeLibraryDir,
          )
      } catch (error: Throwable) {
        Log.e("BAAS", "Python backend bootstrap failed", error)
      }
    }
  }

  private fun resolveAndroidDataRoot(): File {
    val packageRoot = applicationContext.getExternalFilesDir(null)?.parentFile
      ?: File(applicationContext.filesDir, packageName)
    packageRoot.mkdirs()

    File(applicationContext.filesDir, "baas-android-storage-root.txt")
      .writeText(packageRoot.absolutePath)

    return packageRoot
  }
}
