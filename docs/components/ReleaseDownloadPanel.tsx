"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, MonitorDown } from "lucide-react";

type Locale = "zh" | "en";
type Platform = "windows" | "macos" | "linux";
type Architecture = "x64" | "arm64" | "arm32" | "unknown";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type ReleaseResponse = {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
};

type DownloadItem = {
  name: string;
  href: string;
  size: number;
  platform: Platform;
  label: string;
  kind: "installer" | "fixed-webview2" | "portable" | "dmg" | "deb" | "rpm";
  arch: Architecture;
};

type DropdownOption = {
  label: string;
  value: string;
};

type Copy = {
  title: string;
  compactTitle: string;
  description: string;
  open: string;
  loading: string;
  fallback: string;
  latest: string;
  detected: string;
  chooseSystem: string;
  choosePackage: string;
  download: string;
  otherSystem: string;
  empty: string;
  platforms: Record<Platform, string>;
};

const REPO_RELEASES = "https://github.com/Kiramei/baas-tauri/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/Kiramei/baas-tauri/releases/latest";

const platformOrder: Platform[] = ["windows", "macos", "linux"];

const copy: Record<Locale, Copy> = {
  zh: {
    title: "下载 BAAS Tauri",
    compactTitle: "获取客户端",
    description: "已根据你的系统优先选择推荐安装包；也可以手动切换系统和包类型。",
    open: "打开 Releases",
    loading: "正在读取最新版本...",
    fallback: "无法自动读取 GitHub 最新版本时，请打开 Releases 页面手动选择安装包。",
    latest: "最新版本",
    detected: "已检测",
    chooseSystem: "系统",
    choosePackage: "安装包",
    download: "下载",
    otherSystem: "不是这个系统？",
    empty: "当前最新 Release 没有可展示的安装包资产。",
    platforms: {
      windows: "Windows",
      macos: "macOS",
      linux: "Linux",
    },
  },
  en: {
    title: "Download BAAS Tauri",
    compactTitle: "Get the client",
    description: "The recommended package is selected from your system. You can switch OS and package type manually.",
    open: "Open Releases",
    loading: "Loading latest release...",
    fallback: "If the latest release cannot be loaded automatically, open Releases and choose the package manually.",
    latest: "Latest version",
    detected: "Detected",
    chooseSystem: "System",
    choosePackage: "Package",
    download: "Download",
    otherSystem: "Need another system?",
    empty: "The latest release does not expose downloadable installer assets.",
    platforms: {
      windows: "Windows",
      macos: "macOS",
      linux: "Linux",
    },
  },
};

function WindowsLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5.2 10.7 4v7.5H3V5.2Zm9-.3L21 3.5v8h-9V4.9ZM3 12.8h7.7V20L3 18.8v-6Zm9 0h9v7.7l-9-1.4v-6.3Z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16.5 2.5c.1 1.2-.4 2.4-1.2 3.2-.8.9-2.1 1.5-3.2 1.4-.1-1.2.4-2.4 1.2-3.2.9-.9 2.2-1.5 3.2-1.4Zm3.8 15.9c-.6 1.4-.9 2-1.7 3.2-1.1 1.6-2.6 1.8-3.1 1.8-.7 0-1.4-.5-2.3-.5s-1.7.5-2.4.5c-.6 0-2-.2-3.1-1.7-2.1-2.9-3.8-8.1-1.6-11.6 1.1-1.8 3-2.9 5-2.9.8 0 1.6.5 2.2.5.7 0 1.8-.6 3.1-.5.5 0 2.2.2 3.3 1.8-2.9 1.6-2.4 5.7.6 6.8-.2.6-.4 1-.5 1.3Z" />
    </svg>
  );
}

function LinuxLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.1 2.2c2.3 0 3.8 2.2 3.8 5.2 0 1.5.6 2.7 1.3 3.8.8 1.2 1.7 2.5 1.7 4.6 0 3.5-2.8 6-6.8 6s-6.9-2.5-6.9-6c0-2.1.9-3.4 1.7-4.6.7-1.1 1.3-2.3 1.3-3.8 0-3 1.5-5.2 3.9-5.2Zm-2.2 9.9c-.9.7-1.9 2.2-2.1 3.8-.2 1.8 1.4 3.2 4.3 3.2 2.8 0 4.5-1.4 4.3-3.2-.2-1.6-1.2-3.1-2.1-3.8-.6.6-1.3.9-2.2.9-.9 0-1.6-.3-2.2-.9ZM10 7.1c-.5 0-.9.5-.9 1s.4 1 .9 1 .9-.4.9-1-.4-1-.9-1Zm4.2 0c-.5 0-.9.5-.9 1s.4 1 .9 1 .9-.4.9-1-.4-1-.9-1Z" />
    </svg>
  );
}

function PlatformLogo({ platform }: { platform: Platform }) {
  if (platform === "windows") return <WindowsLogo />;
  if (platform === "macos") return <AppleLogo />;
  return <LinuxLogo />;
}

function formatSize(size: number) {
  if (!size) return "";
  const mb = size / 1024 / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function detectEnvironment(): { platform: Platform; arch: Architecture } {
  if (typeof window === "undefined") return { platform: "windows", arch: "x64" };

  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const rawPlatform = `${nav.userAgentData?.platform ?? navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  const rawArch = `${navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();

  let platform: Platform = "windows";
  if (rawPlatform.includes("mac")) platform = "macos";
  else if (rawPlatform.includes("linux") || rawPlatform.includes("x11")) platform = "linux";
  else if (rawPlatform.includes("win")) platform = "windows";

  let arch: Architecture = "x64";
  if (rawArch.includes("arm64") || rawArch.includes("aarch64")) arch = "arm64";
  else if (rawArch.includes("armv7") || rawArch.includes("armhf")) arch = "arm32";
  else if (rawArch.includes("x86_64") || rawArch.includes("x64") || rawArch.includes("win64") || rawArch.includes("amd64")) arch = "x64";

  return { platform, arch };
}

function classifyAsset(asset: ReleaseAsset, locale: Locale): DownloadItem | null {
  const lower = asset.name.toLowerCase();
  if (lower.endsWith(".sig") || lower.endsWith(".app.tar.gz") || lower.endsWith(".nsis.zip")) return null;

  const zh = locale === "zh";
  let platform: Platform | null = null;
  let kind: DownloadItem["kind"] | null = null;
  let arch: Architecture = "unknown";
  let label = asset.name;

  if (lower.includes("fixed_webview2_portable") && lower.endsWith(".zip")) {
    platform = "windows";
    kind = "portable";
    arch = lower.includes("arm64") ? "arm64" : "x64";
    label = zh
      ? `Windows ${arch === "arm64" ? "ARM64" : "x64"} 固定 WebView2 便携版`
      : `Windows ${arch === "arm64" ? "ARM64" : "x64"} fixed WebView2 portable`;
  } else if (lower.includes("fixed_webview2-setup") && lower.endsWith(".exe")) {
    platform = "windows";
    kind = "fixed-webview2";
    arch = lower.includes("arm64") ? "arm64" : "x64";
    label = zh
      ? `Windows ${arch === "arm64" ? "ARM64" : "x64"} 固定 WebView2 安装包`
      : `Windows ${arch === "arm64" ? "ARM64" : "x64"} fixed WebView2 installer`;
  } else if (lower.endsWith("-setup.exe")) {
    platform = "windows";
    kind = "installer";
    arch = lower.includes("arm64") ? "arm64" : "x64";
    label = zh ? `Windows ${arch === "arm64" ? "ARM64" : "x64"} 安装包` : `Windows ${arch === "arm64" ? "ARM64" : "x64"} installer`;
  } else if (lower.endsWith(".dmg")) {
    platform = "macos";
    kind = "dmg";
    arch = lower.includes("aarch64") ? "arm64" : "x64";
    label = arch === "arm64" ? "macOS Apple Silicon DMG" : "macOS Intel DMG";
  } else if (lower.endsWith(".deb")) {
    platform = "linux";
    kind = "deb";
    arch = lower.includes("armhf") ? "arm32" : lower.includes("arm64") ? "arm64" : "x64";
    label = zh
      ? `Linux ${arch === "arm64" ? "ARM64" : arch === "arm32" ? "armhf" : "amd64"} DEB`
      : `Linux ${arch === "arm64" ? "ARM64" : arch === "arm32" ? "armhf" : "amd64"} DEB`;
  } else if (lower.endsWith(".rpm")) {
    platform = "linux";
    kind = "rpm";
    arch = lower.includes("armv7hl") ? "arm32" : lower.includes("aarch64") ? "arm64" : "x64";
    label = `Linux ${arch === "arm64" ? "aarch64" : arch === "arm32" ? "armv7hl" : "x86_64"} RPM`;
  }

  if (!platform || !kind) return null;

  return {
    name: asset.name,
    href: asset.browser_download_url,
    size: asset.size,
    platform,
    label,
    kind,
    arch,
  };
}

function itemRank(item: DownloadItem, desiredArch: Architecture) {
  let score = 0;
  if (item.arch === desiredArch) score -= 40;
  if (item.arch === "x64" && desiredArch === "unknown") score -= 20;

  if (item.platform === "windows") {
    if (item.kind === "installer") score += 0;
    else if (item.kind === "fixed-webview2") score += 10;
    else score += 20;
  } else if (item.platform === "macos") {
    score += item.kind === "dmg" ? 0 : 20;
  } else {
    score += item.kind === "deb" ? 0 : 10;
  }

  return score;
}

function sortItems(a: DownloadItem, b: DownloadItem) {
  return platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform) || a.label.localeCompare(b.label);
}

function DownloadDropdown({
  className = "",
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  value: string;
}) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div ref={ref} className={`baas-download-select ${className}`}>
      <span className="baas-download-select-label">{label}</span>
      <button
        type="button"
        className="baas-download-select-button"
        aria-controls={`baas-download-menu-${id}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div id={`baas-download-menu-${id}`} className="baas-download-select-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="baas-download-select-option"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReleaseDownloadPanel({
  locale = "en",
  compact = false,
}: {
  locale?: Locale;
  compact?: boolean;
}) {
  const t = copy[locale];
  const [release, setRelease] = useState<ReleaseResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [detected, setDetected] = useState<{ platform: Platform; arch: Architecture }>({
    platform: "windows",
    arch: "x64",
  });
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>("windows");
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    const environment = detectEnvironment();
    setDetected(environment);
    setSelectedPlatform(environment.platform);
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        return response.json() as Promise<ReleaseResponse>;
      })
      .then((data) => {
        if (!cancelled) setRelease(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const downloads = useMemo(
    () =>
      release?.assets
        .map((asset) => classifyAsset(asset, locale))
        .filter((item): item is DownloadItem => Boolean(item))
        .sort(sortItems) ?? [],
    [locale, release],
  );

  const availablePlatforms = useMemo(
    () => platformOrder.filter((platform) => downloads.some((item) => item.platform === platform)),
    [downloads],
  );

  useEffect(() => {
    if (downloads.length === 0) return;
    if (!downloads.some((item) => item.platform === selectedPlatform)) {
      setSelectedPlatform(availablePlatforms[0] ?? "windows");
    }
  }, [availablePlatforms, downloads, selectedPlatform]);

  const platformItems = useMemo(
    () => downloads.filter((item) => item.platform === selectedPlatform).sort((a, b) => itemRank(a, detected.arch) - itemRank(b, detected.arch)),
    [detected.arch, downloads, selectedPlatform],
  );

  useEffect(() => {
    if (platformItems.length === 0) {
      setSelectedName("");
      return;
    }
    if (!platformItems.some((item) => item.name === selectedName)) {
      setSelectedName(platformItems[0].name);
    }
  }, [platformItems, selectedName]);

  const selectedItem = platformItems.find((item) => item.name === selectedName) ?? platformItems[0];
  const isDetectedPlatform = selectedPlatform === detected.platform;

  return (
    <section className={`baas-download-panel${compact ? " baas-download-panel-compact" : ""}`} aria-labelledby="baas-download-title">
      <div className="baas-download-head">
        <div>
          <p className="baas-download-kicker">
            <MonitorDown aria-hidden="true" />
            {release ? `${t.latest} ${release.tag_name}` : t.title}
          </p>
          <h2 id="baas-download-title">{compact ? t.compactTitle : t.title}</h2>
          {!compact ? <p>{failed ? t.fallback : t.description}</p> : null}
        </div>
        <a href={release?.html_url ?? REPO_RELEASES} target="_blank" rel="noreferrer">
          {t.open}
          <ExternalLink aria-hidden="true" />
        </a>
      </div>

      {!release && !failed ? <p className="baas-download-state">{t.loading}</p> : null}
      {release && downloads.length === 0 ? <p className="baas-download-state">{t.empty}</p> : null}

      {selectedItem ? (
        <div className="baas-download-picker">
          <div className="baas-download-platform-card">
            <div className="baas-download-platform-logo">
              <PlatformLogo platform={selectedPlatform} />
            </div>
            <div>
              <span>{isDetectedPlatform ? `${t.detected} ${t.platforms[selectedPlatform]}` : t.platforms[selectedPlatform]}</span>
              <strong>{selectedItem.label}</strong>
              <small>{formatSize(selectedItem.size)}</small>
            </div>
          </div>

          <DownloadDropdown
            label={t.chooseSystem}
            value={selectedPlatform}
            options={availablePlatforms.map((platform) => ({
              label: t.platforms[platform],
              value: platform,
            }))}
            onChange={(value) => setSelectedPlatform(value as Platform)}
          />

          <DownloadDropdown
            className="baas-download-package-select"
            label={t.choosePackage}
            value={selectedItem.name}
            options={platformItems.map((item) => ({
              label: `${item.label} · ${formatSize(item.size)}`,
              value: item.name,
            }))}
            onChange={setSelectedName}
          />

          <a className="baas-download-primary" href={selectedItem.href}>
            <Download aria-hidden="true" />
            <span>{t.download}</span>
          </a>
        </div>
      ) : null}
    </section>
  );
}
