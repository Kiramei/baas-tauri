"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RotateCcw, X } from "lucide-react";
import data from "@/public/developer/recognition-replay.json";

const scenarios: Record<string, [string, string]> = {
  "end-first": ["结束特征与点击规则同时命中", "End feature and reaction both match"],
  "rgb-first": ["RGB 与图像点击规则同时命中", "RGB and image reactions both match"],
  "image-fallback": ["RGB 未命中，图像规则命中", "Image reaction after RGB misses"],
  "repeat-suppressed": ["两秒内重复识别同一按钮", "Same reaction within two seconds"],
  "popup-fallback": ["交给弹窗处理器", "Fall back to the popup handler"],
  "tentative-limit": ["超过失败次数后试探点击", "Tentative click after the failure limit"],
  timeout: ["检测循环超时", "Detection loop timeout"],
  stopped: ["进入循环前已停止", "Stopped before entering the loop"],
  "template-end": ["带阈值的图像结束特征", "Image end feature with custom thresholds"],
  "negative-action": ["负坐标规则仅等待", "Negative-coordinate reaction waits"],
  "wrong-package": ["目标游戏包不匹配", "Unexpected foreground package"],
  "cached-first": ["首轮复用已有截图", "Reuse the cached frame first"],
};
const kinds: Record<string, [string, string]> = {
  capture: ["获取下一帧", "Acquire next frame"],
  loading: ["检查加载状态", "Check loading state"],
  rgb: ["检测 RGB 特征", "Test RGB feature"],
  image: ["检测图像特征", "Test image feature"],
  popup: ["调用弹窗处理器", "Call popup handler"],
  click: ["请求点击", "Request click"],
  sleep: ["等待", "Wait"],
  package: ["检查当前游戏包", "Check current package"],
  return: ["返回结束特征", "Return end feature"],
  exception: ["抛出异常", "Raise exception"],
};

export function RecognitionReplay({ locale }: { locale: "zh" | "en" }) {
  const id = useId();
  const language = locale === "zh" ? 0 : 1;
  const zh = language === 0;
  const [scenario, setScenario] = useState(data.cases[0].id);
  const [step, setStep] = useState(0);
  const list = useRef<HTMLOListElement>(null);
  const selected = data.cases.find((item) => item.id === scenario)!;
  const event = selected.events[step];
  const previous = zh ? "上一步" : "Previous step";
  const next = zh ? "下一步" : "Next step";
  const reset = zh ? "回到首步" : "Reset to first step";
  const value = "value" in event ? event.value : undefined;
  useEffect(() => {
    const element = list.current;
    const active = element?.children[step];
    if (!element || !active) return;
    const bounds = element.getBoundingClientRect();
    const row = active.getBoundingClientRect();
    if (row.top < bounds.top) element.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) element.scrollTop += row.bottom - bounds.bottom;
  }, [scenario, step]);
  return (
    <figure className="baas-recognition" data-scenario={scenario}>
      <figcaption>{zh ? "识别循环离线回放" : "Offline recognition replay"}</figcaption>
      <div className="baas-recognition-toolbar">
        <label htmlFor={id}>{zh ? "场景" : "Scenario"}</label>
        <select id={id} value={scenario} onChange={(event) => { setScenario(event.target.value); setStep(0); }}>
          {data.cases.map((item) => <option key={item.id} value={item.id}>{scenarios[item.id][language]}</option>)}
        </select>
        <div className="baas-recognition-buttons">
          <button type="button" aria-label={previous} title={previous} disabled={step === 0} onClick={() => setStep((value) => value - 1)}><ArrowLeft size={16} /></button>
          <button type="button" aria-label={next} title={next} disabled={step === selected.events.length - 1} onClick={() => setStep((value) => value + 1)}><ArrowRight size={16} /></button>
          <button type="button" aria-label={reset} title={reset} disabled={step === 0} onClick={() => setStep(0)}><RotateCcw size={16} /></button>
        </div>
      </div>
      <div className="baas-recognition-progress">
        <label htmlFor={id + "-step"}>{zh ? "步骤" : "Step"} {step + 1} / {selected.events.length}</label>
        <input id={id + "-step"} type="range" min={0} max={selected.events.length - 1} value={step} onChange={(event) => setStep(Number(event.target.value))} />
      </div>
      <output className="baas-recognition-current" aria-live="polite" data-kind={event.kind}>
        <span>{zh ? "帧" : "Frame"} {event.frame}</span>
        <span>{kinds[event.kind][language]}</span>
        <strong>{"name" in event ? event.name : value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)}</strong>
        {"matched" in event && <span className="baas-recognition-match">{event.matched ? <Check size={15} /> : <X size={15} />}{event.matched ? (zh ? "命中" : "Match") : (zh ? "未命中" : "Miss")}</span>}
        {"x" in event && <code>({event.x}, {event.y})</code>}
        {"seconds" in event && <code>{event.seconds} s</code>}
        {"expected" in event && <span>{zh ? "与目标包不同" : "Does not match the target package"}</span>}
        {"threshold" in event && <code>threshold={event.threshold}, rgb_diff={event.rgbDiff}</code>}
      </output>
      <div className="baas-recognition-summary">
        <span>{zh ? "总截图调用" : "Total captures"}: {selected.captures}</span>
        <span>{zh ? "总点击请求" : "Total click requests"}: {selected.clickRequests}</span>
        <code>{typeof selected.outcome.value === "string" ? selected.outcome.value : JSON.stringify(selected.outcome.value)}</code>
      </div>
      <ol ref={list} className="baas-recognition-events">
        {selected.events.map((event, index) => (
          <li key={index} aria-current={step === index ? "step" : undefined} data-kind={event.kind}>
            <span className="baas-recognition-number">{index + 1}</span>
            <span>{kinds[event.kind][language]}</span>
            {"name" in event ? <code>{event.name}</code> : "value" in event ? <code>{JSON.stringify(event.value)}</code> : <span />}
            {"matched" in event && <span>{event.matched ? <Check size={14} aria-label={zh ? "命中" : "Match"} /> : <X size={14} aria-label={zh ? "未命中" : "Miss"} />}</span>}
          </li>
        ))}
      </ol>
    </figure>
  );
}
