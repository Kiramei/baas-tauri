// Development-only fixture: real page/components, isolated persisted sync data; never connects to BAAS.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import SchedulerPage from "../../src/pages/SchedulerPage";
import { AppProvider } from "../../src/context/AppContext";
import { UISettingsProvider, useUISettings } from "../../src/context/UISettingsProvider";
import { useWebSocketStore } from "../../src/store/WebsocketStore";
import { initI18n } from "../../src/shared/I18nTranslator";
import type { EventConfig } from "../../src/types/event";
import "../../src/styles/index.css";

if (!import.meta.env.DEV) throw new Error("Test fixture is development-only");
if (!localStorage.getItem("uiSettings")) localStorage.setItem("uiSettings", JSON.stringify({ lang: "zh", theme: "light" }));
await initI18n();
const task = (name: string, extra: Partial<EventConfig> = {}): EventConfig => ({
  func_name: name,
  event_name: name,
  priority: 1,
  enabled: true,
  interval: 86400,
  next_tick: 1788508800.125,
  pre_task: [],
  post_task: [],
  daily_reset: [],
  disabled_time_range: [],
  ...extra,
});
const initial = [
  task("cafe_reward", { post_task: ["collect_daily_power"] }),
  task("collect_daily_power"),
  task("activity_sweep", { pre_task: ["collect_daily_power"], post_task: ["collect_reward"] }),
  task("collect_reward"),
  task("arena", { enabled: false }),
  task("mail", { enabled: false }),
];
const saved = JSON.parse(localStorage.getItem("fixture.scheduler") ?? "null");
const configs = saved?.configStore ?? {
  alpha: { name: "Schale · 日常", new_event_enable_state: "default" },
  beta: { name: "备用账号", new_event_enable_state: "off" },
};
useWebSocketStore.setState({
  _auth_phase: "authenticated",
  _all_data_initialized: true,
  _initiating: false,
  configStore: configs,
  eventStore: saved?.eventStore ?? {
    alpha: initial,
    beta: initial.map((task) => ({ ...task, enabled: false })),
  },
  statusStore: {
    alpha: {
      current_task: "cafe_reward",
      waiting_tasks: ["collect_daily_power", "activity_sweep"],
    },
  } as never,
  modify: (path, patch) => {
    const [pid, scope] = path.split("::");
    for (const [key, value] of Object.entries(patch)) {
      // Exercise the production incoming-sync path, not a separate reducer.
      useWebSocketStore.getState().patch(`${pid}::${scope}/${key}`, value);
    }
    const updated = useWebSocketStore.getState();
    localStorage.setItem(
      "fixture.scheduler",
      JSON.stringify({ eventStore: updated.eventStore, configStore: updated.configStore })
    );
  },
});
function Fixture() {
  const [pid, setPid] = useState("alpha");
  const { uiSettings, setUiSettings } = useUISettings();
  const dark = uiSettings.theme === "dark";
  return (
    <div className={`${dark ? "dark" : ""} h-screen overflow-y-auto`}>
      <main className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 p-3 sm:p-6">
        <div className="flex gap-4 mb-4">
          <button onClick={() => setPid(pid === "alpha" ? "beta" : "alpha")}>Switch account</button>
          <button onClick={() => setUiSettings((settings) => ({ ...settings, theme: dark ? "light" : "dark" }))}>Toggle dark</button>
        </div>
        <div className="max-w-[1500px] mx-auto">
          <SchedulerPage key={pid} profileId={pid} />
        </div>
        <Toaster />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <UISettingsProvider>
    <AppProvider setReady={() => {}}>
      <Fixture />
    </AppProvider>
  </UISettingsProvider>
);
