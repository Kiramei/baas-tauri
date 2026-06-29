package io.github.kiramei.baas_tauri

import android.app.Application

class BaasApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    BaasBackend.ensureStarted(this)
  }
}
