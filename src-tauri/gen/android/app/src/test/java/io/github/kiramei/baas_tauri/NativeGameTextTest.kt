package io.github.kiramei.baas_tauri

import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

class NativeGameTextTest {
  @Test fun everyNativeGameLabelHasEverySupportedTranslation() {
    assertEquals(setOf("en", "zh", "ja", "ko", "de", "ru", "fr"), NativeGameText.languages.toSet())
    for (label in NativeGameLabel.values()) {
      for (language in NativeGameText.languages) {
        val text = NativeGameText.text(language, label)
        assertTrue("$language/$label must have text", text.isNotBlank())
        if (language != "en" && !(language == "de" && label == NativeGameLabel.LIVE)) {
          assertNotEquals("$language/$label must not fall back to English", NativeGameText.text("en", label), text)
        }
      }
    }
    assertEquals("返回内嵌画面", NativeGameText.text("zh", NativeGameLabel.RETURN_PREVIEW))
    assertEquals("Schwarzer Bildschirm", NativeGameText.text("de", NativeGameLabel.BLACK))
    assertEquals("Fermer le jeu", NativeGameText.text("fr", NativeGameLabel.CLOSE_GAME))
  }

  @Test fun localeTagsNormalizeAndUnknownLanguagesUseEnglish() {
    val previous = Locale.getDefault()
    try {
      Locale.setDefault(Locale("tr", "TR"))
      for ((tag, language) in listOf("ZH_hans_CN" to "zh", " fr-CA " to "fr", "JA_jp" to "ja", "ko-KR" to "ko", "RU_ru" to "ru")) {
        for (label in NativeGameLabel.values()) assertEquals(NativeGameText.text(language, label), NativeGameText.text(tag, label))
      }
      for (tag in listOf(null, "", "unsupported"))
        for (label in NativeGameLabel.values()) assertEquals(NativeGameText.text("en", label), NativeGameText.text(tag, label))
    } finally { Locale.setDefault(previous) }
  }

  @Test fun accessibleActionsKeepTheBridgeIdentifiersSeparateFromLabels() {
    for (language in NativeGameText.languages) {
      assertEquals(NativeGameText.text(language, NativeGameLabel.CLOSE_GAME), NativeGameText.action(language, "close"))
      assertEquals(NativeGameText.text(language, NativeGameLabel.TAKE_OVER), NativeGameText.action(language, "fullscreen"))
      assertEquals(NativeGameText.text(language, NativeGameLabel.RESTART), NativeGameText.action(language, "restart"))
      assertEquals("future-action", NativeGameText.action(language, "future-action"))
    }
  }
}
