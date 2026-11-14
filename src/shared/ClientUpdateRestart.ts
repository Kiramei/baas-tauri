export type ClientUpdateResult = boolean | { restartManaged: true };

/** The portable transaction exclusively owns its exit/restart handshake. */
export async function restartUpdatedDesktopClient(
  result: ClientUpdateResult,
  relaunch: () => Promise<void>
): Promise<void> {
  if (result === false) return;
  if (result === true) {
    await relaunch();
    return;
  }
  if (result?.restartManaged === true) return;
  throw new Error("Unsupported client update result");
}
