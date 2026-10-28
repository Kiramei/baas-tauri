export function installDeviceFixture({ owner }) {
  if (!owner || typeof owner !== "string") throw new Error("Fixture ownership is required");
  if (window.__docsDeviceFixture)
    throw new Error("A device benchmark fixture is already installed");
  const canvas = document.createElement("canvas");
  canvas.id = "docs-device-benchmark-fixture";
  canvas.style.cssText =
    "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;touch-action:none!important;display:block!important;margin:0!important;border:0!important;";
  const dpr = devicePixelRatio;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  let token = 0,
    taps = 0,
    frame = 0,
    raf,
    stopped = false,
    down,
    lastGesture;
  const state = () => ({
    token,
    taps,
    frame,
    width: innerWidth,
    height: innerHeight,
    dpr,
    lastGesture,
  });
  function bits(value, top) {
    for (let bit = 0; bit < 16; bit++) {
      context.fillStyle = value & (1 << bit) ? "#f5f5f5" : "#202020";
      context.fillRect(16 + 24 * bit, top, 18, 24);
    }
  }
  function draw() {
    if (stopped) return;
    frame = (frame + 1) & 65535;
    context.fillStyle = "#101010";
    context.fillRect(0, 0, innerWidth, innerHeight);
    context.fillStyle = "#ff00ff";
    context.fillRect(16, 16, 20, 20);
    for (const [index, color] of ["#ff0000", "#00ff00", "#0000ff"].entries()) {
      context.fillStyle = color;
      context.fillRect(60 + 32 * index, 16, 20, 20);
    }
    bits(token, 88);
    bits(taps, 128);
    bits(frame, 168);
    context.fillStyle = down ? "#38bdf8" : "#047857";
    context.fillRect(40, 240, innerWidth - 80, 200);
    context.fillStyle = "#ffffff";
    context.font = "18px sans-serif";
    context.textAlign = "center";
    context.fillText("Device benchmark", innerWidth / 2, 292);
    context.fillText("Tap " + taps, innerWidth / 2, 336);
    raf = requestAnimationFrame(draw);
  }
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    down = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      started: performance.now(),
      type: event.pointerType,
    };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      event.isTrusted &&
      down?.pointerId === event.pointerId &&
      down.y >= 240 &&
      down.y <= 440 &&
      down.x >= 40 &&
      down.x <= innerWidth - 40
    ) {
      taps++;
      lastGesture = {
        from: [down.x, down.y],
        to: [event.clientX, event.clientY],
        durationMs: performance.now() - down.started,
        type: down.type,
      };
    }
    down = undefined;
  });
  canvas.addEventListener("pointercancel", () => {
    down = undefined;
  });
  canvas.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  document.body.append(canvas);
  const expiry = setTimeout(remove, 10 * 60 * 1000);
  function remove() {
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(expiry);
    canvas.remove();
    delete window.__docsDeviceFixture;
  }
  window.__docsDeviceFixture = {
    owner,
    state,
    remove,
    setToken: async (next) => {
      if (!Number.isInteger(next) || next < 0 || next > 65535)
        throw new Error("Invalid fixture token");
      token = next;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return state();
    },
  };
  draw();
  return state();
}
