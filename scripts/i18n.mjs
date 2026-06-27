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
    "settings.ui.themeColor": "主题色",
    "settings.ui.themeColorInvalid": "请输入 #RRGGBB 格式的主题色。",
    "settings.ui.themeColorReset": "重置主题色",
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
    "whitelist": "好友白名单",
    "whitelistDesc": "自动删好友白名单",
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
    "settings.ui.themeColor": "Theme color",
    "settings.ui.themeColorInvalid": "Enter a theme color in #RRGGBB format.",
    "settings.ui.themeColorReset": "Reset color",
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
    "whitelist": "Whitelist",
    "whitelistDesc": "Friend deletion whitelist",
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
  "wiki.web.close": "Schliessen",
  "wiki.web.detach": "Abtrennen",
  "wiki.web.failed": "Web-Wiki konnte nicht laden",
  "wiki.web.loading": "Web-Wiki wird geladen...",
  "wiki.web.pin": "Schweben",
  "wiki.web.return": "Zurueck",
  "wiki.web.title": "Web-Wiki",
});

Object.assign(manualTranslations.fr, {
  "contextMenu.copy": "Copier",
  "contextMenu.inspect": "Inspecter",
  "contextMenu.inspectWebuiHint": "Appuyez sur F12 pour ouvrir les outils dev.",
  "contextMenu.paste": "Coller",
  "contextMenu.pasteFailed": "Le presse-papiers n'est pas disponible.",
  "contextMenu.reload": "Recharger",
  "wiki.web.close": "Fermer",
  "wiki.web.detach": "Detacher",
  "wiki.web.failed": "Echec du chargement du Wiki web",
  "wiki.web.loading": "Chargement du Wiki web...",
  "wiki.web.pin": "Flottant",
  "wiki.web.return": "Retour",
  "wiki.web.title": "Wiki web",
});

Object.assign(manualTranslations.ja, {
  "contextMenu.copy": "コピー",
  "contextMenu.inspect": "検査",
  "contextMenu.inspectWebuiHint": "F12で開発者ツールを開きます。",
  "contextMenu.paste": "貼り付け",
  "contextMenu.pasteFailed": "クリップボードを使用できません。",
  "contextMenu.reload": "再読み込み",
  "wiki.web.close": "閉じる",
  "wiki.web.detach": "別ウィンドウ",
  "wiki.web.failed": "Web Wikiの読み込みに失敗",
  "wiki.web.loading": "Web Wikiを読み込み中...",
  "wiki.web.pin": "フロート",
  "wiki.web.return": "戻る",
  "wiki.web.title": "Web Wiki",
});

Object.assign(manualTranslations.ko, {
  "contextMenu.copy": "복사",
  "contextMenu.inspect": "검사",
  "contextMenu.inspectWebuiHint": "F12로 개발자 도구를 여세요.",
  "contextMenu.paste": "붙여넣기",
  "contextMenu.pasteFailed": "클립보드를 사용할 수 없습니다.",
  "contextMenu.reload": "새로고침",
  "wiki.web.close": "닫기",
  "wiki.web.detach": "분리",
  "wiki.web.failed": "웹 Wiki 로드 실패",
  "wiki.web.loading": "웹 Wiki 로드 중...",
  "wiki.web.pin": "플로팅",
  "wiki.web.return": "돌아가기",
  "wiki.web.title": "웹 Wiki",
});

Object.assign(manualTranslations.ru, {
  "contextMenu.copy": "Копировать",
  "contextMenu.inspect": "Проверить",
  "contextMenu.inspectWebuiHint": "Нажмите F12, чтобы открыть DevTools.",
  "contextMenu.paste": "Вставить",
  "contextMenu.pasteFailed": "Буфер обмена недоступен.",
  "contextMenu.reload": "Обновить",
  "wiki.web.close": "Закрыть",
  "wiki.web.detach": "Отделить",
  "wiki.web.failed": "Не удалось загрузить Web Wiki",
  "wiki.web.loading": "Загрузка Web Wiki...",
  "wiki.web.pin": "Плавающая",
  "wiki.web.return": "Назад",
  "wiki.web.title": "Web Wiki",
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
  return (
    (value === key ? undefined : value) ??
    manualTranslations[lang]?.[key] ??
    manualTranslations.en[key] ??
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
