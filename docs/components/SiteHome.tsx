"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Languages } from "lucide-react";
import type { Locale } from "@/lib/i18n";

const content = {
  zh: {
    langName: "中文",
    docsLabel: "阅读中文文档",
    otherDocsLabel: "Read English Docs",
    otherLocale: "en" as const,
    heroAlt: "BAAS Tauri 深色主页，显示任务状态、日志和运行控制",
    kicker: "Blue Archive Auto Script",
    title: "BAAS Tauri 文档",
    description:
      "面向 BAAS 桌面客户端的现代化文档入口：安装、配置档、调度、功能配置、远程模拟器画面、更新、故障排查和开发说明。",
    download: "下载客户端",
    lightMode: "☀️ 浅色模式",
    darkMode: "🌙 深色模式",
    scope: [
      ["🧭 客户端指南", "安装、连接、创建配置档，并理解桌面端界面。"],
      ["🧩 功能参考", "每个自动化功能都作为独立页面维护。"],
      ["🛠️ 维护排查", "更新、SHA 测试、故障排查和开发工作流。"],
    ],
    mapKicker: "从这里开始",
    mapTitle: "选择你的阅读路径",
    links: [
      ["安装", "/docs/zh/guide/install", "后端启动、配置档创建和首次连接。"],
      ["界面", "/docs/zh/guide/interface", "主页、调度、功能配置、设置和文档窗口。"],
      ["调度", "/docs/zh/guide/scheduler", "任务启用、下次运行时间、依赖和间隔。"],
      ["功能", "/docs/zh/features/server", "服务器、模拟器、PC 客户端、脚本、推图、扫荡、编队、咖啡厅、商店和战斗。"],
      ["故障排查", "/docs/zh/reference/troubleshooting", "日志、ADB、截图、远程画面、更新和路由检查。"],
      ["后端参考", "/docs/zh/reference/backend-service", "Service 模式、setup.toml、CLI、自动战斗、识别和开发说明。"],
      ["开发", "/docs/zh/reference/development", "文档维护、部署 workflow 和项目说明。"],
    ],
  },
  en: {
    langName: "English",
    docsLabel: "Read English Docs",
    otherDocsLabel: "阅读中文文档",
    otherLocale: "zh" as const,
    heroAlt: "BAAS Tauri home page in dark mode",
    kicker: "Blue Archive Auto Script",
    title: "BAAS Tauri Documentation",
    description:
      "A modern documentation portal for the BAAS desktop client: installation, profiles, scheduler, feature configuration, remote emulator display, updates, troubleshooting, and development notes.",
    download: "Download",
    lightMode: "☀️ Light Mode",
    darkMode: "🌙 Dark Mode",
    scope: [
      ["🧭 Client Guide", "Install, connect, create profiles, and understand the desktop UI."],
      ["🧩 Feature Reference", "Each automation feature is documented as an independent page."],
      ["🛠️ Maintenance", "Updates, SHA tests, troubleshooting, and development workflows."],
    ],
    mapKicker: "Start here",
    mapTitle: "Choose a documentation path",
    links: [
      ["Install", "/docs/en/guide/install", "Backend startup, profile creation, and first connection."],
      ["Interface", "/docs/en/guide/interface", "Home, scheduler, configuration, settings, and docs window."],
      ["Scheduler", "/docs/en/guide/scheduler", "Task enablement, next run time, dependencies, and intervals."],
      ["Features", "/docs/en/features/server", "Server, emulator, PC client, script, stages, sweeps, teams, cafe, shop, and combat."],
      ["Troubleshooting", "/docs/en/reference/troubleshooting", "Logs, ADB, screenshots, remote display, updates, and route checks."],
      ["Backend Reference", "/docs/en/reference/backend-service", "Service mode, setup.toml, CLI, auto fight, recognition, and development notes."],
      ["Development", "/docs/en/reference/development", "Docs maintenance, deployment workflow, and project notes."],
    ],
  },
};

export function SiteHome() {
  const [locale, setLocale] = useState<Locale>("zh");
  const t = content[locale];
  const assetLocale = locale === "zh" ? "cn" : "en";

  useEffect(() => {
    const saved = window.localStorage.getItem("baas-doc-home-locale");
    if (saved === "zh" || saved === "en") {
      setLocale(saved);
      return;
    }

    setLocale(window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
  }, []);

  function chooseLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem("baas-doc-home-locale", nextLocale);
  }

  return (
    <main className="baas-site-home" lang={locale}>
      <section className="baas-site-hero" aria-label="BAAS documentation home">
        <img
          className="baas-site-hero-bg"
          src={`/${assetLocale}/home-dark-logs.png`}
          alt={t.heroAlt}
        />
        <div className="baas-site-hero-scrim" />

        <nav className="baas-site-nav" aria-label="Home navigation">
          <Link className="baas-site-brand" href="/">
            <img src="/baas-icon.png" alt="" />
            <span>BAAS Docs</span>
          </Link>
          <div className="baas-site-nav-controls">
            <div className="baas-site-language-toggle" aria-label="Homepage language">
              <Languages aria-hidden="true" />
              <button
                type="button"
                aria-pressed={locale === "zh"}
                onClick={() => chooseLocale("zh")}
              >
                中文
              </button>
              <button
                type="button"
                aria-pressed={locale === "en"}
                onClick={() => chooseLocale("en")}
              >
                English
              </button>
            </div>
          </div>
        </nav>

        <div className="baas-site-hero-copy">
          <p className="baas-site-kicker">{t.kicker}</p>
          <h1>
            {locale === "zh" ? (
              <>
                <span>BAAS Tauri</span>{" "}
                <span className="baas-site-title-keep">文档</span>
              </>
            ) : (
              t.title
            )}
          </h1>
          <p>{t.description}</p>
          <div className="baas-site-actions">
            <Link href={`/docs/${locale}`}>{t.docsLabel}</Link>
            <Link href={`/docs/${t.otherLocale}`}>{t.otherDocsLabel}</Link>
            <Link href={`/docs/${locale}/guide/install#download`}>
              {t.download}
            </Link>
          </div>
        </div>
      </section>

      <section className="baas-site-preview" aria-label="Application previews">
        <div>
          <p>{t.lightMode}</p>
          <img src={`/${assetLocale}/home-light-logs.png`} alt={locale === "zh" ? "BAAS Tauri 浅色主页" : "BAAS Tauri home page in light mode"} />
        </div>
        <div>
          <p>{t.darkMode}</p>
          <img src={`/${assetLocale}/home-dark-logs.png`} alt={locale === "zh" ? "BAAS Tauri 深色主页" : "BAAS Tauri home page in dark mode"} />
        </div>
      </section>

      <section className="baas-site-band" aria-label="Documentation scope">
        {t.scope.map(([title, body]) => (
          <div key={title}>
            <strong>{title}</strong>
            <span>{body}</span>
          </div>
        ))}
      </section>

      <section className="baas-site-map" aria-labelledby="baas-site-map-title">
        <div className="baas-site-section-head">
          <p>{t.mapKicker}</p>
          <h2 id="baas-site-map-title">{t.mapTitle}</h2>
        </div>
        <div className="baas-site-card-grid">
          {t.links.map(([title, href, body]) => (
            <Link key={href} href={href}>
              <strong>{title}</strong>
              <span>{body}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
