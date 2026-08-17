/**
 * Small synchronous admission gate for IPC operations that must never overlap.
 * The flag is acquired before the first await, so rapid renderer submissions
 * cannot create duplicate server-side activation requests.
 */
export class ExclusiveOperationGate {
  private active = false

  async run<T>(operation: () => Promise<T>, whenBusy: () => T | Promise<T>): Promise<T> {
    if (this.active) return whenBusy()
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }
}
