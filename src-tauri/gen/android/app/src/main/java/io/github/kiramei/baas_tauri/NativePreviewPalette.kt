package io.github.kiramei.baas_tauri

/** Only opaque, validated CSS token colors may cross into the native view. */
internal data class NativePreviewPalette(val background: Int, val foreground: Int, val muted: Int,
  val mutedForeground: Int, val primary: Int, val primaryForeground: Int, val border: Int) {
  companion object {
    val DARK = NativePreviewPalette(0xff282828.toInt(), 0xffdfdfdf.toInt(), 0xff282828.toInt(),
      0xff999999.toInt(), 0xffdfdfdf.toInt(), 0xff181818.toInt(), 0xff373737.toInt())

    fun from(values: (String) -> String?): NativePreviewPalette {
      fun color(key: String, fallback: Int): Int {
        val value = values(key) ?: return fallback
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(value)) return fallback
        return (0xff000000L or value.substring(1).toLong(16)).toInt()
      }
      return NativePreviewPalette(color("background", DARK.background), color("foreground", DARK.foreground),
        color("muted", DARK.muted), color("mutedForeground", DARK.mutedForeground), color("primary", DARK.primary),
        color("primaryForeground", DARK.primaryForeground), color("border", DARK.border))
    }
  }
  fun alpha(color: Int, opacity: Int): Int = (color and 0x00ffffff) or ((opacity.coerceIn(0, 255)) shl 24)
}
