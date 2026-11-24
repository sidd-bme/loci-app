import { ipcMain, screen, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  STUDY_NAVIGATOR_IPC as prefix,
  sameStudyNavigatorTarget,
  type StudyNavigatorAction,
  type StudyNavigatorBinding,
  type StudyNavigatorLifecycle,
  type StudyNavigatorOpenOptions,
  type StudyNavigatorSnapshot,
  type StudyNavigatorState,
  type StudyNavigatorTarget,
} from "../shared/study-navigator-api";
import { placePanelAtPointer, wantsPanelAtPointer } from "./panel-drop-position";

type NavigatorWindowFactory = (owner: BrowserWindow) => { window: BrowserWindow; load: () => Promise<void> };
type Entry = {
  window: BrowserWindow;
  sender: WebContents;
  state: StudyNavigatorState;
  ready: boolean;
};
type CloseReason = NonNullable<StudyNavigatorLifecycle["reason"]>;

const invalid = () => new Error("The Images navigator request is invalid or stale.");
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

function checkOpenOptions(options: unknown): boolean {
  try {
    return wantsPanelAtPointer(options);
  } catch {
    throw invalid();
  }
}

function checkSnapshot(target: StudyNavigatorTarget, snapshot: StudyNavigatorSnapshot): void {
  if (
    !target ||
    (target.projectId !== null && (typeof target.projectId !== "string" || !target.projectId)) ||
    !isIndex(target.studyGeneration) ||
    !isIndex(target.documentGeneration) ||
    !snapshot ||
    typeof snapshot.studyName !== "string" ||
    !Array.isArray(snapshot.sources) ||
    !Array.isArray(snapshot.selectedSourceIds) ||
    typeof snapshot.reorderDisabled !== "boolean" ||
    typeof snapshot.busy !== "boolean"
  ) {
    throw invalid();
  }
  const byId = new Map<string, string>();
  for (const source of snapshot.sources) {
    if (
      !source ||
      typeof source.id !== "string" ||
      !source.id ||
      !isSha256(source.sha256) ||
      typeof source.name !== "string" ||
      byId.has(source.id) ||
      !source.metadata ||
      typeof source.metadata !== "object"
    ) {
      throw invalid();
    }
    byId.set(source.id, source.sha256);
  }
  if (snapshot.activeSourceId === null) {
    if (snapshot.activeSourceSha256 !== null) throw invalid();
  } else {
    if (typeof snapshot.activeSourceId !== "string" || !isSha256(snapshot.activeSourceSha256)) throw invalid();
    if (byId.get(snapshot.activeSourceId) !== snapshot.activeSourceSha256) throw invalid();
  }
  for (const id of snapshot.selectedSourceIds) {
    if (typeof id !== "string" || !byId.has(id)) throw invalid();
  }
  if (snapshot.resultCounts !== undefined) {
    if (typeof snapshot.resultCounts !== "object" || snapshot.resultCounts === null) throw invalid();
    for (const [id, count] of Object.entries(snapshot.resultCounts)) {
      if (!byId.has(id) || !isIndex(count)) throw invalid();
    }
  }
}

function validAction(snapshot: StudyNavigatorSnapshot, action: StudyNavigatorAction): boolean {
  if (!action || typeof action !== "object") return false;
  const byId = new Map(snapshot.sources.map((source) => [source.id, source.sha256]));
  switch (action.kind) {
    case "activate": {
      if (
        typeof action.sourceId !== "string" ||
        !isSha256(action.sourceSha256) ||
        byId.get(action.sourceId) !== action.sourceSha256 ||
        !["none", "toggle", "range"].includes(action.modifier)
      ) {
        return false;
      }
      if (action.visibleSourceIds !== undefined) {
        if (!Array.isArray(action.visibleSourceIds) || action.visibleSourceIds.length > snapshot.sources.length) {
          return false;
        }
        for (const id of action.visibleSourceIds) {
          if (typeof id !== "string" || !byId.has(id)) return false;
        }
      }
      return true;
    }
    case "toggle-selection":
      return (
        typeof action.sourceId === "string" &&
        isSha256(action.sourceSha256) &&
        byId.get(action.sourceId) === action.sourceSha256
      );
    case "reorder": {
      if (snapshot.reorderDisabled || !Array.isArray(action.order) || action.order.length !== snapshot.sources.length) {
        return false;
      }
      const seen = new Set<string>();
      for (const item of action.order) {
        if (
          !item ||
          typeof item.sourceId !== "string" ||
          !isSha256(item.sourceSha256) ||
          seen.has(item.sourceId) ||
          byId.get(item.sourceId) !== item.sourceSha256
        ) {
          return false;
        }
        seen.add(item.sourceId);
      }
      return seen.size === byId.size;
    }
    default:
      return false;
  }
}

export class StudyNavigatorCoordinator {
  private main: BrowserWindow | null = null;
  private entry: Entry | null = null;
  private generation = 0;
  private shuttingDown = false;
  private readonly unsubscribe: () => void;

  constructor(
    study: { onViewDocumentChanged(listener: () => void): () => void },
    private readonly factory: NavigatorWindowFactory,
  ) {
    this.unsubscribe = study.onViewDocumentChanged(() => this.close("revoked"));
  }

  registerMain(window: BrowserWindow): void {
    this.main = window;
    window.on("closed", () => {
      if (this.main !== window) return;
      this.main = null;
      this.close("revoked");
    });
    window.webContents.on("render-process-gone", () => {
      if (this.main === window) this.close("revoked");
    });
    window.webContents.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
      if (this.main === window && (details.isMainFrame ?? isMainFrame) !== false && !(details.isSameDocument ?? isInPlace)) {
        this.close("revoked");
      }
    });
    screen.removeListener("display-removed", this.displayRemoved);
    screen.on("display-removed", this.displayRemoved);
  }

  private readonly displayRemoved = () => {
    if (this.entry) this.close("display-removed");
  };

  private sendOwner(channel: string, value: unknown): void {
    if (!this.main || this.main.isDestroyed()) return;
    const sender = this.main.webContents;
    if (sender.isDestroyed()) return;
    try {
      sender.send(prefix + channel, value);
    } catch {
      /* The owner may be navigating or shutting down. Native teardown still completes. */
    }
  }

  private lifecycle(entry: Entry, status: StudyNavigatorLifecycle["status"], reason?: CloseReason): void {
    this.sendOwner("lifecycle", { binding: entry.state.binding, status, reason } satisfies StudyNavigatorLifecycle);
  }

  private close(reason: CloseReason, alreadyClosed = false): void {
    const entry = this.entry;
    if (!entry) return;
    this.entry = null;
    this.lifecycle(entry, "closed", reason);
    if (!alreadyClosed && !entry.window.isDestroyed()) entry.window.destroy();
    if (reason !== "revoked" && this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.focus();
    }
  }

  private senderRole(event: IpcMainInvokeEvent): "owner" | "navigator" {
    if (event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw invalid();
    }
    if (this.main && !this.main.isDestroyed() && event.sender === this.main.webContents) return "owner";
    if (event.sender === this.entry?.sender) return "navigator";
    throw invalid();
  }

  private bound(binding: StudyNavigatorBinding): Entry {
    const entry = this.entry;
    if (
      !entry ||
      !binding ||
      binding.generation !== entry.state.binding.generation ||
      !sameStudyNavigatorTarget(binding, entry.state.binding)
    ) {
      throw invalid();
    }
    return entry;
  }

  private open(
    target: StudyNavigatorTarget,
    snapshot: StudyNavigatorSnapshot,
    options?: StudyNavigatorOpenOptions,
  ): StudyNavigatorBinding {
    if (this.shuttingDown || !this.main) throw invalid();
    const atPointer = checkOpenOptions(options);
    checkSnapshot(target, snapshot);
    if (this.entry && sameStudyNavigatorTarget(target, this.entry.state.binding)) {
      if (this.entry.ready) {
        if (atPointer) placePanelAtPointer(this.entry.window);
        this.entry.window.show();
        this.entry.window.focus();
      }
      return this.entry.state.binding;
    }
    this.close("revoked");
    const { window, load } = this.factory(this.main);
    if (atPointer) placePanelAtPointer(window);
    const binding: StudyNavigatorBinding = {
      projectId: target.projectId,
      studyGeneration: target.studyGeneration,
      documentGeneration: target.documentGeneration,
      generation: ++this.generation,
    };
    const entry: Entry = {
      window,
      sender: window.webContents,
      state: { binding, snapshot, sequence: 0 },
      ready: false,
    };
    this.entry = entry;
    window.on("closed", () => {
      if (this.entry === entry) this.close("native-close", true);
    });
    entry.sender.on("render-process-gone", () => {
      if (this.entry === entry) this.close("unavailable");
    });
    entry.sender.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
      if (
        this.entry === entry &&
        entry.ready &&
        (details.isMainFrame ?? isMainFrame) !== false &&
        !(details.isSameDocument ?? isInPlace)
      ) {
        this.close("unavailable");
      }
    });
    this.lifecycle(entry, "opening");
    void Promise.resolve()
      .then(() => {
        if (this.entry === entry) return load();
      })
      .then(() => {
        if (this.entry !== entry) return;
        entry.ready = true;
        window.show();
        window.focus();
        this.lifecycle(entry, "open");
      })
      .catch(() => {
        if (this.entry === entry) this.close("unavailable");
      });
    return binding;
  }

  registerIpc(): void {
    const owner = (event: IpcMainInvokeEvent) => {
      if (this.senderRole(event) !== "owner") throw invalid();
    };
    const navigator = (event: IpcMainInvokeEvent) => {
      if (this.senderRole(event) !== "navigator") throw invalid();
    };
    ipcMain.handle(
      prefix + "open",
      (event, target: StudyNavigatorTarget, snapshot: StudyNavigatorSnapshot, options?: StudyNavigatorOpenOptions) => {
        owner(event);
        return this.open(target, snapshot, options);
      },
    );
    ipcMain.handle(
      prefix + "publish",
      (event, binding: StudyNavigatorBinding, snapshot: StudyNavigatorSnapshot, rejected?: boolean) => {
        owner(event);
        const entry = this.bound(binding);
        checkSnapshot(entry.state.binding, snapshot);
        const sequence = entry.state.sequence + 1;
        entry.state = {
          ...entry.state,
          snapshot,
          sequence,
          ...(rejected === true ? { rejectedSequence: sequence } : {}),
        };
        entry.sender.send(prefix + "state-changed", entry.state);
      },
    );
    ipcMain.handle(prefix + "state", (event) => {
      navigator(event);
      return this.entry!.state;
    });
    ipcMain.handle(prefix + "act", (event, binding: StudyNavigatorBinding, action: StudyNavigatorAction) => {
      navigator(event);
      const entry = this.bound(binding);
      if (!entry.ready || !validAction(entry.state.snapshot, action)) throw invalid();
      this.sendOwner("owner-action", { binding: entry.state.binding, action });
    });
    ipcMain.handle(prefix + "focus", (event, binding: StudyNavigatorBinding) => {
      owner(event);
      const entry = this.bound(binding);
      if (entry.ready) {
        entry.window.show();
        entry.window.focus();
      }
    });
    ipcMain.handle(prefix + "dock", (event, binding: StudyNavigatorBinding) => {
      this.senderRole(event);
      this.bound(binding);
      this.close("dock");
    });
    ipcMain.handle(prefix + "revoke", (event, binding: StudyNavigatorBinding) => {
      owner(event);
      if (this.entry?.state.binding.generation === binding?.generation) {
        this.bound(binding);
        this.close("revoked");
      }
    });
  }

  suspend(): void {
    this.shuttingDown = true;
    this.close("revoked");
  }

  resume(): void {
    this.shuttingDown = false;
  }

  dispose(): void {
    this.suspend();
    this.unsubscribe();
    screen.removeListener("display-removed", this.displayRemoved);
  }
}
