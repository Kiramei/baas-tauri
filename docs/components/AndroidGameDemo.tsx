"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";

export function AndroidGameDemo({ locale }: { locale: "zh" | "en" }) {
  const [playing, setPlaying] = useState(false);
  const zh = locale === "zh";
  const label = playing ? (zh ? "停止演示" : "Stop demonstration") : (zh ? "播放演示" : "Play demonstration");
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return (
    <figure className="baas-motion-demo baas-android-game-demo">
      <img
        className="baas-screenshot"
        src={`${base}/media/android/${locale}/game-preview.${playing ? "gif" : "png"}`}
        alt={zh ? "Android 首页原生游戏预览与实时状态" : "Native game preview and Live status on Android Home"}
        width={720}
        height={1280}
        loading="lazy"
      />
      <figcaption>
        <button type="button" onClick={() => setPlaying(value => !value)} aria-label={label} title={label} aria-pressed={playing}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span>{zh ? "后台游戏预览。" : "Background game preview."}</span>
      </figcaption>
    </figure>
  );
}
