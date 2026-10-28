"use client";

import { useId, useState } from "react";
import data from "@/evidence/device-summary.json";

export function DeviceBenchmark({
  locale,
  kind,
}: {
  locale: "zh" | "en";
  kind: "capture" | "control";
}) {
  const zh = locale === "zh";
  const capture = kind === "capture";
  const id = useId();
  const [scenario, setScenario] = useState(capture ? "static" : "click");
  const [endpoint, setEndpoint] = useState<"api" | "visible">("api");
  const [metric, setMetric] = useState<"p50Ms" | "p95Ms">("p50Ms");
  const rows = data.results[kind].filter((result) => result.scenario === scenario);
  const timing = (row: (typeof rows)[number]) =>
    endpoint === "visible" && "visible" in row ? row.visible : row.api;
  const maximum = Math.max(1, ...rows.map((row) => timing(row)?.[metric] ?? 0));
  const labels: Record<string, string> = {
    static: zh ? "静态画面" : "Static scene",
    animated: zh ? "运动纹理" : "Animated texture",
    click: zh ? "点击" : "Click",
    swipe: zh ? "滑动（请求 400 px）" : "Swipe (400 px request)",
    long_click: zh ? "长按（请求 300 ms）" : "Press (300 ms request)",
    adb: "ADB",
    uiautomator2: "uiautomator2",
    scrcpy: "Scrcpy",
    nemu: "Nemu",
  };
  return (
    <figure className={`baas-benchmark baas-device-benchmark baas-device-${kind}`}>
      <figcaption>
        {capture
          ? zh
            ? "截图适配器耗时（毫秒）"
            : "Screenshot adapter latency (ms)"
          : zh
            ? "输入适配器耗时（毫秒）"
            : "Input adapter latency (ms)"}
      </figcaption>
      <div className="baas-device-controls">
        <label htmlFor={id}>{zh ? "场景" : "Scenario"}</label>
        <select id={id} value={scenario} onChange={(event) => setScenario(event.target.value)}>
          {(capture ? ["static", "animated"] : ["click", "swipe", "long_click"]).map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
        <div className="baas-chart-controls" role="group" aria-label={zh ? "统计量" : "Statistic"}>
          {(["p50Ms", "p95Ms"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {value === "p50Ms" ? "p50" : "p95"}
            </button>
          ))}
        </div>
      </div>
      {!capture && (
        <div
          className="baas-chart-controls"
          role="group"
          aria-label={zh ? "计时终点" : "Timing endpoint"}
        >
          {(["api", "visible"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={endpoint === value}
              onClick={() => setEndpoint(value)}
            >
              {value === "api"
                ? zh
                  ? "接口返回"
                  : "API return"
                : zh
                  ? "画面确认"
                  : "Visible response"}
            </button>
          ))}
        </div>
      )}
      {rows.map((row) => (
        <div className="baas-benchmark-row" key={row.method}>
          <span>{labels[row.method]}</span>
          <div className="baas-benchmark-track" aria-hidden="true">
            <div
              data-kind={row.method}
              style={{ width: `${((timing(row)?.[metric] ?? 0) / maximum) * 100}%` }}
            />
          </div>
          <output>
            {timing(row)
              ? timing(row)![metric].toFixed(1) + " ms"
              : zh
                ? "无有效结果"
                : "No valid result"}
          </output>
        </div>
      ))}
      <p>
        {zh
          ? "共同线性横轴从 0 开始；有效样本不删异常值。"
          : "One shared linear axis starts at zero; no outlier removal from valid samples."}
      </p>
      <div className="baas-benchmark-table-scroll">
        <table>
          <caption>
            {capture
              ? zh
                ? "每种方式 100 次正式采样；重复帧按连续帧编号统计；MSE 为静态纹理区域的平均像素误差"
                : "100 measured calls per method; repeated frame counters and mean pixel MSE in the static texture region"
              : zh
                ? "每种方式 48 次正式采样；按压时长和位移来自测试程序收到的输入事件"
                : "48 measured calls per method; press duration and travel come from input events received by the target"}
          </caption>
          <thead>
            <tr>
              <th>{zh ? "方式" : "Method"}</th>
              <th>{zh ? "成功 / 失败" : "Valid / failed"}</th>
              <th>
                {capture
                  ? zh
                    ? "重复帧"
                    : "Repeated frames"
                  : zh
                    ? "按压 p50 / ms"
                    : "Press p50 / ms"}
              </th>
              <th>{capture ? "MSE" : zh ? "位移 p50 / px" : "Travel p50 / px"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.method}>
                <td>{labels[row.method]}</td>
                <td>
                  {row.succeeded} / {row.failed}
                </td>
                <td>
                  {"duplicateFrames" in row
                    ? row.duplicateFrames
                    : row.pressDuration?.p50Ms.toFixed(0)}
                </td>
                <td>
                  {"qualityMeanMse" in row
                    ? row.qualityMeanMse?.toFixed(2)
                    : row.travelPixels?.p50.toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
