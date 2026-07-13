package io.github.kiramei.baas_tauri

object NativeLoader {
  @JvmStatic
  fun load(path: String) {
    System.load(path)
  }
}
