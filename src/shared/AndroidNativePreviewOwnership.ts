/** Cached Home pages share one native preview host; only the visible page may control it. */
export class AndroidNativePreviewOwnership {
  private owner: object | null = null;

  acquire(owner: object): void {
    this.owner = owner;
  }

  owns(owner: object): boolean {
    return this.owner === owner;
  }

  /** True only once, and never for cleanup from a previously visible page. */
  release(owner: object): boolean {
    if (!this.owns(owner)) return false;
    this.owner = null;
    return true;
  }
}
