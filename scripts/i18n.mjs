import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const localeDir = path.join(root, "public", "locales");
const srcDir = path.join(root, "src");
const allowlistPath = path.join(root, "scripts", "i18n-allowlist.json");
const typePath = path.join(root, "src", "types", "i18n.ts");
const i18nextTypePath = path.join(root, "src", "types", "i18next.d.ts");
const locales = ["de", "en", "fr", "ja", "ko", "ru", "zh"];
const keyPattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*|\.getting-started)*$/;
const selfKey = "$self";
const namespaceOrder = [
  "app",
  "nav",
  "common",
  "language",
  "log",
  "task",
  "notification",
  "time",
  "settings",
  "update",
  "version",
  "profile",
  "description",
  "installer",
  "auth",
  "wiki",
  "scheduler",
  "stage",
  "cafe",
  "dailySweep",
  "schedule",
  "shop",
  "arena",
  "server",
  "emulator",
  "push",
  "other",
  "drill",
  "artifact",
  "whitelist",
  "script",
  "tactical",
  "team",
  "lesson",
  "sweep",
  "remote",
  "hotkey",
  "property",
  "eventName",
  "shaMethod",
  "shaTest",
  "mirror",
  "mirrorc",
  "contextMenu",
];

const exactMigrations = {
  "add": "common.add",
  "addProfile": "profile.add",
  "appTitle": "app.title",
  "arena.max_refresh_times": "arena.maxRefreshTimes",
  "arena.opponent_no": "arena.opponentNo",
  "artifact.phase_1": "artifact.phase1",
  "artifact.phase_2": "artifact.phase2",
  "artifact.phase_3": "artifact.phase3",
  "Add Student": "student.add",
  "cancel": "common.cancel",
  "choose": "common.choose",
  "chinese": "language.chinese",
  "configuration": "nav.configuration",
  "confirmDeleteMessage": "profile.deleteConfirmMessage",
  "confirmDeleteTitle": "profile.deleteConfirmTitle",
  "confirmUpdateTitle": "update.confirmTitle",
  "createProfile": "profile.create",
  "daysAgo": "time.daysAgo",
  "delete": "common.delete",
  "deutsch": "language.deutsch",
  "drill.out_partyNo": "drill.outPartyNo",
  "edit": "common.edit",
  "editProfile": "profile.edit",
  "english": "language.english",
  "enterCdk": "update.enterCdk",
  "execute": "common.execute",
  "french": "language.french",
  "globalUpdateSettings": "update.settingsTitle",
  "home": "nav.home",
  "hoursAgo": "time.hoursAgo",
  "label.install_dir": "label.installDir",
  "japanese": "language.japanese",
  "korean": "language.korean",
  "installer.subtitle.stage_1": "installer.subtitle.stage1",
  "installer.subtitle.stage_2": "installer.subtitle.stage2",
  "localVersion": "version.local",
  "logs": "log",
  "minutesAgo": "time.minutesAgo",
  "mirrorCdk": "update.mirrorCdk",
  "nextTask": "task.next",
  "noTaskRunning": "task.noneRunning",
  "noTasksQueued": "task.noneQueued",
  "profileName": "profile.name",
  "property.Unused": "property.unused",
  "creditpoints": "property.credits",
  "pyroxene": "property.pyroxene",
  "remoteVersion": "version.remote",
  "runningTask": "task.running",
  "russian": "language.russian",
  "save": "common.save",
  "scheduler": "nav.scheduler",
  "secondsAgo": "time.secondsAgo",
  "settings": "nav.settings",
  "shaConnectivityTest": "update.shaConnectivityTest",
  "start": "common.start",
  "stop": "common.stop",
  "taskOverview": "task.overview",
  "theme": "common.theme",
  "uiSettings": "settings.ui",
  "settingsPage.ui": "settings.ui",
  "home.logs": "log",
  "hotkeys": "hotkey",
  "light": "common.theme.light",
  "dark": "common.theme.dark",
  "system": "common.theme.system",
  "featureSettings": "settings.feature",
  "generalSettings": "settings.general",
  "assetsDisplay.detail": "settings.ui.assets",
  "uisettings.player": "settings.ui.player",
  "uisettings.enableBAComet": "settings.ui.enableBAComet",
  "uisettings.enableSafeStream": "settings.ui.enableSafeStream",
  "cdk.noCDKInput": "mirrorc.cdk.noInput",
  "cdk.testOk": "mirrorc.cdk.testOk",
  "desc.getEmulator": "description.getEmulator",
  "updateChannel": "update.channel",
  "updateMethod": "update.method",
  "updateNotice": "update.notice",
  "updatePrompt": "update.prompt",
  "updates": "common.update",
  "versionInfo": "version.info",
  "Please confirm that you have entered the correct cdkey": "mirrorc.message.confirmCdkey",
  "CDK valid. Expires at {}": "mirrorc.message.validExpires",
  "CDK expired.": "mirrorc.message.expired",
};

const manualTranslations = {
  zh: {
    "adb.noData": "无结果",
    "auth.confirm": "确认",
    "cdk.testOk": "CDK 验证成功",
    "common.create": "创建",
    "common.delete": "删除",
    "common.edit": "编辑",
    "contextMenu.copy": "复制",
    "contextMenu.inspect": "检查",
    "contextMenu.inspectWebuiHint": "请按 F12 打开开发者工具。",
    "contextMenu.paste": "粘贴",
    "contextMenu.pasteFailed": "剪贴板不可用。",
    "contextMenu.reload": "重载",
    "configAdd.saveFailed": "保存失败",
    "desc.getEmulator": "选择模拟器路径",
    "dark": "深色",
    "light": "浅色",
    "system": "跟随系统",
    "arena": "竞技场",
    "arenaDesc": "自动进行竞技场战斗",
    "artifact": "制造",
    "artifactDesc": "制造设置",
    "cafe": "咖啡厅",
    "cafeDesc": "咖啡厅邀请与奖励",
    "dailySweep": "日常",
    "dailySweepDesc": "日常推图与扫荡",
    "drill": "战术测试",
    "drillDesc": "战术测试设置",
    "emulator": "模拟器",
    "emulatorDesc": "模拟器路径与启动项",
    "finalRestrictionRls": "无限制决战",
    "description.finalRestrictionRls": "配置编队方式与通关队伍复制",
    "finalRestrictionRls.formationMethod": "编队方式",
    "finalRestrictionRls.useCurrentFormation": "使用当前编队",
    "finalRestrictionRls.copyClearFormation": "复制通关队伍",
    "finalRestrictionRls.maxUnavailableStudentCount": "最多允许不可用学生数",
    "finalRestrictionRls.maxRefreshCount": "通关队伍最大刷新次数",
    "finalRestrictionRls.copyClearUnavailableHint": "选择“复制通关队伍”后可配置这两个选项。",
    "eventName.startExploreActivityChallenge": "活动挑战",
    "eventName.startExploreActivityMission": "活动任务",
    "eventName.startExploreActivityStory": "活动剧情",
    "eventName.startFhx": "翻花绳",
    "eventName.startGroupStory": "社团剧情",
    "eventName.startHardTask": "困难关卡",
    "eventName.startMainStory": "主线剧情",
    "eventName.startMiniStory": "迷你剧情",
    "eventName.startNormalTask": "普通关卡",
    "eventName.unknown": "未知任务",
    "export.log.folderSelect": "选择日志导出位置",
    "export.log.success": "日志已导出",
    "export.log.successDesc": "日志文件已保存。",
    "friend.filters": "清理条件",
    "friend.levelLimit": "好友等级清理阈值",
    "friend.lastLoginDays": "最后登录天数阈值",
    "friend.lastTotalAssaultRankLimit": "上次总力战排名阈值",
    "friend.disabledThresholdHint": "输入 -1 可禁用对应清理条件。",
    "friend.whitelist": "好友白名单",
    "friend.invalidFormatCN": "国服好友码只能包含数字和小写字母",
    "friend.invalidFormatGlobal": "国际服好友码只能包含大写字母",
    "hotkey.duplicate": "快捷键重复",
    "hotkey.fixInvalid": "请修复无效或重复的快捷键。",
    "hotkey.invalidFormat": "快捷键格式无效",
    "hotkey.leaveEmpty": "留空可取消绑定",
    "hotkey.search": "搜索快捷键",
    "hotkey.usage": "使用组合键，例如",
    "mirrorc.message.confirmCdkey": "请确认您输入了正确的 CDK",
    "mirrorc.message.expired": "CDK 已过期。",
    "mirrorc.message.validExpires": "该 CDK 有效期至 {{expire_date}}。",
    "wiki.web.close": "关闭",
    "wiki.web.detach": "独立窗口",
    "wiki.web.failed": "网页 Wiki 加载失败",
    "wiki.web.loading": "正在加载网页 Wiki...",
    "wiki.web.pin": "浮动显示",
    "wiki.web.return": "回到覆盖模式",
    "wiki.web.title": "网页Wiki",
    "other": "其他",
    "otherDesc": "杂项功能与设置",
    "profile.cannotDeleteLast": "不能删除最后一个配置。",
    "profile.nameExists": "配置名已存在",
    "select.placeholder": "请选择",
    "push": "推送通知",
    "pushDesc": "配置消息推送",
    "schedule": "日程",
    "scheduleDesc": "配置每日日程",
    "script": "脚本设置",
    "scriptDesc": "脚本运行设置",
    "server": "服务器",
    "serverDesc": "游戏服务器与连接",
    "shop": "商店购买",
    "shopDesc": "设置购买优先级",
    "stage": "推图",
    "stageDesc": "自动推图",
    "tactical": "总力战",
    "tacticalDesc": "总力战设置",
    "team": "编队",
    "teamDesc": "设置编队",
    "student.add": "添加学生",
    "toast.dateUpdated": "日期已更新",
    "toast.timeUpdated": "时间已更新",
    "settings.ui.backgroundImage": "背景图",
    "settings.ui.backgroundImageChoose": "选择背景图",
    "settings.ui.backgroundImageEmpty": "未设置背景图",
    "settings.ui.backgroundImageInvalidType": "仅支持 PNG、JPG、JPEG、WEBP 或 GIF 图片。",
    "settings.ui.backgroundImageOpacity": "背景图透明度",
    "settings.ui.backgroundImageReadFailed": "背景图读取失败",
    "settings.ui.backgroundImageRemove": "删除背景图",
    "settings.ui.backgroundImageSelected": "已设置背景图",
    "settings.ui.backgroundImageTooLarge": "背景图不能超过 5MB。",
    "settings.ui.enableSystemNotifications": "启用系统通知",
    "settings.ui.themeColor": "主题色",
    "settings.ui.themeColorInvalid": "请输入 #RRGGBB 格式的主题色。",
    "settings.ui.themeColorReset": "重置主题色",
    "notification.script.startedTitle": "BAAS 任务已开始",
    "notification.script.startedBody": "{{task}} 已开始执行。",
    "notification.script.completedTitle": "BAAS 任务已完成",
    "notification.script.completedBody": "{{task}} 已执行完成。",
    "notification.script.failedTitle": "BAAS 脚本异常退出",
    "notification.script.failedBody": "{{task}} 异常退出，退出码：{{exitCode}}。",
    "update.backendAction": "更新 BAAS",
    "update.backendStarted": "BAAS 更新已开始",
    "update.backendStartFailed": "BAAS 更新启动失败",
    "update.tauriAction": "客户端",
    "update.tauriAvailable": "发现客户端新版本",
    "update.tauriChecking": "正在检查客户端更新...",
    "update.tauriDownloading": "正在下载 {{version}}...",
    "update.tauriFailed": "客户端更新失败",
    "update.tauriInstalling": "正在安装并重启...",
    "update.tauriInstallTitle": "客户端更新",
    "update.tauriUpToDate": "客户端已是最新版本",
    "updateMethod.github": "GitHub",
    "updateMethod.gitee": "Gitee",
    "updateMethod.gitcode": "GitCode",
    "updateMethod.mirrorc": "Mirror酱",
    "version.tapToTest": "检查更新",
    "uisettings.enableBAComet": "启用 BAComet",
    "uisettings.enableSafeStream": "启用安全串流",
    "uisettings.player": "播放器",
    "whitelist": "好友清理",
    "whitelistDesc": "配置清理条件与好友白名单",
  },
  en: {
    "adb.noData": "No results",
    "auth.confirm": "Confirm",
    "cdk.testOk": "CDK OK",
    "common.create": "Create",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "contextMenu.copy": "Copy",
    "contextMenu.inspect": "Inspect",
    "contextMenu.inspectWebuiHint": "Press F12 to open developer tools.",
    "contextMenu.paste": "Paste",
    "contextMenu.pasteFailed": "Clipboard is not available.",
    "contextMenu.reload": "Reload",
    "configAdd.saveFailed": "Save failed",
    "desc.getEmulator": "Select emulator path",
    "dark": "Dark",
    "light": "Light",
    "system": "System",
    "arena": "Arena",
    "arenaDesc": "Arena automation",
    "artifact": "Crafting",
    "artifactDesc": "Crafting settings",
    "cafe": "Cafe",
    "cafeDesc": "Cafe invites and rewards",
    "dailySweep": "Daily",
    "dailySweepDesc": "Daily stages and sweeps",
    "drill": "Joint Drill",
    "drillDesc": "Joint drill settings",
    "emulator": "Emulator",
    "emulatorDesc": "Emulator path and startup",
    "finalRestrictionRls": "Unrestricted Decisive Battle",
    "description.finalRestrictionRls": "Configure formation and clear-team copying",
    "finalRestrictionRls.formationMethod": "Formation method",
    "finalRestrictionRls.useCurrentFormation": "Use current formation",
    "finalRestrictionRls.copyClearFormation": "Copy a clear formation",
    "finalRestrictionRls.maxUnavailableStudentCount": "Maximum unavailable students",
    "finalRestrictionRls.maxRefreshCount": "Maximum clear-team refreshes",
    "finalRestrictionRls.copyClearUnavailableHint":
      "Select “Copy a clear formation” to configure these options.",
    "eventName.startExploreActivityChallenge": "Event Challenge",
    "eventName.startExploreActivityMission": "Event Mission",
    "eventName.startExploreActivityStory": "Event Story",
    "eventName.startFhx": "FHX",
    "eventName.startGroupStory": "Group Story",
    "eventName.startHardTask": "Hard Stage",
    "eventName.startMainStory": "Main Story",
    "eventName.startMiniStory": "Mini Story",
    "eventName.startNormalTask": "Normal Stage",
    "eventName.unknown": "Unknown task",
    "export.log.folderSelect": "Choose log export path",
    "export.log.success": "Logs exported",
    "export.log.successDesc": "Log file saved.",
    "friend.filters": "Cleanup filters",
    "friend.levelLimit": "Friend level threshold",
    "friend.lastLoginDays": "Last-login days threshold",
    "friend.lastTotalAssaultRankLimit": "Previous total-assault rank threshold",
    "friend.disabledThresholdHint": "Enter -1 to disable a cleanup condition.",
    "friend.whitelist": "Friend whitelist",
    "friend.invalidFormatCN": "CN code needs numbers and lowercase letters",
    "friend.invalidFormatGlobal": "Global code needs uppercase letters",
    "hotkey.duplicate": "Duplicate hotkey",
    "hotkey.fixInvalid": "Fix invalid or duplicate hotkeys.",
    "hotkey.invalidFormat": "Invalid hotkey",
    "hotkey.leaveEmpty": "Leave empty to unbind",
    "hotkey.search": "Search hotkeys",
    "hotkey.usage": "Use combinations like",
    "mirrorc.message.confirmCdkey": "Check your CDK.",
    "mirrorc.message.expired": "CDK expired.",
    "mirrorc.message.validExpires": "CDK valid until {{expire_date}}.",
    "wiki.web.close": "Close",
    "wiki.web.detach": "Detach",
    "wiki.web.failed": "Web Wiki failed to load",
    "wiki.web.loading": "Loading Web Wiki...",
    "wiki.web.pin": "Float",
    "wiki.web.return": "Return",
    "wiki.web.title": "Web Wiki",
    "other": "Other",
    "otherDesc": "Misc settings",
    "profile.cannotDeleteLast": "Cannot delete the last profile.",
    "profile.nameExists": "Name already exists",
    "select.placeholder": "Select",
    "push": "Push",
    "pushDesc": "Push settings",
    "schedule": "Schedule",
    "scheduleDesc": "Daily schedule",
    "script": "Scripts",
    "scriptDesc": "Script settings",
    "server": "Server",
    "serverDesc": "Server and connection",
    "shop": "Shop",
    "shopDesc": "Purchase priorities",
    "stage": "Stages",
    "stageDesc": "Auto stage clearing",
    "tactical": "Total Assault",
    "tacticalDesc": "Total Assault settings",
    "team": "Formation",
    "teamDesc": "Formation settings",
    "student.add": "Add Student",
    "toast.dateUpdated": "Date updated",
    "toast.timeUpdated": "Time updated",
    "settings.ui.backgroundImage": "Background image",
    "settings.ui.backgroundImageChoose": "Choose background",
    "settings.ui.backgroundImageEmpty": "No background image set",
    "settings.ui.backgroundImageInvalidType":
      "Only PNG, JPG, JPEG, WEBP, or GIF images are supported.",
    "settings.ui.backgroundImageOpacity": "Background opacity",
    "settings.ui.backgroundImageReadFailed": "Failed to read background image",
    "settings.ui.backgroundImageRemove": "Remove background",
    "settings.ui.backgroundImageSelected": "Background image set",
    "settings.ui.backgroundImageTooLarge": "Background image must be 5MB or smaller.",
    "settings.ui.enableSystemNotifications": "Enable system notifications",
    "settings.ui.themeColor": "Theme color",
    "settings.ui.themeColorInvalid": "Enter a theme color in #RRGGBB format.",
    "settings.ui.themeColorReset": "Reset color",
    "notification.script.startedTitle": "BAAS task started",
    "notification.script.startedBody": "{{task}} has started.",
    "notification.script.completedTitle": "BAAS task completed",
    "notification.script.completedBody": "{{task}} completed.",
    "notification.script.failedTitle": "BAAS script exited abnormally",
    "notification.script.failedBody": "{{task}} exited abnormally. Exit code: {{exitCode}}.",
    "update.backendAction": "Update BAAS",
    "update.backendStarted": "BAAS update started",
    "update.backendStartFailed": "Failed to start BAAS update",
    "update.tauriAction": "Client",
    "update.tauriAvailable": "Client update available",
    "update.tauriChecking": "Checking for client update...",
    "update.tauriDownloading": "Downloading {{version}}...",
    "update.tauriFailed": "Client update failed",
    "update.tauriInstalling": "Installing and restarting...",
    "update.tauriInstallTitle": "Client update",
    "update.tauriUpToDate": "Client is already up to date",
    "updateMethod.github": "GitHub",
    "updateMethod.gitee": "Gitee",
    "updateMethod.gitcode": "GitCode",
    "updateMethod.mirrorc": "MirrorC",
    "version.tapToTest": "Check for updates",
    "uisettings.enableBAComet": "Enable BAComet",
    "uisettings.enableSafeStream": "Enable safe stream",
    "uisettings.player": "Player",
    "whitelist": "Friend cleanup",
    "whitelistDesc": "Configure cleanup filters and friend whitelist",
  },
};

for (const lang of ["de", "fr", "ja", "ko", "ru"]) {
  manualTranslations[lang] = { ...manualTranslations.en };
}

Object.assign(manualTranslations.de, {
  "contextMenu.copy": "Kopieren",
  "contextMenu.inspect": "Pruefen",
  "contextMenu.inspectWebuiHint": "F12 druecken, um Entwicklertools zu oeffnen.",
  "contextMenu.paste": "Einfuegen",
  "contextMenu.pasteFailed": "Zwischenablage ist nicht verfuegbar.",
  "contextMenu.reload": "Neu laden",
  "friend.filters": "Bereinigungsfilter",
  "friend.levelLimit": "Schwellenwert für Freundeslevel",
  "friend.lastLoginDays": "Schwellenwert seit letzter Anmeldung",
  "friend.lastTotalAssaultRankLimit": "Schwellenwert des letzten Gesamtangriffsrangs",
  "friend.disabledThresholdHint": "Mit -1 wird der jeweilige Filter deaktiviert.",
  "friend.whitelist": "Freundes-Whitelist",
  "finalRestrictionRls": "Entscheidungskampf ohne Beschränkung",
  "description.finalRestrictionRls": "Formation und Kopieren erfolgreicher Teams konfigurieren",
  "finalRestrictionRls.formationMethod": "Formationsmethode",
  "finalRestrictionRls.useCurrentFormation": "Aktuelle Formation verwenden",
  "finalRestrictionRls.copyClearFormation": "Erfolgreiches Team kopieren",
  "finalRestrictionRls.maxUnavailableStudentCount": "Maximal nicht verfügbare Schüler",
  "finalRestrictionRls.maxRefreshCount": "Maximale Aktualisierungen erfolgreicher Teams",
  "finalRestrictionRls.copyClearUnavailableHint":
    "Wähle „Erfolgreiches Team kopieren“, um diese Optionen zu konfigurieren.",
  "settings.ui.backgroundImage": "Hintergrundbild",
  "settings.ui.backgroundImageChoose": "Hintergrund auswaehlen",
  "settings.ui.backgroundImageEmpty": "Kein Hintergrundbild festgelegt",
  "settings.ui.backgroundImageInvalidType":
    "Es werden nur PNG-, JPG-, JPEG-, WEBP- oder GIF-Bilder unterstuetzt.",
  "settings.ui.backgroundImageOpacity": "Hintergrundtransparenz",
  "settings.ui.backgroundImageReadFailed": "Hintergrundbild konnte nicht gelesen werden",
  "settings.ui.backgroundImageRemove": "Hintergrund entfernen",
  "settings.ui.backgroundImageSelected": "Hintergrundbild festgelegt",
  "settings.ui.backgroundImageTooLarge": "Das Hintergrundbild darf hoechstens 5 MB gross sein.",
  "settings.ui.enableSystemNotifications": "Systembenachrichtigungen aktivieren",
  "settings.ui.lowPerformanceMode": "Leistungsarmer Modus",
  "settings.ui.themeColor": "Designfarbe",
  "settings.ui.themeColorInvalid": "Geben Sie eine Designfarbe im Format #RRGGBB ein.",
  "settings.ui.themeColorReset": "Designfarbe zuruecksetzen",
  "notification.script.startedTitle": "BAAS-Aufgabe gestartet",
  "notification.script.startedBody": "{{task}} wurde gestartet.",
  "notification.script.completedTitle": "BAAS-Aufgabe abgeschlossen",
  "notification.script.completedBody": "{{task}} wurde abgeschlossen.",
  "notification.script.failedTitle": "BAAS-Skript wurde unerwartet beendet",
  "notification.script.failedBody": "{{task}} wurde unerwartet beendet. Exit-Code: {{exitCode}}.",
  "update.backendAction": "BAAS aktualisieren",
  "update.backendStarted": "BAAS-Aktualisierung gestartet",
  "update.backendStartFailed": "BAAS-Aktualisierung konnte nicht gestartet werden",
  "wiki.web.close": "Schliessen",
  "wiki.web.detach": "Abtrennen",
  "wiki.web.detachedDescription": "Das Web-Wiki ist in einem eigenen Fenster geoeffnet.",
  "wiki.web.detachedTitle": "Web-Wiki getrennt",
  "wiki.web.failed": "Web-Wiki konnte nicht laden",
  "wiki.web.focusDetached": "Fenster fokussieren",
  "wiki.web.loading": "Web-Wiki wird geladen...",
  "wiki.web.openExternal": "Im Browser oeffnen",
  "wiki.web.pin": "Schweben",
  "wiki.web.return": "Zurueck",
  "wiki.web.title": "Web-Wiki",
  "whitelist": "Freunde bereinigen",
  "whitelistDesc": "Filter und Freundes-Whitelist konfigurieren",
});

Object.assign(manualTranslations.fr, {
  "contextMenu.copy": "Copier",
  "contextMenu.inspect": "Inspecter",
  "contextMenu.inspectWebuiHint": "Appuyez sur F12 pour ouvrir les outils dev.",
  "contextMenu.paste": "Coller",
  "contextMenu.pasteFailed": "Le presse-papiers n'est pas disponible.",
  "contextMenu.reload": "Recharger",
  "friend.filters": "Filtres de nettoyage",
  "friend.levelLimit": "Seuil de niveau des amis",
  "friend.lastLoginDays": "Seuil de jours depuis la dernière connexion",
  "friend.lastTotalAssaultRankLimit": "Seuil du classement du dernier assaut total",
  "friend.disabledThresholdHint": "Saisissez -1 pour désactiver un filtre.",
  "friend.whitelist": "Liste blanche des amis",
  "finalRestrictionRls": "Combat décisif sans restriction",
  "description.finalRestrictionRls": "Configurer la formation et la copie des équipes victorieuses",
  "finalRestrictionRls.formationMethod": "Méthode de formation",
  "finalRestrictionRls.useCurrentFormation": "Utiliser la formation actuelle",
  "finalRestrictionRls.copyClearFormation": "Copier une équipe victorieuse",
  "finalRestrictionRls.maxUnavailableStudentCount": "Nombre maximal d'élèves indisponibles",
  "finalRestrictionRls.maxRefreshCount": "Actualisations maximales des équipes victorieuses",
  "finalRestrictionRls.copyClearUnavailableHint":
    "Sélectionnez « Copier une équipe victorieuse » pour configurer ces options.",
  "settings.ui.backgroundImage": "Image d'arriere-plan",
  "settings.ui.backgroundImageChoose": "Choisir un arriere-plan",
  "settings.ui.backgroundImageEmpty": "Aucune image d'arriere-plan definie",
  "settings.ui.backgroundImageInvalidType":
    "Seules les images PNG, JPG, JPEG, WEBP ou GIF sont prises en charge.",
  "settings.ui.backgroundImageOpacity": "Opacite de l'arriere-plan",
  "settings.ui.backgroundImageReadFailed": "Echec de la lecture de l'image d'arriere-plan",
  "settings.ui.backgroundImageRemove": "Supprimer l'arriere-plan",
  "settings.ui.backgroundImageSelected": "Image d'arriere-plan definie",
  "settings.ui.backgroundImageTooLarge": "L'image d'arriere-plan doit faire 5 Mo ou moins.",
  "settings.ui.enableSystemNotifications": "Activer les notifications systeme",
  "settings.ui.lowPerformanceMode": "Mode basse performance",
  "settings.ui.themeColor": "Couleur du theme",
  "settings.ui.themeColorInvalid": "Saisissez une couleur de theme au format #RRGGBB.",
  "settings.ui.themeColorReset": "Reinitialiser la couleur du theme",
  "notification.script.startedTitle": "Tache BAAS demarree",
  "notification.script.startedBody": "{{task}} a demarre.",
  "notification.script.completedTitle": "Tache BAAS terminee",
  "notification.script.completedBody": "{{task}} est terminee.",
  "notification.script.failedTitle": "Script BAAS quitte anormalement",
  "notification.script.failedBody":
    "{{task}} s'est arrete anormalement. Code de sortie : {{exitCode}}.",
  "update.backendAction": "Mettre a jour BAAS",
  "update.backendStarted": "Mise a jour BAAS demarree",
  "update.backendStartFailed": "Echec du demarrage de la mise a jour BAAS",
  "wiki.web.close": "Fermer",
  "wiki.web.detach": "Detacher",
  "wiki.web.detachedDescription": "Le Wiki web est ouvert dans une fenetre separee.",
  "wiki.web.detachedTitle": "Wiki web detache",
  "wiki.web.failed": "Echec du chargement du Wiki web",
  "wiki.web.focusDetached": "Afficher la fenetre",
  "wiki.web.loading": "Chargement du Wiki web...",
  "wiki.web.openExternal": "Ouvrir dans le navigateur",
  "wiki.web.pin": "Flottant",
  "wiki.web.return": "Retour",
  "wiki.web.title": "Wiki web",
  "whitelist": "Nettoyage des amis",
  "whitelistDesc": "Configurer les filtres et la liste blanche",
});

Object.assign(manualTranslations.ja, {
  "contextMenu.copy": "コピー",
  "contextMenu.inspect": "検査",
  "contextMenu.inspectWebuiHint": "F12で開発者ツールを開きます。",
  "contextMenu.paste": "貼り付け",
  "contextMenu.pasteFailed": "クリップボードを使用できません。",
  "contextMenu.reload": "再読み込み",
  "friend.filters": "整理条件",
  "friend.levelLimit": "フレンドレベルしきい値",
  "friend.lastLoginDays": "最終ログイン日数しきい値",
  "friend.lastTotalAssaultRankLimit": "前回総力戦順位しきい値",
  "friend.disabledThresholdHint": "-1 を入力すると条件を無効にできます。",
  "friend.whitelist": "フレンド白リスト",
  "finalRestrictionRls": "制限解除決戦",
  "description.finalRestrictionRls": "編成方法とクリア編成のコピーを設定",
  "finalRestrictionRls.formationMethod": "編成方法",
  "finalRestrictionRls.useCurrentFormation": "現在の編成を使用",
  "finalRestrictionRls.copyClearFormation": "クリア編成をコピー",
  "finalRestrictionRls.maxUnavailableStudentCount": "使用不可生徒の最大数",
  "finalRestrictionRls.maxRefreshCount": "クリア編成の最大更新回数",
  "finalRestrictionRls.copyClearUnavailableHint": "「クリア編成をコピー」を選ぶと設定できます。",
  "settings.ui.backgroundImage": "背景画像",
  "settings.ui.backgroundImageChoose": "背景を選択",
  "settings.ui.backgroundImageEmpty": "背景画像が設定されていません",
  "settings.ui.backgroundImageInvalidType": "PNG、JPG、JPEG、WEBP、GIF 画像のみ対応しています。",
  "settings.ui.backgroundImageOpacity": "背景の不透明度",
  "settings.ui.backgroundImageReadFailed": "背景画像の読み込みに失敗しました",
  "settings.ui.backgroundImageRemove": "背景を削除",
  "settings.ui.backgroundImageSelected": "背景画像を設定しました",
  "settings.ui.backgroundImageTooLarge": "背景画像は 5MB 以下にしてください。",
  "settings.ui.enableSystemNotifications": "システム通知を有効化",
  "settings.ui.lowPerformanceMode": "低パフォーマンスモード",
  "settings.ui.themeColor": "テーマカラー",
  "settings.ui.themeColorInvalid": "#RRGGBB 形式でテーマカラーを入力してください。",
  "settings.ui.themeColorReset": "テーマカラーをリセット",
  "notification.script.startedTitle": "BAAS タスク開始",
  "notification.script.startedBody": "{{task}} を開始しました。",
  "notification.script.completedTitle": "BAAS タスク完了",
  "notification.script.completedBody": "{{task}} が完了しました。",
  "notification.script.failedTitle": "BAAS スクリプトが異常終了しました",
  "notification.script.failedBody": "{{task}} が異常終了しました。終了コード: {{exitCode}}。",
  "update.backendAction": "BAAS を更新",
  "update.backendStarted": "BAAS の更新を開始しました",
  "update.backendStartFailed": "BAAS の更新を開始できませんでした",
  "wiki.web.close": "閉じる",
  "wiki.web.detach": "別ウィンドウ",
  "wiki.web.detachedDescription": "Web Wiki は別ウィンドウで開いています。",
  "wiki.web.detachedTitle": "Web Wiki を分離",
  "wiki.web.failed": "Web Wikiの読み込みに失敗",
  "wiki.web.focusDetached": "ウィンドウを表示",
  "wiki.web.loading": "Web Wikiを読み込み中...",
  "wiki.web.openExternal": "外部で開く",
  "wiki.web.pin": "フロート",
  "wiki.web.return": "戻る",
  "wiki.web.title": "Web Wiki",
  "whitelist": "フレンド整理",
  "whitelistDesc": "整理条件とフレンド白リストを設定",
});

Object.assign(manualTranslations.ko, {
  "contextMenu.copy": "복사",
  "contextMenu.inspect": "검사",
  "contextMenu.inspectWebuiHint": "F12로 개발자 도구를 여세요.",
  "contextMenu.paste": "붙여넣기",
  "contextMenu.pasteFailed": "클립보드를 사용할 수 없습니다.",
  "contextMenu.reload": "새로고침",
  "friend.filters": "정리 조건",
  "friend.levelLimit": "친구 레벨 임계값",
  "friend.lastLoginDays": "마지막 로그인 일수 임계값",
  "friend.lastTotalAssaultRankLimit": "이전 총력전 순위 임계값",
  "friend.disabledThresholdHint": "-1을 입력하면 해당 조건이 비활성화됩니다.",
  "friend.whitelist": "친구 화이트리스트",
  "finalRestrictionRls": "제한 해제 결전",
  "description.finalRestrictionRls": "편성 방식과 클리어 편성 복사를 설정",
  "finalRestrictionRls.formationMethod": "편성 방식",
  "finalRestrictionRls.useCurrentFormation": "현재 편성 사용",
  "finalRestrictionRls.copyClearFormation": "클리어 편성 복사",
  "finalRestrictionRls.maxUnavailableStudentCount": "사용 불가 학생 최대 수",
  "finalRestrictionRls.maxRefreshCount": "클리어 편성 최대 새로고침 횟수",
  "finalRestrictionRls.copyClearUnavailableHint":
    "“클리어 편성 복사”를 선택하면 설정할 수 있습니다.",
  "settings.ui.backgroundImage": "배경 이미지",
  "settings.ui.backgroundImageChoose": "배경 선택",
  "settings.ui.backgroundImageEmpty": "설정된 배경 이미지 없음",
  "settings.ui.backgroundImageInvalidType": "PNG, JPG, JPEG, WEBP 또는 GIF 이미지만 지원합니다.",
  "settings.ui.backgroundImageOpacity": "배경 투명도",
  "settings.ui.backgroundImageReadFailed": "배경 이미지를 읽지 못했습니다",
  "settings.ui.backgroundImageRemove": "배경 제거",
  "settings.ui.backgroundImageSelected": "배경 이미지가 설정되었습니다",
  "settings.ui.backgroundImageTooLarge": "배경 이미지는 5MB 이하여야 합니다.",
  "settings.ui.enableSystemNotifications": "시스템 알림 활성화",
  "settings.ui.lowPerformanceMode": "저성능 모드",
  "settings.ui.themeColor": "테마 색상",
  "settings.ui.themeColorInvalid": "#RRGGBB 형식의 테마 색상을 입력하세요.",
  "settings.ui.themeColorReset": "테마 색상 초기화",
  "notification.script.startedTitle": "BAAS 작업 시작됨",
  "notification.script.startedBody": "{{task}} 작업을 시작했습니다.",
  "notification.script.completedTitle": "BAAS 작업 완료됨",
  "notification.script.completedBody": "{{task}} 작업이 완료되었습니다.",
  "notification.script.failedTitle": "BAAS 스크립트 비정상 종료",
  "notification.script.failedBody":
    "{{task}} 작업이 비정상 종료되었습니다. 종료 코드: {{exitCode}}.",
  "update.backendAction": "BAAS 업데이트",
  "update.backendStarted": "BAAS 업데이트를 시작했습니다",
  "update.backendStartFailed": "BAAS 업데이트를 시작하지 못했습니다",
  "wiki.web.close": "닫기",
  "wiki.web.detach": "분리",
  "wiki.web.detachedDescription": "웹 Wiki가 별도 창에서 열려 있습니다.",
  "wiki.web.detachedTitle": "웹 Wiki 분리됨",
  "wiki.web.failed": "웹 Wiki 로드 실패",
  "wiki.web.focusDetached": "창으로 이동",
  "wiki.web.loading": "웹 Wiki 로드 중...",
  "wiki.web.openExternal": "외부에서 열기",
  "wiki.web.pin": "플로팅",
  "wiki.web.return": "돌아가기",
  "wiki.web.title": "웹 Wiki",
  "whitelist": "친구 정리",
  "whitelistDesc": "정리 조건과 친구 화이트리스트 설정",
});

Object.assign(manualTranslations.ru, {
  "contextMenu.copy": "Копировать",
  "contextMenu.inspect": "Проверить",
  "contextMenu.inspectWebuiHint": "Нажмите F12, чтобы открыть DevTools.",
  "contextMenu.paste": "Вставить",
  "contextMenu.pasteFailed": "Буфер обмена недоступен.",
  "contextMenu.reload": "Обновить",
  "friend.filters": "Фильтры очистки",
  "friend.levelLimit": "Порог уровня друга",
  "friend.lastLoginDays": "Порог дней с последнего входа",
  "friend.lastTotalAssaultRankLimit": "Порог места в прошлом тотальном штурме",
  "friend.disabledThresholdHint": "Введите -1, чтобы отключить соответствующее условие.",
  "friend.whitelist": "Белый список друзей",
  "finalRestrictionRls": "Решающий бой без ограничений",
  "description.finalRestrictionRls": "Настройка построения и копирования прошедших команд",
  "finalRestrictionRls.formationMethod": "Способ построения",
  "finalRestrictionRls.useCurrentFormation": "Использовать текущую команду",
  "finalRestrictionRls.copyClearFormation": "Копировать прошедшую команду",
  "finalRestrictionRls.maxUnavailableStudentCount": "Максимум недоступных учениц",
  "finalRestrictionRls.maxRefreshCount": "Максимум обновлений прошедших команд",
  "finalRestrictionRls.copyClearUnavailableHint":
    "Выберите «Копировать прошедшую команду», чтобы настроить эти параметры.",
  "settings.ui.backgroundImage": "Фоновое изображение",
  "settings.ui.backgroundImageChoose": "Выбрать фон",
  "settings.ui.backgroundImageEmpty": "Фоновое изображение не задано",
  "settings.ui.backgroundImageInvalidType":
    "Поддерживаются только изображения PNG, JPG, JPEG, WEBP или GIF.",
  "settings.ui.backgroundImageOpacity": "Прозрачность фона",
  "settings.ui.backgroundImageReadFailed": "Не удалось прочитать фоновое изображение",
  "settings.ui.backgroundImageRemove": "Удалить фон",
  "settings.ui.backgroundImageSelected": "Фоновое изображение задано",
  "settings.ui.backgroundImageTooLarge": "Размер фонового изображения не должен превышать 5 МБ.",
  "settings.ui.enableSystemNotifications": "Включить системные уведомления",
  "settings.ui.lowPerformanceMode": "Режим низкой производительности",
  "settings.ui.themeColor": "Цвет темы",
  "settings.ui.themeColorInvalid": "Введите цвет темы в формате #RRGGBB.",
  "settings.ui.themeColorReset": "Сбросить цвет темы",
  "notification.script.startedTitle": "Задача BAAS запущена",
  "notification.script.startedBody": "{{task}} запущена.",
  "notification.script.completedTitle": "Задача BAAS завершена",
  "notification.script.completedBody": "{{task}} завершена.",
  "notification.script.failedTitle": "Скрипт BAAS завершился аварийно",
  "notification.script.failedBody": "{{task}} завершилась аварийно. Код выхода: {{exitCode}}.",
  "update.backendAction": "Обновить BAAS",
  "update.backendStarted": "Обновление BAAS запущено",
  "update.backendStartFailed": "Не удалось запустить обновление BAAS",
  "wiki.web.close": "Закрыть",
  "wiki.web.detach": "Отделить",
  "wiki.web.detachedDescription": "Web Wiki открыта в отдельном окне.",
  "wiki.web.detachedTitle": "Web Wiki отделена",
  "wiki.web.failed": "Не удалось загрузить Web Wiki",
  "wiki.web.focusDetached": "Перейти к окну",
  "wiki.web.loading": "Загрузка Web Wiki...",
  "wiki.web.openExternal": "Открыть во внешнем окне",
  "wiki.web.pin": "Плавающая",
  "wiki.web.return": "Назад",
  "wiki.web.title": "Web Wiki",
  "whitelist": "Очистка друзей",
  "whitelistDesc": "Настройка фильтров и белого списка друзей",
});

function flatten(value, prefix = "", output = {}) {
  for (const [key, child] of Object.entries(value)) {
    if (key === selfKey) {
      if (!prefix) {
        throw new Error(`${selfKey} cannot appear at locale root`);
      }
      output[prefix] = String(child);
      continue;
    }
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, nextKey, output);
    } else {
      output[nextKey] = String(child);
    }
  }
  return output;
}

function assignNested(target, key, value) {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const existing = node[part];
    if (typeof existing === "string") {
      node[part] = { [selfKey]: existing };
    } else if (!existing) {
      node[part] = {};
    }
    node = node[part];
  }

  const leaf = parts.at(-1);
  const existing = node[leaf];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    existing[selfKey] = value;
  } else {
    node[leaf] = value;
  }
}

function unflatten(flat) {
  const nested = {};
  for (const [key, value] of Object.entries(flat)) {
    assignNested(nested, key, value);
  }
  return nested;
}

function snakeToCamel(value) {
  return value.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function migrateKey(key) {
  if (exactMigrations[key]) return exactMigrations[key];
  if (key.startsWith("desc.")) {
    return `description.${key.slice("desc.".length)}`;
  }
  if (key.endsWith("Desc")) {
    return `description.${key.slice(0, -"Desc".length)}`;
  }
  if (key.startsWith("eventName.")) {
    return `eventName.${snakeToCamel(key.slice("eventName.".length))}`;
  }
  return key;
}

function loadLocales() {
  const loaded = {};
  for (const locale of locales) {
    const file = path.join(localeDir, `${locale}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const flat = flatten(parsed);
    const migrated = {};
    for (const [key, value] of Object.entries(flat)) {
      migrated[migrateKey(key)] = value;
    }
    loaded[locale] = migrated;
  }
  return loaded;
}

function walkSource(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      walkSource(file, files);
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(file);
    }
  }
  return files;
}

function readAllowlist() {
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

function extractUsedKeys(allowlist) {
  const staticKeys = new Set();
  const badKeys = [];
  const disallowedDynamic = [];
  const sourceFiles = walkSource(srcDir);
  const staticRegex = /\b(?:t|translator)\(\s*([`'"])(.*?)\1/gms;
  const callRegex = /\b(?:t|translator)\(\s*([^)\n]+)/gms;
  const fallbackRegex = /\b(?:t|translator)\([^)]*\)\s*\|\|\s*([`'"])(.*?)\1/gms;
  const dynamicFunctionPattern = new RegExp(
    `^(${allowlist.allowedDynamicFunctions.join("|")})\\s*\\(`
  );

  for (const file of sourceFiles) {
    const rel = path.relative(root, file).replaceAll(path.sep, "/");
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(staticRegex)) {
      const original = match[2];
      if (original.includes("${")) {
        badKeys.push(`${rel}: template literal key '${original}' must use a typed helper`);
        continue;
      }
      const migrated = migrateKey(original);
      staticKeys.add(migrated);
      if (migrated !== original || !keyPattern.test(migrated)) {
        badKeys.push(`${rel}: invalid key '${original}', expected '${migrated}'`);
      }
    }

    for (const match of text.matchAll(callRegex)) {
      const expression = match[1].trim();
      if (/^[`'"]/.test(expression)) continue;
      if (!dynamicFunctionPattern.test(expression)) {
        disallowedDynamic.push(`${rel}: t(${expression})`);
      }
    }

    for (const match of text.matchAll(fallbackRegex)) {
      badKeys.push(`${rel}: translation fallback '${match[2]}' must be a locale key`);
    }
  }

  for (const key of allowlist.dynamicKeys) {
    staticKeys.add(key);
  }
  return { usedKeys: [...staticKeys].sort(compareKeys), badKeys, disallowedDynamic };
}

function namespaceRank(key) {
  const namespace = key.split(".")[0];
  const rank = namespaceOrder.indexOf(namespace);
  return rank === -1 ? namespaceOrder.length : rank;
}

function compareKeys(a, b) {
  const rankDiff = namespaceRank(a) - namespaceRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.localeCompare(b);
}

function translationFor(localesByLang, lang, key) {
  const value = localesByLang[lang][key];
  const langManual = manualTranslations[lang]?.[key];
  const englishManual = manualTranslations.en[key];
  const englishValue = localesByLang.en[key] ?? englishManual;
  const hasLocalizedManual =
    lang !== "en" && langManual !== undefined && langManual !== englishManual;

  if (hasLocalizedManual && (value === undefined || value === key || value === englishValue)) {
    return langManual;
  }

  return (
    (value === key ? undefined : value) ??
    langManual ??
    englishManual ??
    localesByLang.zh[key] ??
    key
  );
}

function writeLocales(localesByLang, usedKeys) {
  for (const lang of locales) {
    const flat = {};
    for (const key of usedKeys) {
      flat[key] = translationFor(localesByLang, lang, key);
    }
    const next = unflatten(flat);
    fs.writeFileSync(path.join(localeDir, `${lang}.json`), `${JSON.stringify(next, null, 2)}\n`);
  }
}

function writeTypes(usedKeys) {
  const union = usedKeys.map((key) => `  | ${JSON.stringify(key)}`).join("\n");
  fs.writeFileSync(
    typePath,
    `/* This file is generated by scripts/i18n.mjs. */\nexport type TranslationKey =\n${union};\n\nexport type TranslationResource = Record<TranslationKey, string>;\n`
  );
  fs.writeFileSync(
    i18nextTypePath,
    `/* This file is generated by scripts/i18n.mjs. */\nimport \"i18next\";\nimport type { TranslationResource } from \"./i18n\";\n\ndeclare module \"i18next\" {\n  interface CustomTypeOptions {\n    defaultNS: \"translation\";\n    keySeparator: false;\n    returnNull: false;\n    resources: {\n      translation: TranslationResource;\n    };\n  }\n}\n`
  );
}

function check(localesByLang, usedKeys, badKeys, disallowedDynamic) {
  const errors = [];
  const expected = new Set(usedKeys);

  for (const key of usedKeys) {
    if (!keyPattern.test(key)) {
      errors.push(`Bad key name: ${key}`);
    }
  }

  for (const lang of locales) {
    const keys = Object.keys(localesByLang[lang]).sort();
    const actual = new Set(keys);
    const missing = usedKeys.filter((key) => !actual.has(key));
    const extra = keys.filter((key) => !expected.has(key));
    if (missing.length) errors.push(`${lang} missing: ${missing.join(", ")}`);
    if (extra.length) errors.push(`${lang} extra: ${extra.join(", ")}`);
    for (const key of keys) {
      const value = localesByLang[lang][key];
      if (value === "" || value == null) {
        errors.push(`${lang}.${key} is empty`);
      }
      if (value === key) {
        errors.push(`${lang}.${key} still uses the key as placeholder text`);
      }
    }
  }

  errors.push(...badKeys, ...disallowedDynamic);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`i18n check passed: ${usedKeys.length} keys across ${locales.length} locales`);
  }
}

const command = process.argv[2] ?? "check";
const allowlist = readAllowlist();
const localesByLang = loadLocales();
const { usedKeys, badKeys, disallowedDynamic } = extractUsedKeys(allowlist);

if (command === "sync") {
  writeLocales(localesByLang, usedKeys);
  writeTypes(usedKeys);
  console.log(`i18n synced: ${usedKeys.length} keys`);
} else if (command === "check") {
  check(localesByLang, usedKeys, badKeys, disallowedDynamic);
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
