import { describe, expect, test } from "bun:test";
import {
  androidInstallProgressId,
  androidInstallDisplayState,
  resolveAndroidInstallState,
  submitAndroidInstallChannel,
  type AndroidStartupState,
} from "../../src/android/installState";

const transportError = "Backend transport startup is cooling down after a failure";

describe("Android channel confirmation presentation", () => {
  test("the channel awaits confirmation while other unfinished work does not spin behind it", () => {
    const storage = { id: "storage", state: "running" };
    const channel = { id: "channel", state: "running" };
    expect(androidInstallDisplayState(storage, true)).toBe("pending");
    expect(androidInstallDisplayState(channel, true)).toBe("waiting");
    expect(storage.state).toBe("running");
    expect(channel.state).toBe("running");
  });

  test("actual execution, completed work and failures keep their reported state", () => {
    expect(androidInstallDisplayState({ id: "download", state: "running" }, false)).toBe("running");
    expect(androidInstallDisplayState({ id: "storage", state: "done" }, true)).toBe("done");
    expect(androidInstallDisplayState({ id: "channel", state: "failed" }, true)).toBe("failed");
  });
});

describe("Android horizontal installation progress", () => {
  const steps = [
    { id: "storage", state: "done" },
    { id: "channel", state: "done" },
    { id: "download", state: "running" },
    { id: "extract", state: "pending" },
    { id: "adapt", state: "pending" },
    { id: "service", state: "pending" },
  ];

  test("follows the bootstrap's explicit step as extraction and adaptation overlap", () => {
    expect(androidInstallProgressId(steps, "adapt")).toBe("adapt");
  });

  test("follows running or failed progress when an older status omits currentStep", () => {
    expect(androidInstallProgressId(steps)).toBe("download");
    expect(androidInstallProgressId(steps, "unknown")).toBe("download");
    expect(androidInstallProgressId([...steps, { id: "service", state: "failed" }])).toBe(
      "service"
    );
  });

  test("starts at storage and remains on the final completed step", () => {
    expect(androidInstallProgressId(steps.map((step) => ({ ...step, state: "pending" })))).toBe(
      "storage"
    );
    expect(androidInstallProgressId(steps.map((step) => ({ ...step, state: "done" })))).toBe(
      "service"
    );
    expect(androidInstallProgressId([])).toBeUndefined();
  });
});

describe("Android first installation state", () => {
  test("continuing without touching a channel card submits the displayed development choice", () => {
    const state = resolveAndroidInstallState({ channelSelected: false }, null, null);
    expect(state.awaitingChannel).toBe(true);
    expect(state.showChannelChoice).toBe(true);
    expect(state.selectedChannel).toBe("dev");
    expect(state.selectedChannel).toBe(state.channel);
  });

  test("a fresh installation offers the available development channel even after a stable attempt failed", () => {
    const saved = { channel: "dev", channelSelected: false };
    expect(resolveAndroidInstallState(saved, null, null).selectedChannel).toBe("dev");
    expect(resolveAndroidInstallState(saved, "stable", null).selectedChannel).toBe("dev");
    expect(resolveAndroidInstallState({ channel: "stable" }, "dev", null).selectedChannel).toBe(
      "dev"
    );
    expect(
      resolveAndroidInstallState(
        {
          channel: "stable",
          bootstrap: { stage: "failed", error: "archive does not contain main.service.py" },
        },
        null,
        null
      ).selectedChannel
    ).toBe("dev");
  });

  test("a completed channel selection hides the picker even when the legacy stage still says channel", () => {
    for (const channelSelected of [true, false]) {
      const state = resolveAndroidInstallState(
        {
          channelSelected,
          bootstrap: {
            stage: "channel",
            awaitingChannel: false,
            channel: "stable",
            currentStep: "download",
            steps: [
              { id: "channel", state: "done" },
              { id: "download", state: "running" },
            ],
          },
        },
        null,
        transportError
      );
      expect(state.awaitingChannel).toBe(false);
      expect(state.showChannelChoice).toBe(false);
      expect(state.clientError).toBeNull();
    }
    expect(
      resolveAndroidInstallState({ bootstrap: { stage: "channel" } }, null, null).awaitingChannel
    ).toBe(true);
  });

  test("transport retries do not report installation failure before the service is ready", () => {
    const states: AndroidStartupState[] = [
      {},
      { channelSelected: false },
      { bootstrap: { stage: "channel", awaitingChannel: true } },
      ...["storage", "download", "extract", "adapt"].map((id) => ({
        bootstrap: {
          stage: "runtime",
          steps: [
            { id, state: "running" },
            { id: "service", state: "pending" },
          ],
        },
      })),
      {
        baasRootExistsNonEmpty: true,
        bootstrap: {
          stage: "service",
          backendInstalled: true,
          steps: [{ id: "service", state: "running" }],
        },
      },
    ];
    for (const state of states) {
      expect(resolveAndroidInstallState(state, null, transportError).clientError).toBeNull();
    }
  });

  test("actual installation errors remain visible while transport cannot connect", () => {
    const state = resolveAndroidInstallState(
      {
        bootstrap: { stage: "failed", error: "Not enough free storage" },
      },
      null,
      transportError
    );
    expect(state.backendError).toBe("Not enough free storage");
    expect(state.clientError).toBeNull();
    expect(state.awaitingChannel).toBe(false);
    expect(state.showChannelChoice).toBe(true);
  });

  test("an installed backend keeps channel changes in settings even after a startup failure", () => {
    const state = resolveAndroidInstallState(
      {
        baasRootExistsNonEmpty: true,
        channel: "stable",
        bootstrap: { stage: "failed", error: "Missing service dependency" },
      },
      null,
      null
    );
    expect(state.awaitingChannel).toBe(false);
    expect(state.showChannelChoice).toBe(false);
    expect(state.channel).toBe("stable");
    expect(state.selectedChannel).toBe("stable");
  });

  test("client failures are visible after the backend confirms its listening port", () => {
    const state = resolveAndroidInstallState(
      {
        bootstrap: {
          stage: "service",
          backendInstalled: true,
          steps: [{ id: "service", state: "done", detail: "Listening on 127.0.0.1:8190" }],
        },
      },
      null,
      "Authentication failed"
    );
    expect(state.clientError).toBe("Authentication failed");
  });

  test("a failed listening-port probe retains its real error and retry controls", () => {
    const detail = "Port 8190 did not accept connections within 60s";
    const state = resolveAndroidInstallState(
      {
        bootstrap: {
          stage: "service",
          backendInstalled: true,
          steps: [{ id: "service", state: "failed", detail }],
        },
      },
      null,
      transportError
    );
    expect(state.backendError).toBe(detail);
    expect(state.clientError).toBeNull();
    expect(state.awaitingChannel).toBe(false);
  });

  test("the expected transport startup cooldown stays hidden after the service becomes ready", () => {
    const state = resolveAndroidInstallState(
      {
        bootstrap: {
          stage: "service",
          backendInstalled: true,
          steps: [{ id: "service", state: "done" }],
        },
      },
      null,
      transportError
    );
    expect(state.clientError).toBeNull();
  });

  test("older installed backends without steps retain service-stage client diagnostics", () => {
    const state = resolveAndroidInstallState(
      {
        baasRootExistsNonEmpty: true,
        bootstrap: { stage: "service" },
      },
      null,
      "Control connection closed"
    );
    expect(state.clientError).toBe("Control connection closed");
  });
});

describe("Android channel selection recovery", () => {
  test("a fresh waiting bootstrap continues after selection without a process restart", async () => {
    const requests: unknown[] = [];
    await submitAndroidInstallChannel(
      async (command, args) => {
        requests.push({ command, args });
      },
      "dev",
      false
    );
    expect(requests).toEqual([{ command: "updater_select_channel", args: { channel: "dev" } }]);
  });

  test("a failed installation restarts only after its replacement channel has been saved", async () => {
    const commands: string[] = [];
    let finishSelection!: () => void;
    const submitted = submitAndroidInstallChannel(
      async (command) => {
        commands.push(command);
        if (command === "updater_select_channel") {
          await new Promise<void>((resolve) => {
            finishSelection = resolve;
          });
        }
      },
      "dev",
      true
    );
    expect(commands).toEqual(["updater_select_channel"]);
    finishSelection();
    await submitted;
    expect(commands).toEqual(["updater_select_channel", "updater_restart_backend"]);
  });

  test("a failed channel write does not restart with the previous channel", async () => {
    const commands: string[] = [];
    await expect(
      submitAndroidInstallChannel(
        async (command) => {
          commands.push(command);
          throw new Error("Unable to persist channel");
        },
        "dev",
        true
      )
    ).rejects.toThrow("Unable to persist channel");
    expect(commands).toEqual(["updater_select_channel"]);
  });
});
