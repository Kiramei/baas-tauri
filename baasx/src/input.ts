/** Give long-running operations Ctrl+C ownership between temporary readline prompts. */
export function cancellationInput(controller: AbortController): () => void {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const onData = (chunk: Buffer | string) => {
    if (chunk.includes("\x03")) controller.abort(new DOMException("操作已取消", "AbortError"));
  };
  input.on("data", onData);
  input.setRawMode(true);
  input.resume();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    input.removeListener("data", onData);
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  };
}
