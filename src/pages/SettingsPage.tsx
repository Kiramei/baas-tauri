import React, { useEffect, useRef, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useSettingsSearchHighlight } from "@/shared/useSettingsSearchHighlight";
import {
  SettingsToggle,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "@/components/settings/SettingsControls";
import { VersionOverview } from "@/components/settings/VersionOverview";
import { CommitHistorySettings } from "@/components/settings/CommitHistory";
import { ShaDiagnostics, type ShaDiagnosticResult } from "@/components/settings/ShaDiagnostics";
import SettingsNavigation from "@/components/layout/SettingsNavigation";
import {
  SETTINGS_SECTIONS,
  WEBUI_SETTINGS_SECTIONS,
  resolveSettingsSection,
} from "@/shared/SettingsSections";
import { useTheme } from "@/context/ThemeProvider";
import { Theme } from "@/types/app";
import { ThemeSelector } from "@/components/ui/ThemeSelector";
import { FormInput } from "@/components/ui/FormInput.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { IconTooltip } from "@/components/ui/Tooltip";
import { toast } from "sonner";
import { ImagePlus, Loader2, Palette, RotateCcw, Trash2, UserSearch } from "lucide-react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { supportsSharedMemory } from "@/transport/factory";
import { formatIsoToReadable, getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { resolveClientVersion } from "@/shared/ClientVersion";
import { loadLocale } from "@/shared/I18nTranslator.ts";
import { useUISettings } from "@/context/UISettingsProvider.tsx";
import { i18nKey, mirrorcMessageKey, shaMethodKey, updateMethodKey } from "@/shared/I18nKeys";
import type { TranslationKey } from "@/types/i18n";
import LanguageSelect from "@/components/LanguageSelect.tsx";
import { useTauriSelfUpdate } from "@/context/TauriSelfUpdateProvider";
import { TauriUpdateProgressModal } from "@/components/updater/TauriUpdateProgressModal";
import { DEFAULT_THEME_COLOR, HEX_COLOR_RE } from "@/components/GlobalAppearanceEffects";
import { SystemLogSettings } from "@/components/SystemLogSettings";
import { ShortcutSettings } from "@/components/settings/ShortcutSettings";
import { KeyResetSettings } from "@/components/settings/KeyResetSettings";
import { PluginSettingsEntry } from "@/components/settings/PluginSettingsEntry";
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerContent,
  ColorPickerEyeDropper,
  ColorPickerHueSlider,
  ColorPickerInput,
  ColorPickerSwatch,
  ColorPickerTrigger,
} from "@/components/ui/ColorPicker";

type RepoConfig = {
  label: string;
  method: string;
};

type TauriBackendVersionReport = {
  local?: string | null;
  remote?: string | null;
  updateAvailable?: boolean;
  update_available?: boolean;
  channel?: string;
  method?: string;
};

type TauriShaMethodReport = {
  success: boolean;
  name: string;
  order?: number;
  duration: number;
  value?: string | null;
  error?: string | null;
};

const reposInit: RepoConfig[] = [
  {
    label: "updateMethod.github",
    method: "github",
  },
  {
    label: "updateMethod.cnb",
    method: "cnb",
  },
  {
    label: "updateMethod.gitee",
    method: "gitee",
  },
  {
    label: "updateMethod.gitcode",
    method: "gitcode",
  },
  {
    label: "updateMethod.githubProxyV4",
    method: "github_proxy_v4",
  },
  {
    label: "updateMethod.githubProxyV6",
    method: "github_proxy_v6",
  },
  {
    label: "updateMethod.githubProxyCdn",
    method: "github_proxy_cdn",
  },
  {
    label: "updateMethod.ghProxy",
    method: "gh_proxy",
  },
  {
    label: "updateMethod.sevencdn",
    method: "sevencdn",
  },
  {
    label: "updateMethod.githubfast",
    method: "githubfast",
  },
  {
    label: "updateMethod.baasCdn",
    method: "baas_cdn",
  },
];

let hybrid = true;
const SHA_TEST_TIMEOUT_MS = 10_000;
const SHA_TEST_TIMEOUT_SECONDS = SHA_TEST_TIMEOUT_MS / 1000;
const MAX_BACKGROUND_IMAGE_BYTES = 5 * 1024 * 1024;
const BACKGROUND_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const THEME_COLOR_PRESETS = [
  "#1a1c1f",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#475569",
];

const backgroundMimeByExtension: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const isPresentVersionValue = (value: unknown) => value !== "" && value !== undefined;
const shortDesktopShaOrNull = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value.slice(0, 6) : null;

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const mimeFromFilename = (filename: string) => {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return backgroundMimeByExtension[extension] ?? "";
};

const isSupportedBackgroundMime = (mime: string) =>
  ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);

const shaMethodsInit = [
  { label: "shaMethod.github", value: "github" },
  { label: "shaMethod.mirrorc", value: "mirrorc" },
  { label: "shaMethod.cnb", value: "cnb" },
  { label: "shaMethod.gitee", value: "gitee" },
  { label: "shaMethod.gitcode", value: "gitcode" },
  { label: "shaMethod.githubProxyV4", value: "github_proxy_v4" },
  { label: "shaMethod.githubProxyV6", value: "github_proxy_v6" },
  { label: "shaMethod.githubProxyCdn", value: "github_proxy_cdn" },
  { label: "shaMethod.ghProxy", value: "gh_proxy" },
  { label: "shaMethod.sevencdn", value: "sevencdn" },
  { label: "shaMethod.githubfast", value: "githubfast" },
  { label: "shaMethod.baasCdn", value: "baas_cdn" },
];

const availableSections = __WITH_TAURI__ ? SETTINGS_SECTIONS : WEBUI_SETTINGS_SECTIONS;

/** Renders the settings page component. */
const SettingsPage: React.FC = () => {
  const { t, language } = useAppTranslation();
  const { theme, setTheme } = useTheme();
  const { uiSettings, setUiSettings } = useUISettings();
  const section = resolveSettingsSection(uiSettings.settingsSection, availableSections);
  const pageRef = useRef<HTMLDivElement>(null);
  useSettingsSearchHighlight(pageRef, section.id, language);
  useEffect(() => {
    const scrollRegion = pageRef.current?.closest<HTMLElement>(".app-page-scroll");
    if (scrollRegion && window.matchMedia("(min-width: 1024px)").matches) {
      scrollRegion.scrollTop = 0;
    }
  }, [section.id]);
  const backgroundFileInputRef = useRef<HTMLInputElement | null>(null);
  const trigger = useWebSocketStore((state) => state.trigger);
  const triggerStream = useWebSocketStore((state) => state.triggerStream);
  const updateConfig = useWebSocketStore((state) => state.updateStore);
  const versionStore = useWebSocketStore((state) => state.versionStore);
  const checkTauriUpdater = useWebSocketStore((state) => state.checkTauriUpdater);
  const modify = useWebSocketStore((state) => state.modify);
  const transportMode = useWebSocketStore((state) => state.transportMode);
  const setTransportMode = useWebSocketStore((state) => state.setTransportMode);
  const tauriUpdate = useTauriSelfUpdate();
  const [reposInitState, setReposInitState] = useState(reposInit);
  const [themeColorInput, setThemeColorInput] = useState(
    uiSettings.themeColor || DEFAULT_THEME_COLOR
  );
  const activeThemeColor = HEX_COLOR_RE.test(themeColorInput)
    ? themeColorInput
    : DEFAULT_THEME_COLOR;

  /** Handles the handle theme change interaction. */
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    setUiSettings((state) => ({ ...state, theme: newTheme }));
  };

  /** Handles the handle language change interaction. */
  const handleLanguageChange = (value: string) => {
    void loadLocale(value).then((loaded) => {
      if (loaded) setUiSettings((state) => ({ ...state, lang: value }));
    });
  };

  /** Handles the handle zoom change interaction. */
  const handleZoomChange = (value: string) => {
    const newZoom = Number(value);
    setUiSettings((state) => ({ ...state, zoomScale: newZoom }));
  };

  const commitThemeColor = (value: string) => {
    const nextColor = value.trim();
    if (!HEX_COLOR_RE.test(nextColor)) {
      setThemeColorInput(uiSettings.themeColor || DEFAULT_THEME_COLOR);
      toast.error(t("settings.ui.themeColorInvalid"));
      return;
    }
    const normalizedColor = nextColor.toLowerCase();
    setThemeColorInput(normalizedColor);
    setUiSettings((state) => ({ ...state, themeColor: normalizedColor }));
  };

  /** Handles the handle background image bytes interaction. */
  const handleBackgroundImageBytes = (bytes: Uint8Array, mime: string) => {
    if (!isSupportedBackgroundMime(mime)) {
      toast.error(t("settings.ui.backgroundImageInvalidType"));
      return;
    }
    if (bytes.byteLength > MAX_BACKGROUND_IMAGE_BYTES) {
      toast.error(t("settings.ui.backgroundImageTooLarge"));
      return;
    }

    setUiSettings((state) => ({
      ...state,
      backgroundImageBase64: `data:${mime};base64,${bytesToBase64(bytes)}`,
    }));
  };

  /** Handles the handle web background image change interaction. */
  const handleWebBackgroundImageChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const mime = file.type || mimeFromFilename(file.name);
    if (!isSupportedBackgroundMime(mime)) {
      toast.error(t("settings.ui.backgroundImageInvalidType"));
      return;
    }
    if (file.size > MAX_BACKGROUND_IMAGE_BYTES) {
      toast.error(t("settings.ui.backgroundImageTooLarge"));
      return;
    }

    try {
      handleBackgroundImageBytes(new Uint8Array(await file.arrayBuffer()), mime);
    } catch (error) {
      toast.error(t("settings.ui.backgroundImageReadFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Handles the handle select background image interaction. */
  const handleSelectBackgroundImage = async () => {
    if (!__WITH_TAURI__) {
      backgroundFileInputRef.current?.click();
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const file = await open({
        title: t("settings.ui.backgroundImageChoose"),
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "webp", "gif"],
          },
        ],
      });

      if (typeof file !== "string") return;
      const mime = mimeFromFilename(file);
      if (!isSupportedBackgroundMime(mime)) {
        toast.error(t("settings.ui.backgroundImageInvalidType"));
        return;
      }

      const bytes = await readFile(file);
      handleBackgroundImageBytes(bytes, mime);
    } catch (error) {
      toast.error(t("settings.ui.backgroundImageReadFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Handles the handle remove background image interaction. */
  const handleRemoveBackgroundImage = () => {
    setUiSettings((state) => ({ ...state, backgroundImageBase64: null }));
  };

  /** Handles the handle background opacity change interaction. */
  const handleBackgroundOpacityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const opacity = Number(event.target.value) / 100;
    setUiSettings((state) => ({ ...state, backgroundImageOpacity: opacity }));
  };

  /** Handles the handle player change interaction. */
  const handlePlayerChange = (value: string) => {
    setUiSettings((state) => ({
      ...state,
      remoteSettings: {
        ...state.remoteSettings,
        streamPlayer: value as "mse" | "broadway" | "tinyh264" | "webcodecs",
      },
    }));
  };

  const [localVersion, setLocalVersion] = useState(t("version.fetching"));
  const [remoteVersion, setRemoteVersion] = useState(t("version.fetching"));
  const [updateStatus, setUpdateStatus] = useState<TranslationKey>("version.tapToTest");

  const [shaLocal, setShaLocal] = useState(versionStore["local"]);
  const [shaRemote, setShaRemote] = useState(versionStore["remote"]);

  const [verLocal, setVerLocal] = useState("");
  const [verRemote, setVerRemote] = useState("");

  const [apiLoading, setApiLoading] = useState(false);
  const [mcLoading, setMcLoading] = useState(false);
  const [versionChecking, setVersionChecking] = useState(false);

  const [updateMethod, setUpdateMethod] = useState<string>(updateConfig["updateMethod"]);
  const [updateChannel, setUpdateChannel] = useState<string>(updateConfig["channel"] ?? "stable");
  const [dueDate, setDueDate] = useState("");
  const tauriVersion = versionStore["tauri"] ?? {};
  const tauriCurrentVersion = resolveClientVersion(tauriVersion.currentVersion);
  const tauriRemoteVersion = tauriVersion.error
    ? t("version.checkError")
    : resolveClientVersion(tauriVersion.version, tauriCurrentVersion);
  const tauriStatus = tauriVersion.checking
    ? t("update.tauriChecking")
    : tauriVersion.error
      ? t("update.tauriFailed")
      : tauriVersion.updateAvailable
        ? t("update.tauriAvailable")
        : t("update.tauriUpToDate");

  /** Handles the handle tauri version action interaction. */
  const handleTauriVersionAction = async () => {
    if (!__WITH_TAURI__) return;
    if (tauriVersion.updateAvailable) {
      await tauriUpdate.runUpdate();
      return;
    }
    await checkTauriUpdater(true, true);
  };

  const [cdk, setCdk] = useState(updateConfig["mirrorcCdk"]);
  const [shaResults, setShaResults] = useState<ShaDiagnosticResult[]>(
    shaMethodsInit.map((m) => ({ method: shaMethodKey(m.value), status: "pending" }))
  );
  const [showShaResults, setShowShaResults] = useState(false);
  const shaTestRunRef = useRef<number | null>(null);
  const shaTestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setThemeColorInput(uiSettings.themeColor || DEFAULT_THEME_COLOR);
  }, [uiSettings.themeColor]);

  const fetchVersion = async () => {
    setVersionChecking(true);
    setShaRemote("");
    setShaLocal("");
    setVerRemote("");
    setVerLocal("");

    setLocalVersion(t("version.fetching"));
    setRemoteVersion(t("version.fetching"));
    setUpdateStatus("version.testing");

    if (__WITH_TAURI__) {
      try {
        const { invoke } = await import("@/shared/TauriInvoke");
        const report = await invoke<TauriBackendVersionReport>("updater_check_version", {
          request: {
            channel: updateChannel,
          },
        });
        setShaLocal(report.local ?? null);
        setShaRemote(report.remote ?? null);
        useWebSocketStore.setState((state: any) => ({
          ...state,
          versionStore: {
            ...state.versionStore,
            local: report.local ?? null,
            remote: report.remote ?? null,
            updateAvailable:
              report.updateAvailable ?? report.update_available ?? report.local !== report.remote,
            channel: report.channel ?? updateChannel,
            method: report.method ?? state.versionStore?.method,
            lastChecked: Date.now(),
          },
        }));
        setUpdateStatus("version.tapToTest");
      } catch (error) {
        setShaLocal(null);
        setShaRemote(null);
        setLocalVersion(t("version.checkError"));
        setRemoteVersion(t("version.checkError"));
        toast.error(String(error ?? t("version.checkError")));
      } finally {
        setVersionChecking(false);
      }
      return;
    }

    trigger(
      {
        timestamp: getTimestampMs(),
        command: "check_for_update",
        payload: {
          channel: updateChannel,
        },
      },
      (e) => {
        setShaLocal(e.data.local);
        setShaRemote(e.data.remote);
        setUpdateStatus("version.tapToTest");
        setVersionChecking(false);
      }
    );
  };

  /** Handles the handle test cdk interaction. */
  const handleTestCdk = (_: any, showMessage: boolean = true) => {
    if (!cdk) {
      if (showMessage) {
        toast.error(t("mirrorc.cdk.noInput"));
      }
    }
    setMcLoading(true);
    trigger(
      {
        timestamp: getTimestampMs() + Math.random(),
        command: "valid_cdk",
        payload: {
          cdk: cdk,
          channel: updateChannel,
        },
      },
      (e) => {
        if (e.data.success) {
          const expires_at_iso = e.data.expires_at_iso;
          console.log(expires_at_iso);
          const message = expires_at_iso
            ? (t(mirrorcMessageKey(e.data.message), {
                expire_date: formatIsoToReadable(expires_at_iso),
              }) as string)
            : t(mirrorcMessageKey(e.data.message));
          if (showMessage) toast.success(t("mirrorc.cdk.testOk"), { description: message });
          setDueDate(expires_at_iso);
          modify("global::setup_toml", { mirrorcCdk: cdk }, false);
        } else {
          if (cdk !== "" && showMessage) {
            toast.error(t(mirrorcMessageKey(e.data.message)), {
              description: t(mirrorcMessageKey(e.data.mirrorc_message)),
            });
          }
          setCdk("");
          setDueDate("");
          modify("global::setup_toml", { mirrorcCdk: "" }, false);
        }
        setMcLoading(false);
      }
    );
  };

  useEffect(() => {
    if (hybrid) {
      hybrid = false;
      if (cdk) {
        handleTestCdk(undefined);
      }
    }
  }, []);

  useEffect(() => {
    if (updateConfig["mirrorcCdk"]) {
      setReposInitState([
        ...reposInit,
        {
          label: "updateMethod.mirrorc",
          method: "mirrorc",
        },
      ]);
      setUpdateMethod("mirrorc");
    } else {
      setUpdateMethod(updateConfig["updateMethod"]);
      setReposInitState(reposInit.filter((ele) => ele.method !== "mirrorc"));
    }
    setUpdateChannel(updateConfig["channel"] ?? "stable");
  }, [updateConfig]);

  useEffect(() => {
    if (versionStore.local !== undefined) setShaLocal(versionStore.local);
    if (versionStore.remote !== undefined) setShaRemote(versionStore.remote);
  }, [versionStore.local, versionStore.remote]);

  useEffect(() => {
    if (![verLocal, shaLocal, verRemote, shaRemote].some(isPresentVersionValue)) {
      setLocalVersion(t("version.fetching"));
      setRemoteVersion(t("version.fetching"));
      return;
    }

    const localSha = shortDesktopShaOrNull(shaLocal);
    setLocalVersion(localSha ?? t("version.checkError"));

    if (versionStore.method === "disabled" && shaRemote === null) {
      setRemoteVersion(t("version.tapToTest"));
      return;
    }
    const remoteSha = shortDesktopShaOrNull(shaRemote);
    setRemoteVersion(remoteSha ?? t("version.checkError"));
  }, [verLocal, shaLocal, verRemote, shaRemote, t, versionStore.method]);

  useEffect(() => {
    return () => {
      if (shaTestTimeoutRef.current) {
        clearTimeout(shaTestTimeoutRef.current);
      }
    };
  }, []);

  /** Handles the handle test sha interaction. */
  const handleTestSha = async () => {
    setShowShaResults(true);
    const timestamp = getTimestampMs();
    shaTestRunRef.current = timestamp;
    if (shaTestTimeoutRef.current) {
      clearTimeout(shaTestTimeoutRef.current);
    }
    setApiLoading(true);
    setShaResults(
      shaMethodsInit.map((m) => ({ method: shaMethodKey(m.value), status: "testing" }))
    );
    shaTestTimeoutRef.current = setTimeout(() => {
      if (shaTestRunRef.current !== timestamp) return;
      shaTestRunRef.current = null;
      shaTestTimeoutRef.current = null;
      setApiLoading(false);
      setShaResults((prev) =>
        prev.map((item) =>
          item.status === "testing"
            ? {
                ...item,
                status: "error",
                time: item.time ?? SHA_TEST_TIMEOUT_SECONDS.toFixed(3),
              }
            : item
        )
      );
      toast.error(t("shaTest.timeout"));
    }, SHA_TEST_TIMEOUT_MS);

    if (__WITH_TAURI__) {
      const { invoke } = await import("@/shared/TauriInvoke");
      const applyResult = (result: TauriShaMethodReport) => {
        if (shaTestRunRef.current !== timestamp) return;
        setShaResults((prev) =>
          prev.map((item) =>
            item.method === shaMethodKey(result.name)
              ? {
                  ...item,
                  status: result.success ? "success" : "error",
                  time: result.duration.toFixed(3),
                  sha: result.success ? (result.value ?? undefined) : undefined,
                }
              : item
          )
        );
      };
      try {
        await Promise.allSettled(
          shaMethodsInit.map(async (method) => {
            try {
              const result = await invoke<TauriShaMethodReport>("updater_test_sha_method", {
                request: {
                  channel: updateChannel,
                  timeout: SHA_TEST_TIMEOUT_SECONDS,
                  method: method.value,
                },
              });
              applyResult(result);
            } catch (error) {
              applyResult({
                success: false,
                name: method.value,
                duration: SHA_TEST_TIMEOUT_SECONDS,
                value: null,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );
      } catch (error) {
        if (shaTestRunRef.current === timestamp) {
          toast.error(String(error ?? t("version.checkError")));
        }
      } finally {
        if (shaTestRunRef.current === timestamp) {
          if (shaTestTimeoutRef.current) {
            clearTimeout(shaTestTimeoutRef.current);
            shaTestTimeoutRef.current = null;
          }
          shaTestRunRef.current = null;
          setApiLoading(false);
        }
      }
      return;
    }

    triggerStream(
      {
        timestamp,
        command: "test_all_sha_stream",
        payload: {
          channel: updateChannel,
          timeout: SHA_TEST_TIMEOUT_SECONDS,
        },
      },
      (e) => {
        if (shaTestRunRef.current !== timestamp) return;
        if (e.data?.done) {
          if (shaTestTimeoutRef.current) {
            clearTimeout(shaTestTimeoutRef.current);
            shaTestTimeoutRef.current = null;
          }
          shaTestRunRef.current = null;
          setApiLoading(false);
          if (e.status === "error") {
            toast.error(String(e.error ?? t("version.checkError")));
          }
          return;
        }
        const result = e.data as {
          success: boolean;
          name: string;
          duration: number;
          value: string | null;
        };
        setShaResults((prev) =>
          prev.map((item) =>
            item.method === shaMethodKey(result.name)
              ? {
                  ...item,
                  status: result.success ? "success" : "error",
                  time: result.duration.toFixed(3),
                  sha: result.success ? (result.value ?? undefined) : undefined,
                }
              : item
          )
        );
      }
    );
  };

  /** Handles the handle update method interaction. */
  const handleUpdateMethod = (value: string) => {
    if (value === "mirrorc") {
      modify("global::setup_toml", { updateMethod: value });
      setUpdateMethod(value);
      return;
    } else if (value !== "mirrorc" && updateConfig["mirrorcCdk"]) {
      setCdk("");
      setDueDate("");
    }
    modify("global::setup_toml", { mirrorcCdk: "" }, false);
    modify("global::setup_toml", { updateMethod: value });
    setUpdateMethod(value);
  };

  /** Handles the handle update channel interaction. */
  const handleUpdateChannel = (value: string) => {
    const channel = value === "dev" ? "dev" : "stable";
    setUpdateChannel(channel);
    modify("global::setup_toml", { channel });
  };

  /** Persists and activates the selected desktop backend transport. */
  const handleTransportMode = async (value: string) => {
    if (!__WITH_TAURI__) return;
    const mode = value === "shm" ? "shm" : value === "pipe" ? "pipe" : "websocket";
    try {
      await setTransportMode(mode);
    } catch {
      toast.error(t("update.backendStartFailed"));
    }
  };

  return (
    <div ref={pageRef} className="settings-page">
      <div className="settings-mobile-navigation lg:hidden">
        <SettingsNavigation compact />
      </div>
      <input
        ref={backgroundFileInputRef}
        type="file"
        accept={BACKGROUND_IMAGE_ACCEPT}
        className="hidden"
        onChange={handleWebBackgroundImageChange}
      />
      <div className="settings-categories">
        {availableSections.map((displayedSection) => (
          <section
            key={displayedSection.id}
            aria-labelledby={`settings-section-${displayedSection.id}-title`}
            data-settings-section={displayedSection.id}
            className={`settings-category${section.id === displayedSection.id ? "" : " settings-category-inactive"}`}
          >
            <h2
              id={`settings-section-${displayedSection.id}-title`}
              className="settings-page-title"
            >
              {t(i18nKey(displayedSection.label))}
            </h2>
            <div className="settings-sections">
              {displayedSection.id === "general" && (
                <div className="settings-sections">
                  <SettingsGroup title={t("settings.groups.preferences")}>
                    <SettingsRow
                      label={t("language")}
                      description={t("settings.descriptions.language")}
                    >
                      <LanguageSelect
                        handleLanguageChange={handleLanguageChange}
                        className="settings-select-control"
                        hideLabel
                      />
                    </SettingsRow>
                    <SettingsToggle
                      label={t("settings.ui.lowPerformanceMode")}
                      description={t("settings.descriptions.lowPerformanceMode")}
                      checked={uiSettings.lowPerformanceMode}
                      onChange={(value) =>
                        setUiSettings((state) => ({ ...state, lowPerformanceMode: value }))
                      }
                    />
                  </SettingsGroup>
                  <PluginSettingsEntry />
                  {__WITH_WEBUI__ && <KeyResetSettings />}
                  {__WITH_TAURI__ && (
                    <SettingsGroup title={t("settings.groups.desktop")}>
                      {__WITH_TAURI__ && (
                        <SettingsToggle
                          label={t("settings.ui.enableSystemNotifications")}
                          description={t("settings.descriptions.systemNotifications")}
                          checked={uiSettings.enableSystemNotifications}
                          onChange={(value) =>
                            setUiSettings((state) => ({
                              ...state,
                              enableSystemNotifications: value,
                            }))
                          }
                        />
                      )}
                      {__WITH_TAURI__ && !__WITH_ANDROID__ && (
                        <SettingsToggle
                          label={t("workflow.minimizeToTray")}
                          description={t("settings.descriptions.minimizeToTray")}
                          checked={uiSettings.minimizeToTray ?? false}
                          onChange={(value) =>
                            setUiSettings((state) => ({ ...state, minimizeToTray: value }))
                          }
                        />
                      )}
                      {!__WITH_ANDROID__ && (
                        <SettingsToggle
                          label={t("installer.autoEnter")}
                          description={t("installer.autoEnterHint")}
                          checked={uiSettings.autoEnterAfterInstall !== false}
                          onChange={(value) =>
                            setUiSettings((state) => ({ ...state, autoEnterAfterInstall: value }))
                          }
                        />
                      )}
                    </SettingsGroup>
                  )}
                </div>
              )}
              {displayedSection.id === "appearance" && (
                <div className="settings-sections">
                  <SettingsGroup title={t("common.theme")}>
                    <SettingsRow label={t("common.theme")} className="settings-theme-row">
                      <ThemeSelector value={theme} onChange={handleThemeChange} compact />
                    </SettingsRow>
                    <div className="settings-block">
                      <label className="settings-block-label">
                        <Palette className="h-4 w-4 text-muted-foreground" />
                        {t("settings.ui.themeColor")}
                      </label>
                      <div className="settings-color-controls">
                        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-3 items-center">
                          <ColorPicker value={activeThemeColor} onValueChange={commitThemeColor}>
                            <IconTooltip content={t("settings.ui.themeColor")}>
                              <ColorPickerTrigger asChild>
                                <button
                                  type="button"
                                  className="flex h-11 w-full items-center justify-center rounded-lg border border-border bg-card transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-14"
                                  aria-label={t("settings.ui.themeColor")}
                                >
                                  <ColorPickerSwatch className="h-7 w-7 rounded-full border-white ring-1 ring-slate-300 dark:ring-slate-600" />
                                </button>
                              </ColorPickerTrigger>
                            </IconTooltip>
                            <ColorPickerContent
                              align="start"
                              className="w-80 rounded-xl bg-popover p-3 shadow-lg"
                            >
                              <ColorPickerArea className="h-40 rounded-lg" />
                              <ColorPickerHueSlider />
                              <div className="flex items-center gap-2">
                                <ColorPickerInput withoutAlpha className="min-w-0 flex-1" />
                                <ColorPickerEyeDropper />
                              </div>

                              <div className="grid grid-cols-8 gap-2">
                                {THEME_COLOR_PRESETS.map((color) => (
                                  <IconTooltip key={color} content={color}>
                                    <button
                                      type="button"
                                      aria-label={color}
                                      onClick={() => commitThemeColor(color)}
                                      className={`h-7 w-7 rounded-full border-2 shadow-xs transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                                        (
                                          uiSettings.themeColor || DEFAULT_THEME_COLOR
                                        ).toLowerCase() === color
                                          ? "border-slate-900 ring-2 ring-primary-300 dark:border-white"
                                          : "border-white dark:border-slate-700"
                                      }`}
                                      style={{ backgroundColor: color }}
                                    />
                                  </IconTooltip>
                                ))}
                              </div>
                            </ColorPickerContent>
                          </ColorPicker>
                          <FormInput
                            className="min-w-0"
                            childClassName="font-mono uppercase tracking-wide"
                            value={themeColorInput}
                            placeholder={DEFAULT_THEME_COLOR}
                            onChange={(event) => setThemeColorInput(event.target.value)}
                            onBlur={(event) => commitThemeColor(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <CButton
                            type="button"
                            variant="secondary"
                            className="pl-3"
                            onClick={() => commitThemeColor(DEFAULT_THEME_COLOR)}
                          >
                            <div className="flex items-center justify-center">
                              <RotateCcw className="mr-1 h-4 w-4" />
                              {t("settings.ui.themeColorReset")}
                            </div>
                          </CButton>
                        </div>
                      </div>
                    </div>
                  </SettingsGroup>
                  <SettingsGroup title={t("settings.ui.backgroundImage")}>
                    <div className="settings-block">
                      <div className="settings-background-controls">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card text-muted-foreground"
                              style={
                                uiSettings.backgroundImageBase64
                                  ? {
                                      backgroundImage: `url(${uiSettings.backgroundImageBase64})`,
                                      backgroundPosition: "center",
                                      backgroundSize: "cover",
                                    }
                                  : undefined
                              }
                            >
                              {!uiSettings.backgroundImageBase64 && (
                                <ImagePlus className="h-5 w-5" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">
                                {uiSettings.backgroundImageBase64
                                  ? t("settings.ui.backgroundImageSelected")
                                  : t("settings.ui.backgroundImageEmpty")}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {t("settings.ui.backgroundImageOpacity")}:{" "}
                                {Math.round((uiSettings.backgroundImageOpacity ?? 0.18) * 100)}%
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={handleSelectBackgroundImage}
                              className="max-sm:grow inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <ImagePlus className="h-4 w-4" />
                              {t("settings.ui.backgroundImageChoose")}
                            </button>
                            <button
                              type="button"
                              disabled={!uiSettings.backgroundImageBase64}
                              onClick={handleRemoveBackgroundImage}
                              className="max-sm:grow inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-sm font-semibold text-red-600  transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-45 dark:border-red-900/60 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950/40"
                            >
                              <Trash2 className="h-4 w-4" />
                              {t("settings.ui.backgroundImageRemove")}
                            </button>
                          </div>
                        </div>
                        <div className="settings-opacity">
                          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium text-muted-foreground">
                              {t("settings.ui.backgroundImageOpacity")}
                            </span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {Math.round((uiSettings.backgroundImageOpacity ?? 0.18) * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={60}
                            step={1}
                            value={Math.round((uiSettings.backgroundImageOpacity ?? 0.18) * 100)}
                            onChange={handleBackgroundOpacityChange}
                            className="block h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-foreground"
                          />
                        </div>
                      </div>
                    </div>
                  </SettingsGroup>
                  <SettingsGroup title={t("settings.groups.display")}>
                    <SettingsSelect
                      value={uiSettings?.zoomScale.toString()}
                      label={t("ui.zoom")}
                      onChange={handleZoomChange}
                      options={[50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150].map((v) => ({
                        value: v.toString(),
                        label: `${v}%`,
                      }))}
                    />
                    <SettingsToggle
                      label={t("settings.ui.assets")}
                      description={t("settings.descriptions.assets")}
                      checked={uiSettings.assetsDisplay}
                      onChange={(value) =>
                        setUiSettings((state) => ({ ...state, assetsDisplay: value }))
                      }
                    />
                    <SettingsToggle
                      label={t("settings.ui.enableBAComet")}
                      checked={uiSettings.enableBAComet}
                      onChange={(value) =>
                        setUiSettings((state) => ({ ...state, enableBAComet: value }))
                      }
                    />
                  </SettingsGroup>
                </div>
              )}
              {displayedSection.id === "runtime" && (
                <SettingsGroup title={t("settings.groups.connection")}>
                  {__WITH_TAURI__ && (
                    <SettingsSelect
                      label={t("transport.label")}
                      value={transportMode}
                      onChange={(value) => void handleTransportMode(value)}
                      options={[
                        { value: "websocket", label: t("transport.websocket") },
                        { value: "pipe", label: t("transport.pipe") },
                        ...(supportsSharedMemory()
                          ? [{ value: "shm", label: t("transport.shm") }]
                          : []),
                      ]}
                    />
                  )}
                  {!__WITH_ANDROID__ && (
                    <SettingsSelect
                      value={uiSettings?.remoteSettings.streamPlayer}
                      label={t("settings.ui.player")}
                      onChange={handlePlayerChange}
                      options={["mse", "broadway", "tinyh264", "webcodecs"].map((v) => ({
                        value: v.toString(),
                        label: v.charAt(0).toUpperCase() + v.slice(1),
                      }))}
                    />
                  )}
                  {!__WITH_ANDROID__ && (
                    <SettingsToggle
                      label={t("settings.ui.enableSafeStream")}
                      description={t("settings.descriptions.safeStream")}
                      checked={uiSettings.remoteSettings.enableSafeStream}
                      onChange={(value) =>
                        setUiSettings((state) => ({
                          ...state,
                          remoteSettings: { ...state.remoteSettings, enableSafeStream: value },
                        }))
                      }
                    />
                  )}
                </SettingsGroup>
              )}
              {displayedSection.id === "updates" && (
                <div className="settings-sections">
                  <VersionOverview
                    script={{
                      current: localVersion,
                      latest: remoteVersion,
                      currentDetail: shaLocal || undefined,
                      latestDetail: shaRemote || undefined,
                      source: t(updateMethodKey(updateMethod)),
                      checking: versionChecking,
                      checkLabel: t(i18nKey(updateStatus)),
                      onCheck: fetchVersion,
                    }}
                    client={
                      __WITH_TAURI__
                        ? {
                            current: tauriCurrentVersion,
                            latest: tauriRemoteVersion,
                            status: tauriStatus,
                            busy: Boolean(tauriVersion.checking || tauriUpdate.updating),
                            updateAvailable: Boolean(tauriVersion.updateAvailable),
                            onAction: handleTauriVersionAction,
                          }
                        : undefined
                    }
                  />
                  <CommitHistorySettings channel={updateChannel} />
                  <SettingsGroup title={t("update.settingsTitle")}>
                    {__WITH_TAURI__ && !__WITH_WEBUI__ && (
                      <SettingsToggle
                        label={t("settings.ui.idleAutoUpdate")}
                        description={t("settings.descriptions.idleAutoUpdate")}
                        checked={uiSettings.idleAutoUpdate ?? true}
                        onChange={(value) =>
                          setUiSettings((state) => ({ ...state, idleAutoUpdate: value }))
                        }
                      />
                    )}
                    <div className="settings-update-form">
                      <div className="grid grid-cols-1 gap-1">
                        <div className="grid sm:flex gap-2 items-center">
                          <FormInput
                            label={t("update.mirrorCdk")}
                            placeholder={t("update.enterCdk")}
                            value={cdk}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleTestCdk(undefined);
                              }
                            }}
                            onChange={(e) => setCdk(e.target.value)}
                            className="flex-1"
                          />

                          <CButton
                            onClick={handleTestCdk}
                            disabled={mcLoading}
                            className="pl-3 self-end"
                          >
                            {mcLoading ? (
                              <div className="flex justify-center items-center">
                                <Loader2 className="animate-spin mr-2 h-4 w-4" />
                                {t("mirror.verifying")}
                              </div>
                            ) : (
                              <div className="flex justify-center items-center">
                                <UserSearch className="mr-1 h-4 w-4" />
                                {t("mirror.verify")}
                              </div>
                            )}
                          </CButton>
                        </div>
                        {dueDate !== "" ? (
                          <div className="text-sm text-muted-foreground">
                            {t("update.dueDate")}: {formatIsoToReadable(dueDate)}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">&nbsp;</div>
                        )}
                      </div>
                      <SettingsSelect
                        label={t("update.method")}
                        value={updateMethod}
                        onChange={handleUpdateMethod}
                        options={reposInitState.map((r) => ({
                          value: r.method,
                          label: t(updateMethodKey(r.method)),
                        }))}
                      />
                      <SettingsSelect
                        label={t("update.channel")}
                        value={updateChannel}
                        onChange={handleUpdateChannel}
                        options={[
                          { value: "stable", label: t("updateChannel.stable") },
                          { value: "dev", label: t("updateChannel.dev") },
                        ]}
                      />
                    </div>
                  </SettingsGroup>
                  <SettingsGroup title={t("update.shaConnectivityTest")}>
                    <ShaDiagnostics
                      value={updateConfig["shaMethod"]}
                      onChange={(value) => modify("global::setup_toml", { shaMethod: value })}
                      options={shaMethodsInit.map((method) => ({
                        value: method.value,
                        label: t(shaMethodKey(method.value)),
                      }))}
                      loading={apiLoading}
                      onTest={handleTestSha}
                      results={shaResults}
                      expanded={showShaResults}
                      onExpandedChange={setShowShaResults}
                    />
                  </SettingsGroup>
                </div>
              )}
              {displayedSection.id === "shortcuts" && <ShortcutSettings />}
              {displayedSection.id === "logs" && (
                <div className="settings-sections">
                  <SettingsGroup title={t("settings.groups.preferences")}>
                    <SettingsToggle
                      label={t("log.scroll.detail")}
                      checked={uiSettings.scrollToEnd}
                      onChange={(value) =>
                        setUiSettings((state) => ({ ...state, scrollToEnd: value }))
                      }
                    />
                  </SettingsGroup>
                  <SettingsGroup title={t("settings.systemLogs.title")}>
                    <div className="settings-block">
                      <SystemLogSettings />
                    </div>
                  </SettingsGroup>
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
      {__WITH_TAURI__ && (
        <TauriUpdateProgressModal
          open={tauriUpdate.progressOpen}
          onClose={() => tauriUpdate.setProgressOpen(false)}
          updating={tauriUpdate.updating}
          tauriProgress={tauriUpdate.progress}
          tauriStatus={tauriUpdate.status}
        />
      )}
    </div>
  );
};

export default SettingsPage;
