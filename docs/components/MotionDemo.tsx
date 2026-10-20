"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";

export function MotionDemo({
  locale,
  variant = "configuration",
}: {
  locale: "zh" | "en";
  variant?: "configuration" | "priority";
}) {
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
  const priority = variant === "priority";
  const animated = priority ? "conditional-priority-reorder.gif" : "configuration-undo.gif";
  const still = priority ? "conditional-craft-priority-still.png" : "config-cafe.png";
  return (
    <figure className="baas-motion-demo">
      <img
        className="baas-screenshot"
        src={`${base}/media/desktop/${locale}/${playing ? animated : still}`}
        alt={
          priority
            ? zh
              ? "制造优先级：拿起首个节点、下移、提交，再撤销恢复顺序"
              : "Crafting priority: pick up the first node, move down, commit, then undo to restore the order"
            : zh
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
          {priority
            ? zh
              ? "节点排序与撤销。"
              : "Reorder nodes, then undo."
            : zh
              ? "开关修改与撤销。"
              : "Change a toggle, then undo."}
        </span>
      </figcaption>
    </figure>
  );
}
