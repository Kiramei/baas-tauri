import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAndroidResourcesReady } from "../../src/android/useAndroidResourcesReady";

if (!import.meta.env.DEV || !__WITH_ANDROID__ || !(window as any).__BAAS_MOCK_STARTUP__)
  throw new Error("This readiness fixture requires the isolated mock native bridge");

function Fixture() {
  const [inputs, setInputs] = useState({ initialized: false, cycle: 0 });
  const ready = useAndroidResourcesReady(inputs.initialized, inputs.cycle);
  useLayoutEffect(() => {
    const update = (event: Event) => setInputs((event as CustomEvent).detail);
    window.addEventListener("fixture:readiness-input", update);
    return () => window.removeEventListener("fixture:readiness-input", update);
  }, []);
  return <output data-startup-ready={String(ready)}>{JSON.stringify({ ...inputs, ready })}</output>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>
);
