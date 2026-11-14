import {
  allProfilesIdle,
  captureUpdateResumeState,
  restoreUpdateResumeState,
  type IdleScriptStatus,
  type UpdateResumeState,
} from "@/shared/IdleUpdateState";

export type AndroidStartupUpdatePhase =
  | "waiting"
  | "checking"
  | "waiting-idle"
  | "updating"
  | "restarting"
  | "restoring"
  | "ready"
  | "failed";
export type AndroidStartupUpdateState = {
  phase: AndroidStartupUpdatePhase;
  error: string | null;
  cycle: number;
  canContinueLocal: boolean;
};
export type StartupUpdateContext = {
  ready: boolean;
  enabled: boolean;
  key: unknown;
  session: unknown;
  root: string;
  ids: string[];
  activity: string;
};
export type BackendVersionReport = {
  local?: string | null;
  remote?: string | null;
  updateAvailable?: boolean;
  update_available?: boolean;
};
export type AndroidStartupUpdateDependencies = {
  context: () => StartupUpdateContext;
  noUpdate: () => Promise<boolean>;
  check: () => Promise<BackendVersionReport>;
  command: (command: string, configId?: string) => Promise<any>;
  loadResume: () => UpdateResumeState | null;
  saveResume: (resume: UpdateResumeState) => Promise<void>;
  clearResume: () => Promise<void>;
  update: (beforeRestart: () => void) => Promise<void>;
  beginUpdate: () => boolean;
  endUpdate: () => void;
  manualActive: () => boolean;
  publish: (state: AndroidStartupUpdateState) => void;
  now: () => number;
};

const initialState = (): AndroidStartupUpdateState => ({
  phase: "waiting",
  error: null,
  cycle: 0,
  canContinueLocal: false,
});

/** A single startup owner waits for verified resources before changing source. */
export class AndroidStartupUpdateCoordinator {
  state = initialState();
  private busy = false;
  private report: BackendVersionReport | null = null;
  private idleSince: number | null = null;
  private restarting = false;
  private observedNotReady = false;
  private restartDeadline = 0;
  private continueLocal = false;
  private fallbackContext: StartupUpdateContext | null = null;
  private continueContext: StartupUpdateContext | null = null;

  constructor(private readonly deps: AndroidStartupUpdateDependencies) {}

  private publish(patch: Partial<AndroidStartupUpdateState>) {
    if (patch.canContinueLocal === true) {
      const context = this.deps.context();
      this.fallbackContext = { ...context, ids: [...context.ids] };
    } else if (patch.canContinueLocal === false) this.fallbackContext = null;
    this.state = { ...this.state, ...patch };
    this.deps.publish(this.state);
  }
  retry(restart = false) {
    if (this.busy) return false;
    this.report = null;
    this.idleSince = null;
    this.restarting = restart;
    this.continueLocal = false;
    this.continueContext = null;
    if (restart) this.beginRestart();
    else this.publish({ phase: "waiting", error: null, canContinueLocal: false });
    return true;
  }
  observeResourcesReady(ready: boolean) {
    if (this.restarting && !ready) this.observedNotReady = true;
  }
  restartFailed(error: unknown) {
    this.publish({
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
      canContinueLocal: false,
    });
  }
  private beginRestart() {
    this.restarting = true;
    this.observedNotReady = false;
    // Resource initialization owns a 600-second deadline, with transport/setup headroom.
    this.restartDeadline = this.deps.now() + 15 * 60_000;
    this.publish({
      phase: "restarting",
      cycle: this.state.cycle + 1,
      error: null,
      canContinueLocal: false,
    });
  }
  useLocal() {
    if (
      !this.state.canContinueLocal ||
      !this.fallbackContext ||
      !this.current(this.fallbackContext) ||
      this.deps.loadResume()
    )
      return;
    this.continueContext = this.fallbackContext;
    this.continueLocal = true;
    this.publish({ phase: "waiting", error: null, canContinueLocal: false });
  }
  private current(origin: StartupUpdateContext) {
    const current = this.deps.context();
    return (
      current.ready &&
      current.key === origin.key &&
      current.session === origin.session &&
      current.root === origin.root &&
      current.ids.length === origin.ids.length &&
      current.ids.every((id) => origin.ids.includes(id))
    );
  }

  async tick(): Promise<void> {
    if (this.busy || this.state.phase === "ready" || this.state.phase === "failed") return;
    const input = this.deps.context();
    const context = { ...input, ids: [...input.ids] };
    if (this.restarting) {
      if (!context.ready) this.observedNotReady = true;
      if (this.deps.now() > this.restartDeadline) {
        this.publish({
          phase: "failed",
          error: "Android backend did not finish preparing after its update",
          canContinueLocal: false,
        });
        return;
      }
      if (!context.ready || !this.observedNotReady) return;
    } else if (!context.ready) return;
    if (this.continueLocal) {
      if (!this.continueContext || !this.current(this.continueContext) || this.deps.loadResume()) {
        this.continueLocal = false;
        this.continueContext = null;
        this.report = null;
        this.publish({ phase: "waiting", error: null, canContinueLocal: false });
      } else this.publish({ phase: "ready", error: null, canContinueLocal: false });
      return;
    }
    if (this.deps.manualActive()) return;
    this.busy = true;
    let claimed = false;
    let mutated = false;
    try {
      const saved = this.deps.loadResume();
      if (saved) {
        if (
          saved.schema !== 1 ||
          saved.root !== context.root ||
          !saved.running ||
          Object.values(saved.running).some((value) => typeof value !== "boolean")
        ) {
          await this.deps.clearResume();
        } else {
          if (!this.deps.beginUpdate()) return;
          claimed = true;
          this.publish({ phase: "restoring", error: null });
          await restoreUpdateResumeState(saved, context.ids, async (name, id) => {
            if (!this.current(context))
              throw new Error("Backend changed before scheduler restoration");
            return this.deps.command(name, id);
          });
          if (!this.current(context))
            throw new Error("Backend changed during scheduler restoration");
          await this.deps.clearResume();
        }
      }
      if (this.restarting || this.continueLocal) {
        this.restarting = false;
        this.publish({ phase: "ready", error: null, canContinueLocal: false });
        return;
      }
      if (!this.current(context)) return;
      if (!this.deps.context().enabled || (await this.deps.noUpdate())) {
        if (this.current(context)) this.publish({ phase: "ready", error: null });
        return;
      }
      if (!this.report) {
        this.publish({ phase: "checking", error: null });
        this.report = await this.deps.check();
        if (!this.current(context)) {
          this.report = null;
          return;
        }
      }
      if (!this.report.remote)
        throw new Error("Backend version check did not return a remote version");
      const available =
        this.report.updateAvailable ??
        this.report.update_available ??
        this.report.local !== this.report.remote;
      if (!available) {
        this.publish({ phase: "ready", error: null });
        return;
      }
      this.publish({
        phase: "waiting-idle",
        error: null,
        canContinueLocal: !this.deps.loadResume() && this.current(context),
      });
      const activity = this.deps.context().activity;
      const raw = (await this.deps.command("status")) as Record<string, IdleScriptStatus>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Backend returned an invalid scheduler status");
      const statuses = Object.fromEntries(
        context.ids.map((id) => [
          id,
          raw[id] ?? { running: false, current_task: null, waiting_tasks: [] },
        ])
      );
      const ids = [...new Set([...context.ids, ...Object.keys(raw)])];
      const full = { ...statuses, ...raw };
      if (
        this.continueLocal ||
        !this.current(context) ||
        !this.deps.context().enabled ||
        activity !== this.deps.context().activity ||
        (ids.length > 0 && !allProfilesIdle(ids, full))
      ) {
        this.idleSince = null;
        return;
      }
      if (this.idleSince === null) this.idleSince = this.deps.now();
      if (this.deps.now() - this.idleSince < 3_000) return;
      this.publish({ canContinueLocal: false });
      if (!claimed) {
        if (!this.deps.beginUpdate()) return;
        claimed = true;
      }
      const resume = captureUpdateResumeState(context.root, context.ids, statuses);
      await this.deps.saveResume(resume);
      if (
        this.continueLocal ||
        !this.current(context) ||
        !this.deps.context().enabled ||
        activity !== this.deps.context().activity
      ) {
        await this.deps.clearResume();
        this.idleSince = null;
        return;
      }
      mutated = true;
      await this.deps.command("stop_all_tasks");
      if (!this.current(context)) throw new Error("Backend changed before applying its update");
      this.publish({ phase: "updating", error: null });
      await this.deps.update(() => {
        this.beginRestart();
      });
    } catch (error) {
      if (mutated && !this.restarting && this.current(context)) {
        const saved = this.deps.loadResume();
        if (saved) {
          try {
            await restoreUpdateResumeState(saved, context.ids, this.deps.command);
            await this.deps.clearResume();
          } catch {
            /* Keep the durable snapshot for a successful retry. */
          }
        }
      }
      this.publish({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        canContinueLocal:
          !mutated && !this.restarting && !this.deps.loadResume() && this.current(context),
      });
    } finally {
      if (claimed) this.deps.endUpdate();
      this.busy = false;
    }
  }
}
