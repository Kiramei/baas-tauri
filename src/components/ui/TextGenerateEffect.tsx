"use client";
import { useEffect } from "react";
import { motion, stagger, useAnimate } from "framer-motion";
import { cn } from "@/shared/GlobalUtilities.ts";
import React from "react";

export const TextGenerateEffect = ({
  words,
  className,
  filter = true,
  duration = 0.5,
  mode = "word",
}: {
  words: string;
  className?: string;
  filter?: boolean;
  duration?: number;
  mode?: "word" | "all";
}) => {
  const [scope, animate] = useAnimate();

  // 按空格拆分，但仅在 word 模式下用
  const wordsArray = React.useMemo(() => (mode === "word" ? words.split(" ") : []), [words, mode]);

  useEffect(() => {
    animate(
      "span",
      {
        opacity: 1,
        filter: filter ? "blur(0px)" : "none",
      },
      {
        duration: duration ?? 0.5,
        delay: mode === "word" ? stagger(0.2) : 0,
      }
    );
  }, [scope, words, mode, filter, duration]);

  if (mode === "all") {
    // 🚀 一次性渲染，减少 DOM 数量
    return (
      <motion.div ref={scope}>
        <motion.span
          className={cn("opacity-0", className)}
          style={{
            filter: filter ? "blur(10px)" : "none",
            whiteSpace: "pre-wrap",
          }}
        >
          {words}
        </motion.span>
      </motion.div>
    );
  }

  // ✅ word 模式下才逐词分动画
  return (
    <motion.div ref={scope}>
      {wordsArray.map((word, idx) => {
        const parts = word.split("\n");
        return (
          <motion.span
            key={word + idx}
            className={cn("opacity-0", className)}
            style={{
              filter: filter ? "blur(10px)" : "none",
              whiteSpace: "pre-wrap",
            }}
          >
            {parts.map((part, i) => (
              <React.Fragment key={i}>
                {part}
                {i < parts.length - 1 && <br />}
              </React.Fragment>
            ))}{" "}
          </motion.span>
        );
      })}
    </motion.div>
  );
};
