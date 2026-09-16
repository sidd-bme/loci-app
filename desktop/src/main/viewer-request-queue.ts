export class ViewerRequestSupersededError extends Error {
  constructor() {
    super("View superseded by a newer request.");
    this.name = "ViewerRequestSupersededError";
  }
}

interface PendingRequest {
  key: string;
  operation: string;
  request: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_PENDING_VIEW_LANES = 32;

export const VIEW_OPERATIONS: ReadonlySet<string> = new Set([
  "view", "volume_view", "result_view", "viewer_tile", "viewer_volume", "viewer_histogram",
]);

/** Serialize decoding, retaining one pending request per independent view kind and renderer lane. */
export class ViewerRequestQueue {
  private active = false;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly run: (operation: string, request: unknown) => Promise<unknown>,
  ) {}

  request<T>(operation: string, request: unknown, lane = "default"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!VIEW_OPERATIONS.has(operation)) {
        reject(new Error("Unsupported viewer request kind."));
        return;
      }
      const key = `${operation}\u0000${lane}`;
      const next: PendingRequest = {
        key,
        operation,
        request,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (!this.active) {
        this.start(next);
        return;
      }
      const previous = this.pending.get(key);
      if (!previous && this.pending.size >= MAX_PENDING_VIEW_LANES) {
        reject(new Error("Too many independent viewer requests are waiting."));
        return;
      }
      if (previous) {
        previous.reject(new ViewerRequestSupersededError());
        // Reinsert at the back so a busy lane cannot starve another pane.
        this.pending.delete(key);
      }
      this.pending.set(key, next);
    });
  }

  cancelPending(error: Error = new Error("View cancelled.")): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private start(request: PendingRequest): void {
    this.active = true;
    Promise.resolve()
      .then(() => this.run(request.operation, request.request))
      .then(request.resolve, request.reject)
      .finally(() => {
        this.active = false;
        const pending = this.pending.values().next().value;
        if (pending) {
          this.pending.delete(pending.key);
          this.start(pending);
        }
      });
  }
}
