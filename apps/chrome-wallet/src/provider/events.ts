type Listener = (...args: unknown[]) => void;

export class ProviderEventEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, cb: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  off(event: string, cb: Listener): void {
    this.listeners.get(event)?.delete(cb);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch {
        // swallow listener errors
      }
    });
  }
}
