package io.github.kiramei.baas_tauri

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    if (!BuildConfig.DEBUG) {
      return
    }

    val devUrl = File(filesDir, "baas-tauri-dev-url.txt")
      .takeIf { it.isFile }
      ?.readText()
      ?.trim()
      .orEmpty()
    if (devUrl.startsWith("http://") || devUrl.startsWith("https://")) {
      webView.post { webView.loadUrl(devUrl) }
    }
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (BaasVolumeToggle.tryHandle(event)) {
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}
