import React, { Activity, useEffect, useState } from "react";

interface PageActivityProps {
  active: boolean;
  children: React.ReactNode;
  suspendDelayMs?: number;
}

/** Preserves page state while pausing effects after its exit transition completes. */
const PageActivity: React.FC<PageActivityProps> = ({ active, children, suspendDelayMs = 200 }) => {
  const [keepVisible, setKeepVisible] = useState(active);

  useEffect(() => {
    if (active) {
      setKeepVisible(true);
      return;
    }
    const timeout = window.setTimeout(() => setKeepVisible(false), suspendDelayMs);
    return () => window.clearTimeout(timeout);
  }, [active, suspendDelayMs]);

  // Zero-delay panels switch in the same commit; a timeout would leave both
  // editors visible for a frame and move the scroll position before hiding one.
  return (
    <Activity mode={active || (suspendDelayMs > 0 && keepVisible) ? "visible" : "hidden"}>
      {children}
    </Activity>
  );
};

export default React.memo(PageActivity);
