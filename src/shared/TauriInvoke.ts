import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

const PENDING_INVOKES_KEY = "baas:pending-tauri-invokes";

interface InvokeDiagnostic {
  id: number;
  command: string;
  startedAt: number;
  stack: string;
}

const activeInvokes = new Map<number, InvokeDiagnostic>();
let nextInvokeId = 1;
let diagnosticsInstalled = false;

const installDiagnostics = () => {
  if (diagnosticsInstalled || typeof window === "undefined") return;
  diagnosticsInstalled = true;

  try {
    const previous = sessionStorage.getItem(PENDING_INVOKES_KEY);
    sessionStorage.removeItem(PENDING_INVOKES_KEY);
    if (previous) {
      console.warn(
        "[BAAS] Previous page reloaded with unfinished Tauri commands",
        JSON.parse(previous)
      );
    }
  } catch {
    // Diagnostics must not interfere with command execution.
  }

  window.addEventListener("pagehide", () => {
    if (activeInvokes.size === 0) return;
    const pending = Array.from(activeInvokes.values()).map((entry) => ({
      ...entry,
      pendingMs: Date.now() - entry.startedAt,
    }));
    try {
      sessionStorage.setItem(PENDING_INVOKES_KEY, JSON.stringify(pending));
    } catch {
      // The synchronous console record remains available when storage is unavailable.
    }
    console.warn("[BAAS] Reloading with pending Tauri commands", pending);
  });
};

export const invoke = async <T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions
): Promise<T> => {
  installDiagnostics();
  if (command === "system_logs_ingest_frontend") {
    return tauriInvoke<T>(command, args, options);
  }

  const diagnostic: InvokeDiagnostic = {
    id: nextInvokeId++,
    command,
    startedAt: Date.now(),
    stack:
      new Error().stack
        ?.split("\n")
        .filter((line) => !line.includes("TauriInvoke"))
        .slice(1, 8)
        .join("\n") ?? "",
  };
  activeInvokes.set(diagnostic.id, diagnostic);
  try {
    return await tauriInvoke<T>(command, args, options);
  } finally {
    activeInvokes.delete(diagnostic.id);
  }
};
