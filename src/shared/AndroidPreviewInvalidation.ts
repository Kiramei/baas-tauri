/** Ignore log/token churn; only actual overlay changes can cover the native host. */
export const ANDROID_PREVIEW_BLOCKERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-native-preview-blocker]';

const element = (node: Node): Element | null => (node.nodeType === 1 ? (node as Element) : null);
const containsBlocker = (node: Node): boolean => {
  const value = element(node);
  return Boolean(
    value &&
    (value.matches(ANDROID_PREVIEW_BLOCKERS) || value.querySelector(ANDROID_PREVIEW_BLOCKERS))
  );
};

export function invalidatesAndroidPreview(records: readonly MutationRecord[]): boolean {
  return records.some((record) => {
    const target = element(record.target);
    if (record.type === "attributes") {
      // Removing the marker must invalidate too: it may no longer match after mutation.
      return (
        record.attributeName === "data-native-preview-blocker" ||
        Boolean(
          target?.closest(ANDROID_PREVIEW_BLOCKERS) ||
          target?.querySelector(ANDROID_PREVIEW_BLOCKERS)
        )
      );
    }
    if (record.type !== "childList") return false;
    if (target?.closest(ANDROID_PREVIEW_BLOCKERS)) return true;
    return (
      Array.from(record.addedNodes).some(containsBlocker) ||
      Array.from(record.removedNodes).some(containsBlocker)
    );
  });
}
