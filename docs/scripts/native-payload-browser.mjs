// These functions run inside the existing release WebView, without replacing its APIs.
export async function switchPayloadTransport({ mode, id }) {
  const store = window.__docsPayloadStore;
  const started = performance.now();
  if (Object.values(store.getState().statusStore).some((status) => status.running))
    throw Error("Tasks started; refusing to restart the backend");
  await store.getState().setTransportMode(mode);
  const deadline = performance.now() + 60000;
  while (
    !store.getState()._all_data_initialized ||
    store.getState()._auth_phase !== "authenticated"
  ) {
    if (performance.now() > deadline) throw Error("Transport initialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const state = store.getState();
  if (
    state.transportMode !== mode ||
    !state.configStore[id] ||
    state.configStore[id].autostart ||
    Object.values(state.statusStore).some((status) => status.running)
  )
    throw Error("Unsafe ready state");
  return {
    readinessMs: performance.now() - started,
    channels: Object.keys(state.connections).sort(),
  };
}

export async function preparePayload({
  id,
  payloadField,
  blockField,
  payload,
  block,
  baseline,
  restore = false,
}) {
  const store = window.__docsPayloadStore;
  const canonical = (value) =>
    JSON.stringify(value, function (_, item) {
      return item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]])
          )
        : item;
    });
  let state = store.getState();
  const current = { ...state.configStore[id] };
  delete current[payloadField];
  delete current[blockField];
  if (
    canonical(current) !== canonical(baseline) ||
    baseline.autostart ||
    Object.values(state.statusStore).some((status) => status.running)
  )
    throw Error("Demo configuration changed");
  if (restore) {
    const refresh = async () => {
      const previous = store.getState().configStore[id];
      store.getState().send("sync", { type: "pull", resource: "config", resource_id: id });
      const deadline = performance.now() + 10000;
      while (store.getState().configStore[id] === previous) {
        if (performance.now() > deadline) throw Error("Cleanup snapshot timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await refresh();
    state = store.getState();
    const ops = [payloadField, blockField]
      .filter((key) => Object.hasOwn(state.configStore[id], key))
      .map((key) => ({ op: "remove", path: "/" + key }));
    if (ops.length) {
      let timestamp = Date.now();
      while (store.getState().pendingCallbacks[timestamp]) timestamp++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          delete store.getState().pendingCallbacks[timestamp];
          reject(Error("Cleanup patch acknowledgement timed out"));
        }, 10000);
        store.getState().pendingCallbacks[timestamp] = () => {
          clearTimeout(timer);
          resolve();
        };
        store
          .getState()
          .send("sync", { type: "patch", resource: "config", resource_id: id, timestamp, ops });
      });
      // The release Store handles remove notifications by requesting a list.
      // Pull the full document so removed fields also disappear from the Store.
      await refresh();
    }
  } else store.getState().modify(id + "::config", { [payloadField]: payload, [blockField]: block });
  const expected = restore
    ? baseline
    : { ...baseline, [payloadField]: payload, [blockField]: block };
  const deadline = performance.now() + 15000;
  while (
    canonical(store.getState().configStore[id]) !== canonical(expected) ||
    Object.keys(store.getState().pendingCallbacks).length
  ) {
    if (performance.now() > deadline) throw Error("Configuration patch did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Config writes and their push notifications are setup, never timed requests.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { decodedConfigJsonBytes: new TextEncoder().encode(JSON.stringify(expected)).length };
}

export async function measurePayloadBlock({ id, expected, warmup, samples, blockSize }) {
  const store = window.__docsPayloadStore;
  const canonical = (value) =>
    JSON.stringify(value, function (_, item) {
      return item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]])
          )
        : item;
    });
  const expectedJson = canonical(expected);
  const sizes = new Set();
  const result = {
    warmupMs: [],
    samplesMs: [],
    blockMeansMs: [],
    failures: [],
    unexpectedUpdates: 0,
    validated: 0,
  };
  let previous = store.getState().configStore[id];
  let pending = null;
  const unsubscribe = store.subscribe((state) => {
    const config = state.configStore[id];
    if (config === previous) return;
    previous = config;
    const elapsedMs = pending ? performance.now() - pending.started : null;
    if (!pending) {
      result.unexpectedUpdates++;
      return;
    }
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    request.resolve({ config, elapsedMs });
  });
  async function request(phase, index) {
    if (
      result.unexpectedUpdates ||
      pending ||
      document.visibilityState !== "visible" ||
      Object.values(store.getState().statusStore).some((status) => status.running)
    )
      throw Error("Unexpected benchmark state");
    const response = await new Promise((resolve, reject) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        pending = null;
        reject(Error("Snapshot response timed out"));
      }, 10000);
      pending = { started, timer, resolve };
      store.getState().send("sync", { type: "pull", resource: "config", resource_id: id });
    });
    // Stop the timer at the production Store notification, before full-content validation.
    if (canonical(response.config) !== expectedJson) throw Error("Snapshot content mismatch");
    sizes.add(new TextEncoder().encode(JSON.stringify(response.config)).length);
    result.validated++;
    result[phase].push(response.elapsedMs);
  }
  try {
    for (let index = 0; index < warmup; index++) await request("warmupMs", index);
    for (let offset = 0; offset < samples; offset += blockSize) {
      const started = performance.now();
      for (let index = offset; index < Math.min(offset + blockSize, samples); index++)
        await request("samplesMs", index);
      result.blockMeansMs.push(
        (performance.now() - started) / Math.min(blockSize, samples - offset)
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (result.unexpectedUpdates) throw Error("Unsolicited configuration update");
    result.finalReady = store.getState()._all_data_initialized;
    result.finalMode = store.getState().transportMode;
    result.decodedConfigJsonBytes = [...sizes];
  } catch (error) {
    result.failures.push({
      reason: error.message,
      completedWarmup: result.warmupMs.length,
      completedSamples: result.samplesMs.length,
    });
  } finally {
    unsubscribe();
    if (pending) clearTimeout(pending.timer);
  }
  return result;
}
