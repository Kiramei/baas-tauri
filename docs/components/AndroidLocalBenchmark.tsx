"use client";

import { useId, useState } from "react";
import data from "@/public/benchmarks/android-local-summary.json";

export function AndroidLocalBenchmark({
  locale,
  kind,
}: {
  locale: "zh" | "en";
  kind: "capture" | "control";
}) {
  const zh = locale === "zh";
  const capture = kind === "capture";
  const id = useId();
  const [scenario, setScenario] = useState("static");
  const [endpoint, setEndpoint] = useState<"api" | "confirmed">("api");
  const [metric, setMetric] = useState<"p50Ms" | "p95Ms">("p50Ms");
  const labels: Record<string, string> = {
    adapter: zh ? "底层适配器" : "Adapter",
    script: zh ? "脚本包装" : "Script",
    click: zh ? "点击" : "Click",
    swipe: zh ? "滑动" : "Swipe",
    long_click: zh ? "长按" : "Press",
  };
  const rows = capture
    ? data.capture
        .filter((row) => row.scenario === scenario)
        .map((row) => ({
          key: row.method,
          value: row[metric],
          count: row.count,
          third: String(row.repeatedFrames),
          fourth: row.maximumTextureMse.toFixed(2),
        }))
    : data.control.map((row) => ({
        key: row.scenario,
        value: row[endpoint][metric],
        count: row.api.count,
        third: row.hold.p50Ms.toFixed(0),
        fourth: row.travelPixels.p50.toFixed(0),
      }));
  const maximum = Math.max(...rows.map((row) => row.value));
  return (
    <figure className={`baas-benchmark baas-device-benchmark baas-android-local-${kind}`}>
      <figcaption>
        {capture
          ? zh
            ? "Android 本机截图（毫秒）"
            : "Android local screenshots (ms)"
          : endpoint === "api"
            ? zh
              ? "Android 本机输入：接口返回（毫秒）"
              : "Android local input: API return (ms)"
            : zh
              ? "Android 本机输入：截图确认（毫秒）"
              : "Android local input: screenshot confirmation (ms)"}
      </figcaption>
      <div className="baas-device-controls">
        {capture && (
          <>
            <label htmlFor={id}>{zh ? "画面" : "Scene"}</label>
            <select id={id} value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="static">{zh ? "静态画面" : "Static scene"}</option>
              <option value="animated">{zh ? "运动纹理" : "Animated texture"}</option>
            </select>
          </>
        )}
        <div
          className="baas-chart-controls"
          role="group"
          aria-label={zh ? "本机统计量" : "Local statistic"}
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
      {!capture && (
        <div
          className="baas-chart-controls"
          role="group"
          aria-label={zh ? "本机计时终点" : "Local timing endpoint"}
        >
          {(["api", "confirmed"] as const).map((value) => (
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
                  ? "截图确认"
                  : "Screenshot confirmation"}
            </button>
          ))}
        </div>
      )}
      <div aria-live="polite">
        {rows.map((row) => (
          <div className="baas-benchmark-row" key={row.key} data-method={row.key}>
            <span>{labels[row.key]}</span>
            <div className="baas-benchmark-track" aria-hidden="true">
              <div
                data-kind={row.key === "script" ? "after" : "before"}
                style={{ width: `${(row.value / maximum) * 100}%` }}
              />
            </div>
            <output aria-label={`${labels[row.key]} ${metric === "p50Ms" ? "p50" : "p95"}`}>
              {row.value.toFixed(1)} ms
            </output>
          </div>
        ))}
      </div>
      <p>
        {zh
          ? "共同线性横轴从 0 开始；不删除离群值。"
          : "One shared linear axis starts at zero; no outlier removal."}
      </p>
      <div className="baas-benchmark-table-scroll">
        <table>
          <caption>
            {capture
              ? zh
                ? "每种范围、每种画面 100 次正式截图；MSE 为静态纹理区域的最大均方误差"
                : "100 measured screenshots per scope and scene; maximum MSE in the static texture region"
              : zh
                ? "每种操作 72 次正式输入；按压时长与位移来自测试程序收到的事件"
                : "72 measured inputs per operation; hold and travel come from events received by the target"}
          </caption>
          <thead>
            <tr>
              <th>{zh ? "范围 / 操作" : "Scope / action"}</th>
              <th>{zh ? "成功 / 失败" : "Valid / failed"}</th>
              <th>
                {capture
                  ? zh
                    ? "重复帧"
                    : "Repeated frames"
                  : zh
                    ? "按压 p50 / ms"
                    : "Hold p50 / ms"}
              </th>
              <th>{capture ? "MSE" : zh ? "位移 p50 / px" : "Travel p50 / px"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{labels[row.key]}</td>
                <td>{row.count} / 0</td>
                <td>{row.third}</td>
                <td>{row.fourth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
