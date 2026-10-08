import React, { Suspense, useEffect, useState } from "react";
import { Check, ChevronDown, CircleAlert, TerminalSquare } from "lucide-react";
import { invoke } from "@/shared/TauriInvoke";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { androidStartupSteps as steps } from "@/android/startupSteps";

const Terminal = React.lazy(() => import("@/components/AndroidStartupTerminal"));
type Bootstrap = { stage?: string; error?: string; traceback?: string; installMessage?: string; backendInstalled?: boolean };

/** Android-only installer: real bootstrap stdout/stderr is available before WebSocket authentication. */
export default function AndroidInstallStepper({ text, theme }: { text: string; theme: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({});
  const [logs, setLogs] = useState("");
  const [path, setPath] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const verified = useWebSocketStore((s) => s._server_verified);
  const phase = useWebSocketStore((s) => s._auth_phase);
  const authError = useWebSocketStore((s) => s._auth_error);
  const uiReady = useWebSocketStore((s) => s._android_ui_ready);
  const initiating = useWebSocketStore((s) => s._initiating);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await invoke<{ bootstrap?: Bootstrap; startupLog?: string; installPath?: string }>("updater_get_startup_state");
        if (disposed) return;
        setBootstrap(state.bootstrap ?? {});
        setLogs((state.startupLog ?? "").split("\n").slice(-250).join("\n"));
        setPath(state.installPath ?? "");
      } catch (error) {
        if (!disposed) setLogs((current) => current || `等待启动状态：${String(error)}`);
      } finally {
        if (!disposed) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const active = bootstrap.error ? bootstrap.backendInstalled ? 2 : 1 : uiReady ? 5 : phase === "authenticated" ? 4 : verified ? 3
    : bootstrap.backendInstalled || bootstrap.stage === "service" ? 2
    : bootstrap.stage && bootstrap.stage !== "storage" ? 1 : 0;
  const error = bootstrap.error || authError;
  const selected = expanded ?? Math.min(active, 4);
  const output = `${logs}${logs && text ? "\n" : ""}${text}${bootstrap.traceback ? `\n${bootstrap.traceback}` : ""}`;
  return (
    <main className="fixed inset-0 overflow-y-auto bg-slate-100 px-5 py-7 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="mb-7">
        <div className="text-xs font-semibold tracking-widest text-primary-500">BAAS / ANDROID</div>
        <h1 className="mt-2 text-2xl font-semibold">准备应用</h1>
        <p className="mt-2 text-sm text-slate-500">每一步都有执行状态，出错时保留完整输出。</p>
      </header>
      <ol aria-label="安卓安装与启动进度">
        {steps.map((step, index) => {
          const complete = index < active;
          const running = index === active;
          const failed = running && !!error;
          const open = index === selected;
          return <li key={step.title} className="relative pb-6 pl-10">
            {index < steps.length - 1 && <div className={`absolute left-3.5 top-8 bottom-0 w-px ${complete ? "bg-primary-500" : "bg-slate-300 dark:bg-slate-700"}`} />}
            <span className={`absolute left-0 top-0 flex size-7 items-center justify-center rounded-full text-xs font-semibold ${failed ? "bg-red-500 text-white" : complete || running ? "bg-primary-500 text-white" : "bg-slate-200 text-slate-500 dark:bg-slate-800"}`}>
              {failed ? <CircleAlert size={16} /> : complete ? <Check size={16} /> : index + 1}
            </span>
            <button type="button" className="flex min-h-7 w-full items-center justify-between gap-2 text-left" onClick={() => setExpanded(open ? null : index)} aria-expanded={open}>
              <span className="font-medium">{step.title}</span>
              <span className="flex items-center gap-1 text-xs text-slate-500">{failed ? "失败" : complete ? "已完成" : running ? "执行中" : "等待"}<ChevronDown size={14} /></span>
            </button>
            <p className="mt-2 text-xs leading-5 text-slate-500">{step.description}</p>
            {open && <div className="mt-3 overflow-hidden rounded-xl border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-700"><TerminalSquare size={14} />实时执行日志 · stdout / stderr</div>
              <div className="h-56 p-2"><Suspense fallback={<pre className="h-full overflow-auto whitespace-pre-wrap text-xs">{output || "等待运行环境输出…"}</pre>}><Terminal text={output || "等待运行环境输出…"} theme={theme} /></Suspense></div>
            </div>}
          </li>;
        })}
      </ol>
      {error && <div role="alert" className="rounded-xl border border-red-400 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}
      <footer className="mt-2 break-all text-xs leading-5 text-slate-500">{bootstrap.installMessage}<br />{path}{initiating && <p>正在同步配置快照…</p>}</footer>
    </main>
  );
}
