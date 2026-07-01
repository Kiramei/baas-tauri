package io.github.kiramei.baas_tauri

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    ensureForegroundService()
  }

  override fun onResume() {
    super.onResume()
    ensureForegroundService()
    scheduleDebugDevUrlLoads()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(Color.rgb(15, 23, 42))
    loadDebugDevUrl(webView)
    scheduleDebugDevUrlLoads(webView)
  }

  private fun ensureForegroundService() {
    val intent = Intent(this, BaasForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(intent)
    } else {
      startService(intent)
    }
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
