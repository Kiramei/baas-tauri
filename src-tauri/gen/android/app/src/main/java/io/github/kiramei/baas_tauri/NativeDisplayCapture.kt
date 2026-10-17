package io.github.kiramei.baas_tauri

import android.graphics.Bitmap
import android.view.Surface
import androidx.annotation.Keep

/** One native capture source, shared by GPU preview and on-demand automation screenshots. */
@Keep
object NativeDisplayCapture {
  private var loaded = false

  @Synchronized fun load(path: String? = null) {
    if (loaded) return
    check(android.os.Build.VERSION.SDK_INT >= 26) { "Native game capture requires Android 8 or newer" }
    if (path == null) System.loadLibrary("baas_display_capture") else System.load(path)
    loaded = true
  }

  external fun start(width: Int, height: Int): Surface
  fun stop() { if (loaded) stopNative() }
  private external fun stopNative()
  external fun setPreviewSurface(surface: Surface?)
  external fun captureBitmap(): Bitmap?
  external fun frameCount(): Long
  external fun previewFrameCount(): Long
}
