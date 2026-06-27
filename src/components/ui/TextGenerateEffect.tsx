"use client";
import { useEffect } from "react";
import { motion, stagger, useAnimate } from "framer-motion";
import { cn } from "@/shared/GlobalUtilities.ts";
import React from "react";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

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
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

  // Split on spaces only in word mode.
  const wordsArray = React.useMemo(() => (mode === "word" ? words.split(" ") : []), [words, mode]);

  useEffect(() => {
    if (lowPerformanceMode) return;
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
  }, [scope, words, mode, filter, duration, lowPerformanceMode]);

  if (mode === "all") {
    if (lowPerformanceMode) {
      return (
        <div>
          <span
            className={className}
            style={{
              filter: "none",
              whiteSpace: "pre-wrap",
            }}
          >
            {words}
          </span>
        </div>
      );
    }

    // Render once to reduce DOM size.
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

  // Animate word by word only in word mode.
  if (lowPerformanceMode) {
    return (
      <div>
        {wordsArray.map((word, idx) => {
          const parts = word.split("\n");
          return (
            <span
              key={word + idx}
              className={className}
              style={{
                filter: "none",
                whiteSpace: "pre-wrap",
              }}
            >
              {parts.map((part, i) => (
                <React.Fragment key={i}>
                  {part}
                  {i < parts.length - 1 && <br />}
                </React.Fragment>
              ))}{" "}
            </span>
          );
        })}
      </div>
    );
  }

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
