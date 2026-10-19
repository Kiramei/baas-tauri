package io.github.kiramei.baas_tauri

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import java.io.File

class MainActivity : TauriActivity() {
  private var foregroundServiceStartScheduled = false
  private var backRequestInFlight = false
  private var systemBarBackground = Color.rgb(24, 24, 24)
  private var systemBarDarkIcons = false

  override fun onCreate(savedInstanceState: Bundle?) {
    android.util.Log.i("BAASStartup", "activity_enter uptime=${android.os.SystemClock.uptimeMillis()} wall=${System.currentTimeMillis()}")
    super.onCreate(savedInstanceState)
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    applySystemBars(systemBarBackground, systemBarDarkIcons)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        handleAppBack()
      }
    })
    android.util.Log.i("BAASStartup", "activity_created uptime=${android.os.SystemClock.uptimeMillis()}")
    // Only the dedicated :baas_backend service process owns Python and its ports.
    // Activity recreation and WebView reloads must reconnect, never bootstrap here.
    var drawn = false
    window.decorView.viewTreeObserver.addOnDrawListener {
      if (!drawn) {
        drawn = true
        android.util.Log.i("BAASStartup", "first_draw uptime=${android.os.SystemClock.uptimeMillis()}")
      }
    }
    ShizukuController.initialize(applicationContext)
    BaasLocalDeviceServer.start(applicationContext)
    scheduleForegroundServiceStart(250L)
  }

  override fun onResume() {
    super.onResume()
    applySystemBars(systemBarBackground, systemBarDarkIcons)
    NativeGamePreview.current?.resume()
    scheduleForegroundServiceStart(250L)
    scheduleDebugDevUrlLoads()
  }

  override fun onWebViewCreate(webView: WebView) {
    android.util.Log.i("BAASStartup", "webview_created uptime=${android.os.SystemClock.uptimeMillis()}")
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(systemBarBackground)
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
    loadDebugDevUrl(webView)
    scheduleDebugDevUrlLoads(webView)
  }

  override fun onPause() {
    NativeGamePreview.current?.pause()
    super.onPause()
  }

  override fun onDestroy() {
    NativeGamePreview.current?.destroy()
    super.onDestroy()
  }

  /** Keeps Android's own bars in the same palette as the selected app theme. */
  fun applySystemBars(backgroundColor: Int, darkIcons: Boolean) {
    systemBarBackground = backgroundColor
    systemBarDarkIcons = darkIcons
    window.statusBarColor = backgroundColor
    window.navigationBarColor = backgroundColor
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.navigationBarDividerColor = backgroundColor
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = darkIcons
      isAppearanceLightNavigationBars = darkIcons
    }
    findWebView(window.decorView)?.setBackgroundColor(backgroundColor)
  }

  private fun handleAppBack() {
    if (backRequestInFlight) return
    val webView = findWebView(window?.decorView)
    if (webView == null) {
      moveTaskToBack(true)
      return
    }
    backRequestInFlight = true
    try {
      // The SPA consumes Back for dialogs, search and page navigation before
      // Android backgrounds the task. Its backend service stays alive.
      webView.evaluateJavascript(
        """(() => {
          try {
            return typeof window.__BAAS_ANDROID_HANDLE_BACK__ === 'function'
              && window.__BAAS_ANDROID_HANDLE_BACK__() === true;
          } catch (error) {
            console.error('Android Back handler failed', error);
            return false;
          }
        })()""".trimIndent(),
      ) { result ->
        backRequestInFlight = false
        if (result != "true" && !isFinishing && !isDestroyed) {
          moveTaskToBack(true)
        }
      }
    } catch (error: RuntimeException) {
      backRequestInFlight = false
      android.util.Log.w("BAAS", "Unable to dispatch Back to the app", error)
      if (!isFinishing && !isDestroyed) moveTaskToBack(true)
    }
  }

  private fun ensureForegroundService() {
    val intent = Intent(this, BaasForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(intent)
    } else {
      startService(intent)
    }
  }

  private fun scheduleForegroundServiceStart(delayMs: Long) {
    if (foregroundServiceStartScheduled) {
      return
    }
    foregroundServiceStartScheduled = true
    val startService = Runnable {
      foregroundServiceStartScheduled = false
      ensureForegroundService()
    }
    val decorView = window?.decorView
    if (decorView == null || !decorView.postDelayed(startService, delayMs)) {
      startService.run()
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
