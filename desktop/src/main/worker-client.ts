import { app } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  generation: number;
  method: string;
  sequence: number;
}

interface DurableDrainWaiter {
  generation: number;
  resolve: () => void;
}

interface WorkerResponse {
  id: string | null;
  result?: unknown;
  error?: { type?: string; message?: string };
}

interface WorkerInstance {
  child: ChildProcessWithoutNullStreams;
  generation: number;
  stdoutChunks: Buffer[];
  stdoutBytes: number;
  invalidated: boolean;
  stoppingReason?: Error;
}

export interface WorkerInvalidationEvent {
  generation: number;
  reason: Error;
}

export type WorkerInvalidationListener = (event: WorkerInvalidationEvent) => void;

// Cancellation is implemented by terminating the isolated engine process. Keep
// this allowlist deliberately narrow: methods that publish durable output must
// be allowed to finish so they cannot leave an unrecorded or incomplete batch.
const CANCELLABLE_METHODS = new Set(["segment", "research_run"]);
const DURABLE_METHODS = new Set([
  "research_vendor_convert",
  "research_agent_access",
  "research_project_export",
  "research_project_import",
  "research_project_clone",
  "research_recipe_export",
  "research_recipe_import",
  "research_source_annotations_export",
  "research_source_annotations_import",
  "research_source_rendered_export",
  "research_import_legacy_project",
  "research_relink",
  "research_export",
  "research_create",
  "research_import",
  "research_import_model",
  "research_review",
  "research_submit",
  "export",
  "export_view",
  "import_cellpose_model",
  "publish_batch_metadata",
  "publish_working_result",
  "publish_volume_figure",
  "restore_working_result",
]);
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
// A maximum 2048-square RGB display can approach 17 MiB once PNG bytes are
// base64 encoded. Linked planes and bounded volume display can approach 48 MiB
// in one JSON result. This cap leaves envelope headroom while bounding every
// worker method, including malformed output, before a complete line is built.
const MAX_RESPONSE_LINE_BYTES = 64 * 1024 * 1024;

export function sanitizedWorkerErrorMessage(value: unknown): string {
  const message = typeof value === "string" && value.trim()
    ? value.replace(/[\r\n\t\0-\x1f\x7f]+/g, " ").trim()
    : "Analysis failed.";
  return message
    .replace(/(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/)[^"'\r\n]*\1/g, "$1<local path>$1")
    .replace(/((?:^|[\s:=(]))(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/(?!\/)).*/g, "$1<local path>")
    .slice(0, 1_000);
}

export class EngineWorkerClient {
  private instance: WorkerInstance | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private nextGeneration = 0;
  private invalidationListeners = new Set<WorkerInvalidationListener>();
  private durableDrainWaiters = new Set<DurableDrainWaiter>();
  private disposing = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly maxResponseLineBytes = MAX_RESPONSE_LINE_BYTES) {
    if (!Number.isSafeInteger(maxResponseLineBytes) || maxResponseLineBytes < 1) {
      throw new Error("Engine response bound must be a positive integer.");
    }
  }

  private clearRequestTimer(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
  }

  private hasActiveDurableRequest(generation: number): boolean {
    let first: PendingRequest | undefined;
    for (const pending of this.pending.values()) {
      if (
        pending.generation === generation &&
        (!first || pending.sequence < first.sequence)
      ) {
        first = pending;
      }
    }
    return Boolean(first && DURABLE_METHODS.has(first.method));
  }

  private notifyDurableDrained(generation: number): void {
    if (this.hasActiveDurableRequest(generation)) return;
    for (const waiter of this.durableDrainWaiters) {
      if (waiter.generation !== generation) continue;
      this.durableDrainWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private waitForDurableRequests(generation: number): Promise<void> {
    if (!this.hasActiveDurableRequest(generation)) return Promise.resolve();
    return new Promise((resolve) => {
      this.durableDrainWaiters.add({ generation, resolve });
    });
  }

  private command(): { executable: string; args: string[]; cwd?: string } {
    if (app.isPackaged) {
      const executableName = process.platform === "win32" ? "loci-engine.exe" : "loci-engine";
      const executable = path.join(process.resourcesPath, "loci-engine", executableName);
      if (!existsSync(executable)) {
        throw new Error(
          "The packaged Loci analysis engine is missing. Reinstall Loci or contact support.",
        );
      }
      return { executable, args: [] };
    }

    const projectRoot = path.resolve(app.getAppPath(), "..");
    const engineRoot = path.join(projectRoot, "engine");
    const executable =
      process.platform === "win32"
        ? path.join(engineRoot, ".venv", "Scripts", "python.exe")
        : path.join(engineRoot, ".venv", "bin", "python");
    if (!existsSync(executable)) {
      throw new Error(
        "The Loci engine environment is not installed. Run `uv sync --extra dev` in engine/.",
      );
    }
    return { executable, args: ["-m", "loci_engine.worker"], cwd: engineRoot };
  }

  private ensureStarted(): WorkerInstance {
    if (this.instance && !this.instance.child.killed) return this.instance;

    const command = this.command();
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        LOCI_MODEL_HOME: path.join(app.getPath("userData"), "models"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const instance: WorkerInstance = {
      child,
      generation: ++this.nextGeneration,
      stdoutChunks: [],
      stdoutBytes: 0,
      invalidated: false,
    };
    this.instance = instance;

    child.stdout.on("data", (chunk: Buffer | string) =>
      this.handleStdout(instance, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      console.error(`[loci-engine] ${String(chunk).trimEnd()}`);
    });
    child.once("error", (error) => this.handleExit(instance, error));
    child.once("exit", (code, signal) => {
      const reason =
        instance.stoppingReason ??
        new Error(`The analysis engine stopped unexpectedly (${signal ?? code ?? "unknown"}).`);
      this.handleExit(instance, reason);
    });
    return instance;
  }

  private handleStdout(instance: WorkerInstance, chunk: Buffer): void {
    if (instance.invalidated) return;
    let offset = 0;
    while (offset < chunk.byteLength && !instance.invalidated) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const length = end - offset;
      if (instance.stdoutBytes + length > this.maxResponseLineBytes) {
        this.stopInstance(
          instance,
          new Error("Loci engine response exceeded its bounded message size."),
        );
        return;
      }
      if (length > 0) {
        // Copy the partial segment so a tiny remainder cannot retain an
        // arbitrarily larger stream chunk while waiting for the next newline.
        instance.stdoutChunks.push(Buffer.from(chunk.subarray(offset, end)));
        instance.stdoutBytes += length;
      }
      if (newline === -1) return;
      const line = Buffer.concat(instance.stdoutChunks, instance.stdoutBytes).toString("utf8");
      instance.stdoutChunks = [];
      instance.stdoutBytes = 0;
      this.handleLine(instance, line);
      offset = newline + 1;
    }
  }

  private handleLine(instance: WorkerInstance, line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.stopInstance(instance, new Error("Loci engine returned malformed JSON."));
      return;
    }
    if (response.id === null) return;
    const pending = this.pending.get(response.id);
    if (!pending || pending.generation !== instance.generation) return;
    this.clearRequestTimer(pending);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(sanitizedWorkerErrorMessage(response.error.message)));
    } else {
      pending.resolve(response.result);
    }
    this.notifyDurableDrained(instance.generation);
  }

  private handleExit(instance: WorkerInstance, error: Error): void {
    if (instance.invalidated) return;
    instance.invalidated = true;
    if (this.instance === instance) this.instance = null;
    instance.stdoutChunks = [];
    instance.stdoutBytes = 0;
    const publicError = new Error(sanitizedWorkerErrorMessage(error.message));
    if (publicError.message !== error.message) {
      console.error("Loci analysis engine stopped with a private diagnostic.", error);
    }
    for (const [id, pending] of this.pending) {
      if (pending.generation !== instance.generation) continue;
      this.clearRequestTimer(pending);
      pending.reject(publicError);
      this.pending.delete(id);
    }
    this.notifyDurableDrained(instance.generation);
    const event = { generation: instance.generation, reason: publicError };
    for (const listener of this.invalidationListeners) {
      try {
        listener(event);
      } catch (listenerError) {
        console.error("Loci engine invalidation listener failed.", listenerError);
      }
    }
  }

  private stopInstance(instance: WorkerInstance, reason: Error): void {
    instance.stoppingReason = reason;
    this.handleExit(instance, reason);
    if (!instance.child.killed) instance.child.kill();
  }

  onInvalidated(listener: WorkerInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new Error("The Loci analysis engine is shutting down."));
    }
    // Close the cancellation-registration race. Once this synchronous check
    // passes, the request is inserted into `pending` before control can return
    // to the event loop, so cancelCurrent() can reliably terminate it.
    if (signal?.aborted) {
      return Promise.reject(new Error("Analysis cancelled."));
    }
    const instance = this.ensureStarted();
    const sequence = ++this.nextId;
    const id = `desktop-${sequence}`;
    return new Promise<T>((resolve, reject) => {
      // Durable publication is allowed to finish. A generic request timeout must
      // never terminate the worker in the middle of an atomic export.
      // An explicitly unbounded task is supervised by its durable job/cancel
      // lifecycle. Zero is never an immediate timeout.
      const timer = DURABLE_METHODS.has(method) || timeoutMs === 0
        ? undefined
        : setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending || pending.generation !== instance.generation) return;
            const activeDurable = this.hasActiveDurableRequest(instance.generation);
            this.pending.delete(id);
            const error = new Error(`The ${method} operation timed out.`);
            reject(error);
            // The worker is serial. A later request may time out while an
            // earlier export is publishing; reject that later request without
            // killing the active export. A durable request queued behind this
            // timed-out request is not protected because it has not started.
            if (!activeDurable) this.stopInstance(instance, error);
          }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        generation: instance.generation,
        method,
        sequence,
      });
      try {
        instance.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending || pending.generation !== instance.generation) return;
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
          this.stopInstance(instance, error);
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        const writeError = error instanceof Error ? error : new Error(String(error));
        reject(writeError);
        this.stopInstance(instance, writeError);
      }
    });
  }

  cancelCurrent(): boolean {
    const instance = this.instance;
    if (!instance) return false;
    const currentRequests = [...this.pending.values()].filter(
      (pending) => pending.generation === instance.generation,
    );
    // Preview inspection and segmentation may be queued on the same serial
    // worker. If any segmentation is pending, terminating that generation is
    // the only reliable cancellation mechanism. Never do this once a head-of-
    // queue export is in flight because it may already be publishing an atomic
    // bundle; an export queued behind cancellable work has not started yet.
    if (
      currentRequests.length === 0 ||
      !currentRequests.some((pending) => CANCELLABLE_METHODS.has(pending.method)) ||
      this.hasActiveDurableRequest(instance.generation)
    ) {
      return false;
    }
    this.stopInstance(instance, new Error("Analysis cancelled."));
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    const instance = this.instance;
    const finish = () => {
      if (this.instance) {
        this.stopInstance(this.instance, new Error("Analysis cancelled."));
      }
      this.invalidationListeners.clear();
    };
    if (!instance || !this.hasActiveDurableRequest(instance.generation)) {
      finish();
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    this.disposePromise = this.waitForDurableRequests(instance.generation).then(finish);
    return this.disposePromise;
  }

  forceDispose(reason = new Error("Loci was force-quit before a durable operation finished.")): void {
    this.disposing = true;
    const instance = this.instance;
    if (instance) this.stopInstance(instance, reason);
    this.invalidationListeners.clear();
  }
}
