import React, { useLayoutEffect } from "react";

/** Keeps the static startup shell visible until its React replacement has painted. */
const StartupShellHandoff: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useLayoutEffect(() => {
    const shell = document.getElementById("baas-startup-shell");
    if (!shell) return;

    let secondFrame = 0;
    let removalTimer: ReturnType<typeof setTimeout> | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        shell.classList.add("is-leaving");
        const remove = () => shell.remove();
        shell.addEventListener("transitionend", remove, { once: true });
        removalTimer = setTimeout(remove, 250);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      if (removalTimer) clearTimeout(removalTimer);
    };
  }, []);

  return children;
};

export default StartupShellHandoff;
