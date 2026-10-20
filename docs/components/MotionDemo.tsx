"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";

export function MotionDemo({ locale }: { locale: "zh" | "en" }) {
  const [playing, setPlaying] = useState(false);
  const zh = locale === "zh";
  const label = playing
    ? zh
      ? "停止演示"
      : "Stop demonstration"
    : zh
      ? "播放演示"
      : "Play demonstration";
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return (
    <figure className="baas-motion-demo">
      <img
        className="baas-screenshot"
        src={`${base}/media/desktop/${locale}/${playing ? "configuration-undo.gif" : "config-cafe.png"}`}
        alt={
          zh
            ? "真实浅色窗口：切换领取收益，等待自动保存，再撤销恢复原值"
            : "Real light-theme window: toggle Collect rewards, wait for automatic saving, then Undo to restore the original value"
        }
      />
      <figcaption>
        <button
          type="button"
          onClick={() => setPlaying((current) => !current)}
          aria-label={label}
          title={label}
          aria-pressed={playing}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span>
          {zh
            ? "修改开关后撤销，演示期间未运行游戏任务。"
            : "Toggle a setting, then undo it. No game task runs during this demonstration."}
        </span>
      </figcaption>
    </figure>
  );
}
