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

  return <Activity mode={active || keepVisible ? "visible" : "hidden"}>{children}</Activity>;
};

export default React.memo(PageActivity);
