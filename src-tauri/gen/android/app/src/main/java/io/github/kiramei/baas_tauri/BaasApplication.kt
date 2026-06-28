package io.github.kiramei.baas_tauri

import android.app.Application
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import kotlin.concurrent.thread

class BaasApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    if (!Python.isStarted()) {
      Python.start(AndroidPlatform(this))
    }
    thread(name = "baas-python-bootstrap", isDaemon = true) {
      try {
        Python.getInstance()
          .getModule("android_backend.bootstrap")
          .callAttr("start", applicationContext.filesDir.absolutePath, 8190)
      } catch (error: Throwable) {
        Log.e("BAAS", "Python backend bootstrap failed", error)
      }
    }
  }
}
