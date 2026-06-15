import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { useTheme } from "@/context/ThemeProvider";
import { Theme } from "@/types/app";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { Separator } from "@/components/ui/Separator";
import { EllipsisWithTooltip } from "@/components/ui/ETooltip";
import { toast } from "sonner";
import {
  AppWindow,
  CheckCircle2,
  Cloud,
  GitBranch,
  HardDrive,
  Info,
  Loader2,
  MinusCircle,
  RefreshCcw,
  TestTube,
  UserSearch,
  XCircle,
} from "lucide-react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { formatIsoToReadable, getTimestampMs } from "@/shared/GlobalUtilities.ts";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import { loadLocale } from "@/shared/I18nTranslator.ts";
import { useUISettings } from "@/context/UISettingsProvider.tsx";
import {
  i18nKey,
  mirrorcMessageKey,
  shaMethodKey,
  themeKey,
  updateMethodKey,
} from "@/shared/I18nKeys";
import type { TranslationKey } from "@/types/i18n";
import LanguageSelect from "@/components/LanguageSelect.tsx";

type RepoConfig = {
  label: string;
  method: string;
};

type ShaTestResult = {
  method: TranslationKey;
  status: "pending" | "success" | "error" | "testing";
  time?: number;
  sha?: string;
};

const reposInit: RepoConfig[] = [
  {
    label: "updateMethod.github",
    method: "github",
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

const shaMethodsInit = [
  { label: "shaMethod.github", value: "github" },
  { label: "shaMethod.mirrorc", value: "mirrorc" },
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

const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { uiSettings, setUiSettings } = useUISettings();
  const trigger = useWebSocketStore((state) => state.trigger);
  const updateConfig = useWebSocketStore((state) => state.updateStore);
  const versionStore = useWebSocketStore((state) => state.versionStore);
  const modify = useWebSocketStore((state) => state.modify);
  const [reposInitState, setReposInitState] = useState(reposInit);

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    setUiSettings((state) => ({ ...state, theme: newTheme }));
  };

  const handleLanguageChange = (value: string) => {
    loadLocale(value).then(() => {
      setUiSettings((state) => ({ ...state, lang: value }));
    });
  };

  const handleZoomChange = (value: string) => {
    const newZoom = Number(value);
    setUiSettings((state) => ({ ...state, zoomScale: newZoom }));
  };

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

  const infos = [
    {
      label: t("version.local"),
      value: localVersion,
      icon: <HardDrive className="w-8 h-8 text-cyan-500" />,
    },
    {
      label: t("version.remote"),
      value: remoteVersion,
      icon: <Cloud className="w-8 h-8 text-indigo-500" />,
    },
    {
      label: t("update.method"),
      value: t(i18nKey(updateStatus)),
      icon: (
        <RefreshCcw
          className={`w-8 h-8 text-purple-500 ${versionChecking ? "animate-spin" : ""}`}
        />
      ),
    },
  ];
  const [cdk, setCdk] = useState(updateConfig["mirrorcCdk"]);
  const [shaResults, setShaResults] = useState<ShaTestResult[]>(
    shaMethodsInit.map((m) => ({ method: shaMethodKey(m.value), status: "pending" }))
  );

  const fetchVersion = () => {
    setVersionChecking(true);
    setShaRemote("");
    setShaLocal("");
    setVerRemote("");
    setVerLocal("");

    setLocalVersion(t("version.fetching"));
    setRemoteVersion(t("version.fetching"));
    setUpdateStatus("version.testing");

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
    if (verLocal + shaLocal + verRemote + shaRemote !== "") {
      if (verLocal === null || shaLocal === null) setLocalVersion(t("version.checkError"));
      else setLocalVersion(`${shaLocal.slice(0, 6)}`);
      if (verRemote === null || shaRemote === null) setRemoteVersion(t("version.checkError"));
      else setRemoteVersion(`${shaRemote.slice(0, 6)}`);
    }
  }, [verLocal, shaLocal, verRemote, shaRemote]);

  const handleTestSha = () => {
    setApiLoading(true);
    setShaResults(shaResults.map((r) => ({ ...r, status: "testing" })));
    trigger(
      {
        timestamp: getTimestampMs(),
        command: "test_all_sha",
        payload: {
          channel: updateChannel,
        },
      },
      (e) => {
        setShaResults(
          e.data.map((el: { success: any; name: any; duration: number; value: any }) => ({
            status: el.success ? "success" : "error",
            method: shaMethodKey(el.name),
            time: el.duration.toFixed(3),
            sha: el.value,
          }))
        );
        setApiLoading(false);
      }
    );
  };

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

  const handleUpdateChannel = (value: string) => {
    const channel = value === "dev" ? "dev" : "stable";
    setUpdateChannel(channel);
    modify("global::setup_toml", { channel });
  };

  return (
    <div className="space-y-4">
      <Card className="relative overflow-hidden rounded-2xl border border-slate-200/50 bg-linear-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 shadow-lg">
        <div className="absolute inset-0 rounded-2xl border border-transparent mask-exclude bg-linear-to-r from-cyan-400/40 via-indigo-400/40 to-purple-400/40 blur-2xl opacity-40 pointer-events-none" />

        <CardHeader className="flex flex-row items-center gap-2">
          <Info className="w-5 h-5 text-cyan-400" />
          <CardTitle className="text-lg font-semibold tracking-wide bg-linear-to-r from-cyan-400 to-purple-500 bg-clip-text text-transparent">
            {t("version.info")}
          </CardTitle>
        </CardHeader>

        <CardContent className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {infos.map((info, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-3 rounded-lg bg-white dark:bg-slate-800/40 transition ${info.label === t("update.method") ? " cursor-link hover:bg-white/70 dark:hover:bg-slate-700/50" : ""}`}
              onClick={info.label === t("update.method") ? fetchVersion : undefined}
            >
              {info.icon}
              <div className="flex flex-col">
                <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                  {info.label}
                </p>
                <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {info.value}
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <AppWindow className="w-5 h-5" />
          <CardTitle>{t("settings.ui")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Theme Settings */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
              {t("common.theme")}
            </label>
            <div className="flex space-x-2 p-1 bg-slate-100 dark:bg-slate-700 rounded-lg">
              {(["light", "dark", "system"] as Theme[]).map((value) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                    theme === value
                      ? "bg-white dark:bg-slate-600 shadow"
                      : "hover:bg-white/50 dark:hover:bg-slate-700/50"
                  }`}
                >
                  {t(themeKey(value))}
                </button>
              ))}
            </div>
          </div>

          {/* Language Settings */}
          <LanguageSelect handleLanguageChange={handleLanguageChange} />

          {/* Zoom Settings */}
          <FormSelect
            value={uiSettings?.zoomScale.toString()}
            label={t("ui.zoom")}
            onChange={handleZoomChange}
            options={[50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150].map((v) => ({
              value: v.toString(),
              label: `${v}%`,
            }))}
          />

          {/* Player Settings */}
          <FormSelect
            value={uiSettings?.remoteSettings.streamPlayer}
            label={t("settings.ui.player")}
            onChange={handlePlayerChange}
            options={["mse", "broadway", "tinyh264", "webcodecs"].map((v) => ({
              value: v.toString(),
              label: v.charAt(0).toUpperCase() + v.slice(1),
            }))}
          />

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <SwitchButton
              label={t("log.scroll.detail")}
              checked={uiSettings?.scrollToEnd}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, scrollToEnd: value }));
              }}
            />
            <SwitchButton
              label={t("settings.ui.assets")}
              checked={uiSettings?.assetsDisplay}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, assetsDisplay: value }));
              }}
            />
            <SwitchButton
              label={t("settings.ui.enableBAComet")}
              checked={uiSettings?.enableBAComet}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, enableBAComet: value }));
              }}
            />
            <SwitchButton
              label={t("settings.ui.enableSafeStream")}
              checked={uiSettings?.remoteSettings.enableSafeStream}
              onChange={(value) => {
                setUiSettings((state) => ({
                  ...state,
                  remoteSettings: { ...uiSettings.remoteSettings, enableSafeStream: value },
                }));
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <GitBranch className="w-5 h-5" />
          <CardTitle>{t("update.settingsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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

              <CButton onClick={handleTestCdk} disabled={mcLoading} className="pl-3 self-end">
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
              <div className="text-sm text-slate-600">
                {t("update.dueDate")}: {formatIsoToReadable(dueDate)}
              </div>
            ) : (
              <div className="text-sm text-slate-600">&nbsp;</div>
            )}
          </div>

          <Separator />

          <FormSelect
            label={t("update.method")}
            value={updateMethod}
            onChange={handleUpdateMethod}
            options={reposInitState.map((r) => ({
              value: r.method,
              label: t(updateMethodKey(r.method)),
            }))}
          />

          <FormSelect
            label={t("update.channel")}
            value={updateChannel}
            onChange={handleUpdateChannel}
            options={[
              { value: "stable", label: t("updateChannel.stable") },
              { value: "dev", label: t("updateChannel.dev") },
            ]}
          />

          <div className="grid sm:flex gap-2">
            <FormSelect
              label={t("update.shaConnectivityTest")}
              value={updateConfig["shaMethod"]}
              onChange={(value) => modify("global::setup_toml", { shaMethod: value })}
              options={shaMethodsInit.map((m) => ({
                value: m.value,
                label: t(shaMethodKey(m.value)),
              }))}
              className="grow"
            />

            <CButton onClick={handleTestSha} disabled={apiLoading} className="pl-3 self-end">
              {apiLoading ? (
                <div className="flex justify-center items-center">
                  <Loader2 className="animate-spin mr-2 h-4 w-4" />
                  {t("shaTest.testing")}
                </div>
              ) : (
                <div className="flex justify-center items-center">
                  <TestTube className="mr-1 h-4 w-4" />
                  {t("shaTest.testAll")}
                </div>
              )}
            </CButton>
          </div>

          <div className="overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 shadow-md">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-linear-to-r from-cyan-50 to-purple-50 dark:from-slate-800 dark:to-slate-900">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
                    {t("shaTest.method")}
                  </th>
                  <th className="px-4 py-3 text-center font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
                    {t("shaTest.status")}
                  </th>
                  <th className="px-4 py-3 text-center font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
                    {t("shaTest.time")}
                  </th>
                  <th className="px-4 py-3 text-center font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
                    {t("shaTest.sha")}
                  </th>
                </tr>
              </thead>

              <tbody>
                {shaResults.map((r, idx) => (
                  <tr
                    key={idx}
                    className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    <td className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex">
                      <EllipsisWithTooltip text={t(i18nKey(r.method))} />
                      <div className="grow"></div>
                    </td>

                    <td className="px-4 py-3 text-center border-b border-slate-200 dark:border-slate-700 w-20">
                      {r.status === "success" && (
                        <CheckCircle2 className="w-5 h-5 mx-auto text-green-500" />
                      )}
                      {r.status === "error" && <XCircle className="w-5 h-5 mx-auto text-red-500" />}
                      {r.status === "testing" && (
                        <Loader2 className="text-yellow-500 mx-auto animate-spin h-5 w-5" />
                      )}
                      {!["success", "error", "testing"].includes(r.status) && (
                        <MinusCircle className="w-5 h-5 mx-auto text-slate-400" />
                      )}
                    </td>

                    <td className="px-4 py-3 text-center border-b border-slate-200 dark:border-slate-700 font-mono w-24">
                      {r.time ?? "-"}
                    </td>

                    <td className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 font-mono w-20">
                      {r.sha ? (
                        <EllipsisWithTooltip text={r.sha.substring(0, 6)} tooltip={r.sha} />
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SettingsPage;
