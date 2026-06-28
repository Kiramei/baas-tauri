package io.github.kiramei.baas_tauri

import android.os.Bundle
import android.view.KeyEvent

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (BaasVolumeToggle.tryHandle(event)) {
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}
