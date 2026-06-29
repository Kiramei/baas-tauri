package io.github.kiramei.baas_tauri

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.webkit.WebView
import java.io.File

class MainActivity : TauriActivity() {
  companion object {
    private var promptedAccessibility = false
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    maybePromptAccessibilityService()
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

  private fun maybePromptAccessibilityService() {
    if (promptedAccessibility || isVolumeToggleAccessibilityEnabled()) {
      return
    }
    promptedAccessibility = true
    window?.decorView?.post {
      if (isFinishing || isDestroyed || isVolumeToggleAccessibilityEnabled()) {
        return@post
      }
      AlertDialog.Builder(this)
        .setTitle(getString(R.string.baas_key_toggle_prompt_title))
        .setMessage(getString(R.string.baas_key_toggle_prompt_message))
        .setPositiveButton(getString(R.string.baas_key_toggle_prompt_open_settings)) { _, _ ->
          startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        .setNegativeButton(getString(R.string.baas_key_toggle_prompt_later), null)
        .show()
    }
  }

  private fun isVolumeToggleAccessibilityEnabled(): Boolean {
    val expected = ComponentName(this, BaasKeyToggleAccessibilityService::class.java).flattenToString()
    val shortExpected = ComponentName(this, BaasKeyToggleAccessibilityService::class.java).flattenToShortString()
    val enabled = Settings.Secure.getString(
      contentResolver,
      Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    return enabled.split(':').any { it.equals(expected, ignoreCase = true) || it.equals(shortExpected, ignoreCase = true) }
  }
}
