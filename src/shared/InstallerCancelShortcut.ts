type InstallerKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "defaultPrevented"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
>;

/** Escape belongs to the running installer only when no dialog or menu owns it. */
export function shouldCancelInstallerFromEscape(
  event: InstallerKeyEvent,
  context: { running: boolean; blocked: boolean; pending: boolean }
): boolean {
  return (
    context.running &&
    !context.blocked &&
    !context.pending &&
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}
