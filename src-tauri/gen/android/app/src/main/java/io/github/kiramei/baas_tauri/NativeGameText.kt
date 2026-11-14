package io.github.kiramei.baas_tauri

import java.util.Locale

internal enum class NativeGameLabel {
  WAITING, BLACK, STILL, LIVE, ERROR, CLOSE_PREVIEW, CLOSE_GAME, TAKE_OVER, RESTART, GAME_MENU, RETURN_PREVIEW, INPUT_PRIORITY
}

/** Native game chrome owns its labels independently of WebView resources. */
internal object NativeGameText {
  internal val languages = listOf("en", "zh", "ja", "ko", "de", "ru", "fr")
  private val labels = mapOf(
    NativeGameLabel.WAITING to listOf(
      "Waiting for frames",
      "等待画面",
      "映像を待機中",
      "화면 대기 중",
      "Warte auf Bilder",
      "Ожидание кадров",
      "En attente d’images"
    ),
    NativeGameLabel.BLACK to listOf(
      "Black screen",
      "黑屏",
      "画面が真っ暗です",
      "검은 화면",
      "Schwarzer Bildschirm",
      "Чёрный экран",
      "Écran noir"
    ),
    NativeGameLabel.STILL to listOf(
      "No frame updates",
      "画面未更新",
      "映像が更新されていません",
      "화면이 갱신되지 않음",
      "Keine neuen Bilder",
      "Кадры не обновляются",
      "Aucune nouvelle image"
    ),
    NativeGameLabel.LIVE to listOf(
      "Live",
      "实时",
      "ライブ",
      "실시간",
      "Live",
      "Прямой эфир",
      "En direct"
    ),
    NativeGameLabel.ERROR to listOf(
      "Preview error",
      "预览异常",
      "プレビューエラー",
      "미리보기 오류",
      "Vorschaufehler",
      "Ошибка предпросмотра",
      "Erreur d’aperçu"
    ),
    NativeGameLabel.CLOSE_PREVIEW to listOf(
      "Close preview",
      "关闭预览",
      "プレビューを閉じる",
      "미리보기 닫기",
      "Vorschau schließen",
      "Закрыть предпросмотр",
      "Fermer l’aperçu"
    ),
    NativeGameLabel.CLOSE_GAME to listOf(
      "Close game",
      "关闭游戏",
      "ゲームを閉じる",
      "게임 닫기",
      "Spiel schließen",
      "Закрыть игру",
      "Fermer le jeu"
    ),
    NativeGameLabel.TAKE_OVER to listOf(
      "Take over game",
      "全屏接管",
      "ゲームを全画面で操作",
      "전체 화면 게임 제어",
      "Spiel im Vollbild steuern",
      "Управлять игрой на весь экран",
      "Contrôler le jeu en plein écran"
    ),
    NativeGameLabel.RESTART to listOf(
      "Restart game",
      "重启游戏",
      "ゲームを再起動",
      "게임 다시 시작",
      "Spiel neu starten",
      "Перезапустить игру",
      "Redémarrer le jeu"
    ),
    NativeGameLabel.GAME_MENU to listOf(
      "Game menu",
      "游戏菜单",
      "ゲームメニュー",
      "게임 메뉴",
      "Spielmenü",
      "Меню игры",
      "Menu du jeu"
    ),
    NativeGameLabel.RETURN_PREVIEW to listOf(
      "Return to preview",
      "返回内嵌画面",
      "プレビューに戻る",
      "미리보기로 돌아가기",
      "Zur Vorschau zurückkehren",
      "Вернуться к предпросмотру",
      "Revenir à l’aperçu"
    ),
    NativeGameLabel.INPUT_PRIORITY to listOf(
      "Scripts keep running; script input takes priority",
      "手动操作不暂停脚本；脚本输入优先",
      "手動操作中もスクリプトは継続し、スクリプトの入力が優先されます",
      "수동 제어 중에도 스크립트는 계속 실행되며 스크립트 입력이 우선합니다",
      "Skripte laufen weiter; Skripteingaben haben Vorrang",
      "Скрипты продолжают работу; их ввод имеет приоритет",
      "Les scripts continuent ; leurs entrées sont prioritaires"
    )
  )

  fun text(language: String?, label: NativeGameLabel): String {
    val normalized = language.orEmpty().trim().substringBefore('-').substringBefore('_').lowercase(Locale.ROOT)
    val index = languages.indexOf(normalized).coerceAtLeast(0)
    return labels.getValue(label)[index]
  }

  /** Action identifiers stay unchanged; only their accessible labels are localized. */
  fun action(language: String?, action: String): String = when (action) {
    "close" -> text(language, NativeGameLabel.CLOSE_GAME)
    "fullscreen" -> text(language, NativeGameLabel.TAKE_OVER)
    "restart" -> text(language, NativeGameLabel.RESTART)
    else -> action
  }
}
