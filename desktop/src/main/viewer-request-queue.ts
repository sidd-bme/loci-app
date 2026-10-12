export class ViewerRequestSupersededError extends Error {
  constructor() {
    super("View superseded by a newer request.");
    this.name = "ViewerRequestSupersededError";
  }
}

interface PendingRequest {
  key: string;
  scope: string;
  operation: string;
  request: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ActiveRequest {
  scope: string;
  operation: string;
  request: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

const MAX_PENDING_VIEW_LANES = 32;

export const VIEW_OPERATIONS: ReadonlySet<string> = new Set([
  "view",
  "volume_view",
  "result_view",
  "viewer_tile",
  "viewer_volume",
  "viewer_histogram",
]);

// The quantitative large-result viewer belongs to the main workbench. Keep
// detached-image permissions independent from decoder scheduling capability.
export const QUEUED_VIEW_OPERATIONS: ReadonlySet<string> = new Set([
  ...VIEW_OPERATIONS,
  "large_result_view",
  "large_result_locate",
]);

/**
 * Serialize decoding, retaining one pending request per independent view kind,
 * renderer lane, and trusted main-process scope.
 */
export class ViewerRequestQueue {
  private currentActive: ActiveRequest | null = null;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly run: (operation: string, request: unknown) => Promise<unknown>,
  ) {}

  get isDecoding(): boolean {
    return this.currentActive !== null;
  }

  request<T>(
    operation: string,
    request: unknown,
    lane = "default",
    scope = "main",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!QUEUED_VIEW_OPERATIONS.has(operation)) {
        reject(new Error("Unsupported viewer request kind."));
        return;
      }
      if (typeof scope !== "string" || !scope || scope.includes("\0")) {
        reject(new Error("Invalid viewer scheduling scope."));
        return;
      }
      if (typeof lane !== "string" || !lane || lane.includes("\0")) {
        reject(new Error("Invalid viewer scheduling lane."));
        return;
      }
      const key = `${scope}\u0000${operation}\u0000${lane}`;
      const next: PendingRequest = {
        key,
        scope,
        operation,
        request,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (!this.currentActive) {
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

  cancelScope(scope: string, error: Error = new Error("View cancelled.")): void {
    if (typeof scope !== "string" || !scope) return;
    if (this.currentActive && this.currentActive.scope === scope && !this.currentActive.cancelled) {
      this.currentActive.cancelled = true;
      this.currentActive.reject(error);
    }
    const toCancel: PendingRequest[] = [];
    for (const [key, request] of this.pending.entries()) {
      if (request.scope === scope) {
        this.pending.delete(key);
        toCancel.push(request);
      }
    }
    for (const request of toCancel) {
      request.reject(error);
    }
  }

  private start(request: PendingRequest): void {
    const active: ActiveRequest = {
      scope: request.scope,
      operation: request.operation,
      request: request.request,
      resolve: request.resolve,
      reject: request.reject,
      cancelled: false,
    };
    this.currentActive = active;

    Promise.resolve()
      .then(() => this.run(active.operation, active.request))
      .then(
        (value) => {
          if (!active.cancelled) {
            active.resolve(value);
          }
        },
        (error) => {
          if (!active.cancelled) {
            active.reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      )
      .finally(() => {
        this.currentActive = null;
        const pending = this.pending.values().next().value;
        if (pending) {
          this.pending.delete(pending.key);
          this.start(pending);
        }
      });
  }
}
