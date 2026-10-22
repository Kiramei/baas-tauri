"use client";

import { useState } from "react";
import data from "@/public/benchmarks/frontend-current.json";

export function BenchmarkChart({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const [metric, setMetric] = useState<"p50Ms" | "p95Ms">("p50Ms");
  const groups = data.encoding.map((result) => ({
    label: `${result.payloadBytes / 1024} KiB`,
    before: result.legacy[metric],
    after: result.raw[metric],
  }));
  return (
    <figure className="baas-benchmark baas-encoding-benchmark">
      <figcaption>
        {zh
          ? "二进制请求编码耗时（毫秒，越低越好）"
          : "Binary request encoding (ms, lower is better)"}
      </figcaption>
      <div role="group" aria-label={zh ? "统计量" : "Statistic"} className="baas-chart-controls">
        {(["p50Ms", "p95Ms"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={metric === value}
            onClick={() => setMetric(value)}
          >
            {value === "p50Ms" ? "p50" : "p95"}
          </button>
        ))}
      </div>
      {groups.map((group) => {
        const maximum = Math.max(group.before, group.after);
        return (
          <div className="baas-benchmark-group" key={group.label}>
            <strong>{group.label}</strong>
            {[
              { name: "JSON", value: group.before, kind: "before" },
              { name: "Raw", value: group.after, kind: "after" },
            ].map((row) => (
              <div className="baas-benchmark-row" key={row.kind}>
                <span>{row.name}</span>
                <div className="baas-benchmark-track" aria-hidden="true">
                  <div data-kind={row.kind} style={{ width: `${(row.value / maximum) * 100}%` }} />
                </div>
                <output>{row.value.toFixed(4)} ms</output>
              </div>
            ))}
          </div>
        );
      })}
      <p>
        {zh
          ? "每个负载组使用独立线性横轴，起点为 0；数值标签为准。每种方法 100 次测量，5 次预热。不含真实 IPC 或游戏。"
          : "Each payload group has its own linear axis starting at zero; use the numeric labels. 100 samples per method after 5 warm-ups. Excludes real IPC and the game."}
      </p>
      <table>
        <caption>
          {zh
            ? "日志状态准备：10,000 行，15 轮，中位数"
            : "Log store preparation: 10,000 rows, 15 rounds, median"}
        </caption>
        <thead>
          <tr>
            <th>{zh ? "方法" : "Method"}</th>
            <th>ms</th>
            <th>{zh ? "状态通知次数" : "Store notifications"}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{zh ? "逐行" : "Per row"}</td>
            <td>{data.logBatching.before.medianMs.toFixed(3)}</td>
            <td>{data.logBatching.before.notifications}</td>
          </tr>
          <tr>
            <td>{zh ? "批量（256 行）" : "Batched (256 rows)"}</td>
            <td>{data.logBatching.after.medianMs.toFixed(3)}</td>
            <td>{data.logBatching.after.notifications}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}
