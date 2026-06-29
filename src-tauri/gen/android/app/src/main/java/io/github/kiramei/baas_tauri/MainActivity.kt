package io.github.kiramei.baas_tauri

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
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
    scheduleDebugDevUrlLoads()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    loadDebugDevUrl(webView)
    scheduleDebugDevUrlLoads(webView)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (BaasVolumeToggle.tryHandle(event)) {
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  private fun maybePromptAccessibilityService() {
    if (hasDebugDevUrlMarker() || promptedAccessibility || isVolumeToggleAccessibilityEnabled()) {
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

  private fun hasDebugDevUrlMarker(): Boolean {
    return BuildConfig.DEBUG && File(filesDir, "baas-tauri-dev-url.txt").isFile
  }

  private fun readDebugDevUrl(): String {
    if (!BuildConfig.DEBUG) {
      return ""
    }
    return File(filesDir, "baas-tauri-dev-url.txt")
      .takeIf { it.isFile }
      ?.readText()
      ?.trim()
      .orEmpty()
  }

  private fun scheduleDebugDevUrlLoads() {
    if (!BuildConfig.DEBUG) {
      return
    }
    for (delay in listOf(250L, 1_000L, 2_500L, 5_000L, 9_000L, 13_000L)) {
      window?.decorView?.postDelayed({
        val webView = findWebView(window?.decorView)
        webView?.let { loadDebugDevUrl(it) }
      }, delay)
    }
  }

  private fun scheduleDebugDevUrlLoads(webView: WebView) {
    if (!BuildConfig.DEBUG) {
      return
    }
    for (delay in listOf(250L, 1_000L, 2_500L, 5_000L)) {
      webView.postDelayed({
        loadDebugDevUrl(webView)
      }, delay)
    }
  }

  private fun loadDebugDevUrl(webView: WebView) {
    val devUrl = readDebugDevUrl()
    if (!devUrl.startsWith("http://") && !devUrl.startsWith("https://")) {
      return
    }
    if (webView.url == devUrl || webView.url?.startsWith("$devUrl/") == true) {
      return
    }
    if (webView is RustWebView) {
      webView.loadDebugUrlMainThread(devUrl)
    } else {
      webView.post { webView.loadUrl(devUrl) }
    }
  }

  private fun findWebView(view: View?): WebView? {
    when (view) {
      null -> return null
      is WebView -> return view
      is ViewGroup -> {
        for (index in 0 until view.childCount) {
          findWebView(view.getChildAt(index))?.let { return it }
        }
      }
    }
    return null
  }
}
