"use client";

import { useState } from "react";
import data from "@/public/benchmarks/native-payload-summary.json";

export function NativePayloadBenchmark({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const [payloadBytes, setPayloadBytes] = useState(1048576);
  const [metric, setMetric] = useState<"p50Ms" | "p95Ms">("p50Ms");
  const rows = data.results.filter((row) => row.payloadBytes === payloadBytes);
  const maximum = Math.max(...rows.map((row) => row[metric]));
  const decodedBytes = rows[0].decodedConfigJsonBytes;
  const label = (mode: string) =>
    mode === "websocket" ? "WebSocket" : mode === "pipe" ? "Pipe" : zh ? "共享内存" : "SHM";
  return (
    <figure className="baas-benchmark baas-transport-benchmark baas-payload-benchmark">
      <figcaption>
        {zh
          ? "完整配置快照到达 Store（毫秒，越低越好）"
          : "Full config snapshot received by Store (ms, lower is better)"}
      </figcaption>
      <div className="baas-device-controls">
        <label>
          {zh ? "合成字段大小" : "Synthetic field size"}{" "}
          <select
            aria-label={zh ? "合成字段大小" : "Synthetic field size"}
            value={payloadBytes}
            onChange={(event) => setPayloadBytes(Number(event.target.value))}
          >
            <option value={1024}>1 KiB</option>
            <option value={65536}>64 KiB</option>
            <option value={1048576}>1 MiB</option>
          </select>
        </label>
        <div
          role="group"
          aria-label={zh ? "快照统计量" : "Snapshot statistic"}
          className="baas-chart-controls"
        >
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
      </div>
      <div aria-live="polite">
        {rows.map((row) => (
          <div className="baas-benchmark-row" key={row.mode} data-mode={row.mode}>
            <span>{label(row.mode)}</span>
            <div className="baas-benchmark-track" aria-hidden="true">
              <div data-kind={row.mode} style={{ width: `${(row[metric] / maximum) * 100}%` }} />
            </div>
            <output aria-label={`${label(row.mode)} ${metric === "p50Ms" ? "p50" : "p95"}`}>
              {row[metric].toFixed(1)} ms
            </output>
          </div>
        ))}
      </div>
      <p>
        {zh
          ? `完整配置的紧凑 JSON 为 ${decodedBytes.toLocaleString("en-US")} 个 UTF-8 字节。每种方式 600 次正式测量、120 次预热；共同线性横轴从 0 开始。`
          : `The full compact config JSON contains ${decodedBytes.toLocaleString("en-US")} UTF-8 bytes. Each mode has 600 measurements and 120 warm-ups; one shared linear axis starts at zero.`}
      </p>
      <div className="baas-benchmark-table-scroll">
        <table>
          <caption>
            {zh
              ? "连续 20 次调用的分块均值，含完整内容校验与循环开销；每种方式 30 块"
              : "Block mean of 20 consecutive calls, including full-content validation and loop overhead; 30 blocks per mode"}
          </caption>
          <thead>
            <tr>
              <th>{zh ? "方式" : "Mode"}</th>
              <th>{zh ? "请求数" : "Calls"}</th>
              <th>{zh ? "失败" : "Failures"}</th>
              <th>{zh ? "均值 / ms" : "Mean / ms"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mode}>
                <td>{label(row.mode)}</td>
                <td>{row.count}</td>
                <td>{row.failedAttempts}</td>
                <td>{row.blockMeans.meanMs.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
