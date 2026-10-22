"use client";

import { useState } from "react";
import data from "@/public/benchmarks/native-transport-current.json";

export function NativeTransportBenchmark({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const [metric, setMetric] = useState<"p50Ms" | "p95Ms">("p50Ms");
  const maximum = Math.max(...data.results.map((result) => result[metric]));
  const label = (mode: string) =>
    mode === "websocket" ? "WebSocket" : mode === "pipe" ? "Pipe" : zh ? "共享内存" : "SHM";
  return (
    <figure className="baas-benchmark baas-transport-benchmark">
      <figcaption>
        {zh
          ? "原生客户端状态命令往返（毫秒，越低越好）"
          : "Native client status-command round trip (ms, lower is better)"}
      </figcaption>
      <div
        role="group"
        aria-label={zh ? "传输统计量" : "Transport statistic"}
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
      {data.results.map((result) => (
        <div className="baas-benchmark-row" key={result.mode}>
          <span>{label(result.mode)}</span>
          <div className="baas-benchmark-track" aria-hidden="true">
            <div
              data-kind={result.mode}
              style={{ width: `${(result[metric] / maximum) * 100}%` }}
            />
          </div>
          <output>{result[metric].toFixed(1)} ms</output>
        </div>
      ))}
      <p>
        {zh
          ? "共同线性横轴从 0 开始。每种方式 6 轮，每轮 50 次预热、300 次测量；每次只有一个未完成请求。WebSocket 使用产品认证与加密。"
          : "One shared linear axis starts at zero. Six rounds per mode, each with 50 warm-ups and 300 measurements; one outstanding request. WebSocket uses product authentication and encryption."}
      </p>
      <table>
        <caption>
          {zh
            ? "连续 50 次调用的分块均值，含回调校验与循环开销；每种方式 36 块"
            : "Block mean of 50 consecutive calls, including callback validation and loop overhead; 36 blocks per mode"}
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
          {data.results.map((result) => (
            <tr key={result.mode}>
              <td>{label(result.mode)}</td>
              <td>{result.count}</td>
              <td>{result.failedAttempts}</td>
              <td>{result.blockMeans.meanMs.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
