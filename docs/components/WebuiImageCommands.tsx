"use client";

import { useState } from "react";
import { Check, Clipboard, Terminal } from "lucide-react";
import {
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";
import codeStyles from "./PackageManagerInstall.module.css";
import styles from "./WebuiImageCommands.module.css";

const images = {
  ghcr: "ghcr.io/kiramei/baas-webui:latest",
  dockerhub: "docker.io/kiramei/baas-webui:latest",
} as const;

type Registry = keyof typeof images;
type Engine = "docker" | "podman";
type CopyTarget = "pull" | "run";

export function WebuiImageCommands({ locale }: { locale: "zh" | "en" }) {
  const [registry, setRegistry] = useState<Registry>("ghcr");
  const [engine, setEngine] = useState<Engine>("docker");
  const [copyStatus, setCopyStatus] = useState<{ target: CopyTarget; success: boolean }>();
  const image = images[registry];
  const pull = `${engine} pull ${image}`;
  const hostMapping =
    engine === "docker" ? "  --add-host host.docker.internal:host-gateway \\\n" : "";
  const run = `${engine} run -d --name baas-webui --restart unless-stopped \\\n  -p 127.0.0.1:8191:8191 \\\n${hostMapping}  -v baas-webui-data:/app \\\n  ${image} https://github.com/Kiramei/baas-dev.git`;
  const text = (zh: string, en: string) => (locale === "zh" ? zh : en);

  async function copyCommand(target: CopyTarget) {
    try {
      await navigator.clipboard.writeText(target === "pull" ? pull : run);
      setCopyStatus({ target, success: true });
    } catch {
      setCopyStatus({ target, success: false });
    }
  }

  const copyButton = (target: CopyTarget) => {
    const label =
      target === "pull"
        ? text("复制拉取命令", "Copy pull command")
        : text("复制启动命令", "Copy run command");
    const status =
      copyStatus?.target === target
        ? copyStatus.success
          ? text("已复制", "Copied")
          : text("复制失败", "Copy failed")
        : "";
    return (
      <>
        <button
          type="button"
          className={codeStyles.copy}
          aria-label={label}
          title={label}
          onClick={() => void copyCommand(target)}
        >
          {copyStatus?.target === target && copyStatus.success ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Clipboard aria-hidden="true" size={16} />
          )}
        </button>
        <span className={codeStyles.srOnly} role="status">
          {status}
        </span>
      </>
    );
  };

  return (
    <CodeBlockTabs
      value={registry}
      onValueChange={(value) => {
        setRegistry(value as Registry);
        setCopyStatus(undefined);
      }}
      className={codeStyles.container}
    >
      <div className={codeStyles.header}>
        <Terminal aria-hidden="true" className={codeStyles.terminal} size={17} />
        <CodeBlockTabsList
          aria-label={text("镜像来源", "Image registry")}
          className={codeStyles.list}
        >
          <CodeBlockTabsTrigger value="ghcr">GHCR</CodeBlockTabsTrigger>
          <CodeBlockTabsTrigger value="dockerhub">Docker Hub</CodeBlockTabsTrigger>
        </CodeBlockTabsList>
        <select
          aria-label={text("容器工具", "Container engine")}
          className={styles.engine}
          value={engine}
          onChange={(event) => {
            setEngine(event.target.value as Engine);
            setCopyStatus(undefined);
          }}
        >
          <option value="docker">Docker</option>
          <option value="podman">Podman</option>
        </select>
        {copyButton("pull")}
      </div>
      {(Object.keys(images) as Registry[]).map((name) => (
        <CodeBlockTab key={name} value={name}>
          <pre className={codeStyles.code}>
            <code>{pull}</code>
          </pre>
          <div className={styles.runHeader}>
            <span>{text("启动容器", "Start container")}</span>
            {copyButton("run")}
          </div>
          <pre className={codeStyles.code}>
            <code>{run}</code>
          </pre>
        </CodeBlockTab>
      ))}
    </CodeBlockTabs>
  );
}
