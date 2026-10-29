import { describe, expect, test } from "bun:test";
import type { BaasLogEntry } from "@baas/client";
import {
  abortable,
  followLogs,
  MonitorError,
  waitForRun,
  watchStatus,
  type MonitoringClient,
  type MonitorEvent,
  type StatusSnapshot,
} from "../src/monitor";

class EventClient implements MonitoringClient {
  state: StatusSnapshot = { alpha: { running: false, exit_code: null } };
  history: BaasLogEntry[] = [];
  connects = 0;
  reads = 0;
  logReads = 0;
  statusListeners = new Set<(update: unknown, snapshot: StatusSnapshot) => void>();
  logListeners = new Set<(entry: BaasLogEntry) => void>();
  disconnectListeners = new Set<(error: Error) => void>();
  connectHandler?: (call: number) => void | Promise<void>;
  readHandler?: (call: number) => StatusSnapshot | Promise<StatusSnapshot>;
  logsHandler?: (call: number) => BaasLogEntry[] | Promise<BaasLogEntry[]>;
  async connect() {
    this.connects += 1;
    await this.connectHandler?.(this.connects);
  }
  async status() {
    const state = this.readHandler
      ? await this.readHandler(++this.reads)
      : (this.reads++, this.state);
    this.publish(state);
    return structuredClone(state);
  }
  async logs(limit = 30, profile?: string) {
    const entries = this.logsHandler
      ? await this.logsHandler(++this.logReads)
      : (this.logReads++, this.history);
    return structuredClone(
      entries.filter((entry) => !profile || entry.scope === `config:${profile}`).slice(-limit)
    );
  }
  get statusSnapshot() {
    return structuredClone(this.state);
  }
  onStatus(listener: (update: unknown, snapshot: StatusSnapshot) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  onLog(listener: (entry: BaasLogEntry) => void) {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }
  onDisconnect(listener: (error: Error) => void) {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }
  publish(state: StatusSnapshot) {
    this.state = structuredClone(state);
    for (const listener of [...this.statusListeners])
      listener({ full: true }, structuredClone(this.state));
  }
  log(entry: BaasLogEntry, append = true) {
    if (append) this.history.push(structuredClone(entry));
    for (const listener of [...this.logListeners]) listener(structuredClone(entry));
  }
  disconnect() {
    for (const listener of [...this.disconnectListeners]) listener(new Error("Fixture link lost"));
  }
  get subscriptions() {
    return this.statusListeners.size + this.logListeners.size + this.disconnectListeners.size;
  }
}
const active = (id = "run-1", timestamp = 2): StatusSnapshot => ({
  alpha: { run_id: id, running: true, exit_code: null, timestamp },
});
const done = (exit = 0, id = "run-1", timestamp = 3): StatusSnapshot => ({
  alpha: { run_id: id, running: false, exit_code: exit, timestamp },
});
const entry = (message: string): BaasLogEntry => ({
  time: `time-${message}`,
  scope: "config:alpha",
  level: "INFO",
  message,
});
const cancelled = () => new DOMException("Fixture cancellation", "AbortError");
async function errorCode(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("Expected monitor failure");
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    return error.code;
  }
}

describe("run monitoring", () => {
  test("observes completion before the submission ACK and submits exactly once", async () => {
    const client = new EventClient();
    let submitted = 0;
    const result = await waitForRun(client, "alpha", {
      submit: async () => {
        submitted++;
        client.publish(active());
        client.publish(done());
        await Promise.resolve();
        return { status: "ok", run_id: "run-1" };
      },
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      run_id: "run-1",
      succeeded: true,
    });
    expect(submitted).toBe(1);
    expect(client.subscriptions).toBe(0);
  });

  test("preserves failed terminal exit status and protects state from event consumers", async () => {
    const client = new EventClient();
    const result = await waitForRun(client, "alpha", {
      submit: async () => {
        client.publish(active());
        client.publish(done(1));
        return { run_id: "run-1" };
      },
      onEvent: (event) => {
        if (event.type === "run-status") {
          event.status.running = true;
          event.status.exit_code = 0;
        }
      },
    });
    expect(result.succeeded).toBe(false);
    expect(result.status.exit_code).toBe(1);
  });

  test("ignores an older running update received after correlated completion", async () => {
    const client = new EventClient();
    const result = await waitForRun(client, "alpha", {
      submit: async () => {
        client.publish(active());
        client.publish(done());
        client.publish(active("run-1", 1));
        return { run_id: "run-1" };
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(result.succeeded).toBe(true);
  });

  test("rejects busy submission and never follows a different existing run as the submitted task", async () => {
    const client = new EventClient();
    client.state = active("existing");
    let submitted = 0;
    expect(
      await errorCode(
        waitForRun(client, "alpha", {
          submit: async () => {
            submitted++;
            return { status: "already-running", run_id: "existing" };
          },
        })
      )
    ).toBe("already_running");
    expect(submitted).toBe(1);
    expect(client.subscriptions).toBe(0);
  });

  test("cannot mistake a legacy prior idle snapshot for fresh completion", async () => {
    const client = new EventClient();
    expect(
      await errorCode(
        waitForRun(client, "alpha", {
          submit: async () => ({ status: "ok" }),
          timeoutMs: 25,
          pollIntervalMs: 1,
        })
      )
    ).toBe("wait_timeout");
    expect(client.subscriptions).toBe(0);
  });

  test("supports a legacy run only after observing its running transition", async () => {
    const client = new EventClient();
    const result = await waitForRun(client, "alpha", {
      submit: async () => {
        client.publish({ alpha: { running: true } });
        client.publish({ alpha: { running: false } });
        return { status: "ok" };
      },
    });
    expect(result).toMatchObject({ completed: true, run_id: null, succeeded: null });
  });

  test("rejects missing explicit identity and detects replacement even without the original provider transition", async () => {
    const client = new EventClient();
    client.state = active("other");
    expect(await errorCode(waitForRun(client, "alpha", { runId: "missing" }))).toBe(
      "run_not_found"
    );
    expect(
      await errorCode(
        waitForRun(client, "alpha", {
          submit: async () => ({ status: "ok", run_id: "accepted-but-replaced" }),
          timeoutMs: 100,
          pollIntervalMs: 1,
        })
      )
    ).toBe("run_replaced");
  });

  test("reconnects reads and subscriptions without resubmitting a mutation", async () => {
    const client = new EventClient();
    const events: MonitorEvent[] = [];
    let submitted = 0;
    client.connectHandler = (call) => {
      if (call > 1) client.publish(done());
    };
    const result = await waitForRun(client, "alpha", {
      submit: async () => {
        submitted++;
        client.publish(active());
        client.disconnect();
        return { run_id: "run-1" };
      },
      onEvent: (event) => events.push(event),
      pollIntervalMs: 1,
    });
    expect(result.succeeded).toBe(true);
    expect(submitted).toBe(1);
    expect(client.connects).toBe(2);
    expect(
      events.filter((event) => event.type === "connection").map((event) => event.state)
    ).toEqual(["lost", "retrying", "restored"]);
    expect(client.subscriptions).toBe(0);
  });

  test("reports identity loss after a backend restart", async () => {
    const client = new EventClient();
    let submitted = 0;
    client.connectHandler = (call) => {
      if (call > 1) client.publish({});
    };
    expect(
      await errorCode(
        waitForRun(client, "alpha", {
          submit: async () => {
            submitted++;
            client.publish(active());
            client.disconnect();
            return { run_id: "run-1" };
          },
          pollIntervalMs: 1,
        })
      )
    ).toBe("run_lost");
    expect(submitted).toBe(1);
  });

  test("lost submission acknowledgement never triggers a replay", async () => {
    const client = new EventClient();
    let submitted = 0;
    const operation = waitForRun(client, "alpha", {
      submit: async () => {
        submitted++;
        client.disconnect();
        throw new Error("ACK lost");
      },
    });
    await expect(operation).rejects.toThrow("ACK lost");
    expect(submitted).toBe(1);
    expect(client.connects).toBe(1);
  });

  test("bounds reconnect attempts and cleans subscriptions on failure", async () => {
    const client = new EventClient();
    client.connectHandler = (call) => {
      if (call > 1) throw new Error("offline");
    };
    expect(
      await errorCode(
        waitForRun(client, "alpha", {
          submit: async () => {
            client.publish(active());
            client.disconnect();
            return { run_id: "run-1" };
          },
          timeoutMs: 2000,
          pollIntervalMs: 1,
        })
      )
    ).toBe("connection_lost");
    expect(client.connects).toBe(4);
    expect(client.subscriptions).toBe(0);
  });

  test("cancels in-flight reads and releases all observers", async () => {
    const client = new EventClient();
    const controller = new AbortController();
    client.readHandler = () => new Promise(() => {});
    const outcome = waitForRun(client, "alpha", { signal: controller.signal }).catch(
      (error) => error
    );
    await Bun.sleep(0);
    controller.abort(cancelled());
    expect((await outcome).name).toBe("AbortError");
    expect(client.subscriptions).toBe(0);
  });
});

async function collectLogs(
  client: EventClient,
  stopAt: string,
  options: { profile?: string; mutate?: boolean } = {}
) {
  const controller = new AbortController();
  const messages: string[] = [];
  const events: MonitorEvent[] = [];
  const outcome = followLogs(client, {
    signal: controller.signal,
    profile: options.profile,
    onEvent: (event) => {
      events.push(structuredClone(event));
      if (event.type !== "live-log") return;
      messages.push(event.entry.message);
      if (options.mutate) event.entry.message = "consumer mutation";
      if (messages.at(-1) === stopAt) controller.abort(cancelled());
    },
  }).catch((error) => error);
  const result = await outcome;
  expect(result.name).toBe("AbortError");
  expect(client.subscriptions).toBe(0);
  return { messages, events };
}

describe("log following", () => {
  test("combines history and round-trip live events without duplicating their overlap", async () => {
    const client = new EventClient();
    client.logsHandler = () => {
      client.log(entry("2"), false);
      client.log(entry("3"), false);
      return [entry("1"), entry("2")];
    };
    expect((await collectLogs(client, "3")).messages).toEqual(["1", "2", "3"]);
  });

  test("preserves multiplicity of identical repeated rows", async () => {
    const client = new EventClient();
    client.logsHandler = () => {
      for (let i = 0; i < 3; i++) client.log(entry("same"), false);
      client.log(entry("end"), false);
      return [entry("same"), entry("same")];
    };
    expect((await collectLogs(client, "end")).messages).toEqual(["same", "same", "same", "end"]);
  });

  test("retains live rows preceding a clipped history window in chronological order", async () => {
    const client = new EventClient();
    client.logsHandler = () => {
      ["1", "2", "3"].forEach((message) => client.log(entry(message), false));
      return [entry("2"), entry("3")];
    };
    expect((await collectLogs(client, "3")).messages).toEqual(["1", "2", "3"]);
  });

  test("recovery finds the emitted suffix inside a larger history window", async () => {
    const client = new EventClient();
    let calls = 0;
    client.logsHandler = () =>
      ++calls === 1 ? [entry("2"), entry("3")] : [entry("old"), entry("2"), entry("3"), entry("4")];
    const controller = new AbortController();
    const messages: string[] = [];
    const outcome = followLogs(client, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type !== "live-log") return;
        const message = event.entry.message;
        messages.push(message);
        event.entry.message = "mutated";
        if (message === "3") client.disconnect();
        if (message === "4") controller.abort(cancelled());
      },
    }).catch((error) => error);
    expect((await outcome).name).toBe("AbortError");
    expect(messages).toEqual(["2", "3", "4"]);
    expect(client.connects).toBe(2);
  });

  test("a disconnect during history read queues live rows until a stable reconnect", async () => {
    const client = new EventClient();
    client.logsHandler = (call) => {
      if (call === 1) {
        client.disconnect();
        client.log(entry("2"), false);
        return [entry("1")];
      }
      return [entry("1"), entry("2"), entry("3")];
    };
    const { messages } = await collectLogs(client, "3");
    expect(messages).toEqual(["1", "2", "3"]);
    expect(client.connects).toBe(2);
  });

  test("a rejected history read recovers only through read calls", async () => {
    const client = new EventClient();
    client.logsHandler = (call) => {
      if (call === 1) {
        client.disconnect();
        throw new Error("read interrupted");
      }
      return [entry("end")];
    };
    expect((await collectLogs(client, "end")).messages).toEqual(["end"]);
    expect(client.connects).toBe(2);
  });

  test("profile filtering excludes unrelated history and live rows", async () => {
    const client = new EventClient();
    client.logsHandler = () => {
      client.log({ ...entry("other"), scope: "config:beta" }, false);
      client.log(entry("end"), false);
      return [{ ...entry("old-other"), scope: "global" }];
    };
    expect((await collectLogs(client, "end", { profile: "alpha" })).messages).toEqual(["end"]);
  });
});

describe("status watching", () => {
  test("emits initial and provider changes once, filters profiles, and cleans up on abort", async () => {
    const client = new EventClient();
    const controller = new AbortController();
    const events: MonitorEvent[] = [];
    client.state = { ...active(), beta: { running: true } };
    const outcome = watchStatus(client, {
      profile: "alpha",
      signal: controller.signal,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    }).catch((error) => error);
    await Bun.sleep(0);
    client.publish(client.state);
    client.publish(done());
    controller.abort(cancelled());
    expect((await outcome).name).toBe("AbortError");
    expect(
      events
        .filter((event) => event.type === "run-status")
        .map((event) => [event.profile, event.status.running])
    ).toEqual([
      ["alpha", true],
      ["alpha", false],
    ]);
    expect(client.subscriptions).toBe(0);
  });

  test("reads again after a lost provider connection and watches all profiles", async () => {
    const client = new EventClient();
    const controller = new AbortController();
    const events: MonitorEvent[] = [];
    client.connectHandler = (call) => {
      if (call > 1) client.state = { ...done(), beta: { running: false } };
    };
    const outcome = watchStatus(client, {
      signal: controller.signal,
      pollIntervalMs: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "run-status" && event.profile === "beta") controller.abort(cancelled());
      },
    }).catch((error) => error);
    await Bun.sleep(0);
    client.disconnect();
    expect((await outcome).name).toBe("AbortError");
    expect(client.connects).toBe(2);
    expect(client.subscriptions).toBe(0);
    expect(events.some((event) => event.type === "connection" && event.state === "retrying")).toBe(
      true
    );
  });

  test("already-aborted helper observes a rejected underlying promise", async () => {
    const controller = new AbortController();
    controller.abort(cancelled());
    await expect(
      abortable(Promise.reject(new Error("late read rejection")), controller.signal)
    ).rejects.toThrow("Fixture cancellation");
    await Bun.sleep(0);
  });
});
