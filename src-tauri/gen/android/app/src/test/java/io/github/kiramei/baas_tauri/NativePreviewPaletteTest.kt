package io.github.kiramei.baas_tauri

import org.junit.Assert.*
import org.junit.Test

class NativePreviewPaletteTest {
  @Test fun usesResolvedNeutralThemeTokensIncludingThePrimaryButton() {
    val colors = mapOf("background" to "#ffffff", "foreground" to "#1a1c1f", "muted" to "#f3f3f3",
      "mutedForeground" to "#6a6b6d", "primary" to "#1a1c1f", "primaryForeground" to "#ffffff", "border" to "#ededed")
    val palette = NativePreviewPalette.from { colors[it] }
    assertEquals(0xffffffff.toInt(), palette.background)
    assertEquals(0xff1a1c1f.toInt(), palette.foreground)
    assertEquals(0xfff3f3f3.toInt(), palette.muted)
    assertEquals(0xff6a6b6d.toInt(), palette.mutedForeground)
    assertEquals(palette.foreground, palette.primary)
    assertEquals(palette.background, palette.primaryForeground)
    assertEquals(0xffededed.toInt(), palette.border)
  }

  @Test fun missingOrUnresolvedTokensNeverParseAsArbitraryNativeColors() {
    for (invalid in listOf("", "red", "#fff", "#11223344", "var(--primary)", "#gggggg")) {
      assertEquals(NativePreviewPalette.DARK, NativePreviewPalette.from { invalid })
    }
    assertEquals(NativePreviewPalette.DARK, NativePreviewPalette.from { null })
  }

  @Test fun overlaysAndRipplesKeepTheThemeHueAndApplyOnlyTheirOpacity() {
    val palette = NativePreviewPalette.DARK
    assertEquals(0x30dfdfdf, palette.alpha(palette.foreground, 48))
    assertEquals(0xff282828.toInt(), palette.alpha(palette.background, 999))
    assertEquals(0x00282828, palette.alpha(palette.background, -1))
  }
}
