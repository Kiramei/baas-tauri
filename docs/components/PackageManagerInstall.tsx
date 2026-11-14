"use client";

import { useState } from "react";
import { Check, Clipboard, Terminal } from "lucide-react";
import {
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";
import styles from "./PackageManagerInstall.module.css";

const packageManagers = [
  { id: "npm", label: "npm", command: "npm install -g @kiramei/baasx" },
  { id: "pnpm", label: "pnpm", command: "pnpm add -g @kiramei/baasx" },
  { id: "yarn", label: "yarn", command: "yarn global add @kiramei/baasx" },
  { id: "bun", label: "bun", command: "bun add -g baasx" },
  { id: "cnpm", label: "cnpm", command: "cnpm install -g @kiramei/baasx" },
  { id: "deno", label: "deno", command: "deno install -g -A npm:@kiramei/baasx" },
] as const;

type ManagerId = (typeof packageManagers)[number]["id"];

export function PackageManagerInstall({ locale }: { locale: "zh" | "en" }) {
  const [selected, setSelected] = useState<ManagerId>("npm");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const command = packageManagers.find((manager) => manager.id === selected)!.command;
  const copyLabel = locale === "zh" ? "复制命令" : "Copy command";
  const statusText =
    copyStatus === "copied"
      ? locale === "zh"
        ? "已复制"
        : "Copied"
      : copyStatus === "failed"
        ? locale === "zh"
          ? "复制失败"
          : "Copy failed"
        : "";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <CodeBlockTabs
      value={selected}
      onValueChange={(value) => {
        setSelected(value as ManagerId);
        setCopyStatus("idle");
      }}
      className={styles.container}
    >
      <div className={styles.header}>
        <Terminal aria-hidden="true" className={styles.terminal} size={17} />
        <CodeBlockTabsList
          aria-label={locale === "zh" ? "包管理器" : "Package manager"}
          className={styles.list}
        >
          {packageManagers.map((manager) => (
            <CodeBlockTabsTrigger key={manager.id} value={manager.id}>
              {manager.label}
            </CodeBlockTabsTrigger>
          ))}
        </CodeBlockTabsList>
        <button
          type="button"
          className={styles.copy}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyCommand}
        >
          {copyStatus === "copied" ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Clipboard aria-hidden="true" size={16} />
          )}
        </button>
        <span className={styles.srOnly} role="status">
          {statusText}
        </span>
      </div>
      {packageManagers.map((manager) => (
        <CodeBlockTab key={manager.id} value={manager.id}>
          <pre className={styles.code}>
            <code>{manager.command}</code>
          </pre>
        </CodeBlockTab>
      ))}
    </CodeBlockTabs>
  );
}
