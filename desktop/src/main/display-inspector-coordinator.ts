import { ipcMain, screen, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  DISPLAY_INSPECTOR_IPC as prefix, sameDisplayTarget,
  type DisplayInspectorAction, type DisplayInspectorBinding, type DisplayInspectorLifecycle,
  type DisplayInspectorState, type DisplayInspectorTarget, type InspectorAction, type InspectorSnapshot,
} from "../shared/display-inspector-api";
import { MAX_PREPROCESS_DRAFT_LENGTH, PREPROCESS_OPS, type PreprocessInspectorEdit } from "../shared/preprocess-inspector-api";

import { placePanelAtPointer, wantsPanelAtPointer } from "./panel-drop-position";

type InspectorWindowFactory = (owner: BrowserWindow, kind: DisplayInspectorTarget["kind"]) => { window: BrowserWindow; load: () => Promise<void> };
type Entry = { window: BrowserWindow; sender: WebContents; state: DisplayInspectorState; ready: boolean; comparing: boolean; lastRequest: number };
type CloseReason = NonNullable<DisplayInspectorLifecycle["reason"]>;
const invalid = () => new Error("The inspector request is invalid or stale.");
const isIndex = (index: unknown): index is number => Number.isSafeInteger(index) && Number(index) >= 0;

function checkSnapshot(target: DisplayInspectorTarget, snapshot: InspectorSnapshot): void {
  // Only the registered owner can supply a snapshot. Check its target at each publication.
  if (!target || typeof target.sourceId !== "string" || !target.sourceId ||
    typeof target.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(target.sourceSha256) ||
    !isIndex(target.studyGeneration) || !isIndex(target.documentGeneration) ||
    (target.kind !== undefined && target.kind !== "preprocess") || snapshot?.kind !== target.kind ||
    snapshot?.source?.id !== target.sourceId || snapshot.source.sha256 !== target.sourceSha256 ||
    (snapshot.kind === "preprocess" && snapshot.restoreNumbers !== undefined && typeof snapshot.restoreNumbers !== "boolean")) throw invalid();
}

function validPreprocessEdit(edit: PreprocessInspectorEdit): boolean {
  if (!edit) return false;
  switch (edit.kind) {
    case "add": return PREPROCESS_OPS.includes(edit.op);
    case "whole": case "draw": case "cancel-draw": case "preview": case "restore-numbers": return isIndex(edit.revision);
    case "select": case "remove": case "revert": return isIndex(edit.id);
    case "draft": return isIndex(edit.id) && typeof edit.text === "string" && edit.text.length <= MAX_PREPROCESS_DRAFT_LENGTH;
    case "clip": return isIndex(edit.id) && typeof edit.checked === "boolean";
    case "move": return isIndex(edit.id) && (edit.delta === -1 || edit.delta === 1);
    default: return false;
  }
}

function validAction(action: DisplayInspectorAction): boolean {
  if (!action) return false;
  switch (action.kind) {
    case "channel": {
      if (!isIndex(action.channel) || !action.edit) return false;
      const { field, value } = action.edit;
      if (field === "visible") return typeof value === "boolean";
      if (field === "color") return typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value);
      return ["low", "high", "window", "level", "gamma", "opacity"].includes(field) && Number.isFinite(value);
    }
    case "plane": return ["t", "c", "z"].includes(action.axis) && isIndex(action.value);
    case "projection": return ["plane", "max", "mean"].includes(action.value);
    case "auto": return (action.channel === undefined || isIndex(action.channel)) &&
      Boolean(action.plane && isIndex(action.plane.t) && isIndex(action.plane.c) && isIndex(action.plane.z));
    case "reset": return true;
    case "compare": return typeof action.active === "boolean";
    default: return false;
  }
}

export class DisplayInspectorCoordinator {
  private main: BrowserWindow | null = null;
  private entry: Entry | null = null;
  private generation = 0;
  private shuttingDown = false;
  private readonly unsubscribe: () => void;

  constructor(study: { onViewDocumentChanged(listener: () => void): () => void }, private readonly factory: InspectorWindowFactory) {
    this.unsubscribe = study.onViewDocumentChanged(() => this.close("revoked"));
  }

  registerMain(window: BrowserWindow): void {
    this.main = window;
    window.on("closed", () => {
      if (this.main !== window) return;
      this.main = null;
      this.close("revoked");
    });
    window.webContents.on("render-process-gone", () => { if (this.main === window) this.close("revoked"); });
    window.webContents.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
      if (this.main === window && (details.isMainFrame ?? isMainFrame) !== false && !(details.isSameDocument ?? isInPlace)) this.close("revoked");
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
    try { sender.send(prefix + channel, value); }
    catch { /* The owner may be navigating or shutting down. Native teardown still completes. */ }
  }

  private lifecycle(entry: Entry, status: DisplayInspectorLifecycle["status"], reason?: CloseReason): void {
    this.sendOwner("lifecycle", { binding: entry.state.binding, status, reason } satisfies DisplayInspectorLifecycle);
  }

  private requestPreprocessDock(entry: Entry): void {
    if (entry.state.dockRequested) return;
    entry.state = { ...entry.state, sequence: entry.state.sequence + 1, dockRequested: true };
    try { entry.sender.send(prefix + "state-changed", entry.state); }
    catch { this.close("unavailable"); }
  }

  private releaseCompare(entry: Entry): void {
    if (!entry.comparing) return;
    entry.comparing = false;
    this.sendOwner("owner-edit", { binding: entry.state.binding, action: { kind: "compare", active: false } });
  }

  private close(reason: CloseReason, alreadyClosed = false): void | "unavailable" {
    const entry = this.entry;
    if (!entry) return;
    this.entry = null;
    this.releaseCompare(entry);
    const pendingEdit = reason === "revoked" && entry.lastRequest > (entry.state.acknowledgedRequest ?? 0);
    this.lifecycle(entry, "closed", pendingEdit ? "unavailable" : reason);
    if (!alreadyClosed && !entry.window.isDestroyed()) entry.window.destroy();
    if (reason !== "revoked" && this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.focus();
    }
    if (pendingEdit) return "unavailable";
  }

  private senderRole(event: IpcMainInvokeEvent): "owner" | "inspector" {
    if (event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw invalid();
    if (this.main && !this.main.isDestroyed() && event.sender === this.main.webContents) return "owner";
    if (event.sender === this.entry?.sender) return "inspector";
    throw invalid();
  }

  private bound(binding: DisplayInspectorBinding): Entry {
    const entry = this.entry;
    if (!entry || !binding || binding.generation !== entry.state.binding.generation ||
      !sameDisplayTarget(binding, entry.state.binding)) throw invalid();
    return entry;
  }

  private open(target: DisplayInspectorTarget, snapshot: InspectorSnapshot, atPointer: boolean): DisplayInspectorBinding {
    if (this.shuttingDown || !this.main) throw invalid();
    checkSnapshot(target, snapshot);
    if (this.entry && sameDisplayTarget(target, this.entry.state.binding)) {
      if (this.entry.ready) { this.entry.window.show(); this.entry.window.focus(); }
      return this.entry.state.binding;
    }
    if (this.entry && this.entry.state.binding.kind !== target.kind) throw invalid();
    this.close("revoked");
    const { window, load } = this.factory(this.main, target.kind);
    if (atPointer) {
      try { placePanelAtPointer(window); }
      catch (error) { window.destroy(); throw error; }
    }
    const binding = { ...(target.kind ? { kind: target.kind } : {}), sourceId: target.sourceId, sourceSha256: target.sourceSha256,
      studyGeneration: target.studyGeneration, documentGeneration: target.documentGeneration, generation: ++this.generation };
    const entry: Entry = { window, sender: window.webContents, state: { binding, snapshot, sequence: 0 }, ready: false, comparing: false, lastRequest: 0 };
    this.entry = entry;
    window.on("blur", () => { if (this.entry === entry) this.releaseCompare(entry); });
    window.on("close", (event) => {
      if (this.entry !== entry || !entry.ready || binding.kind !== "preprocess") return;
      event.preventDefault();
      this.requestPreprocessDock(entry);
    });
    window.on("unresponsive", () => {
      if (this.entry === entry && entry.state.dockRequested) this.close("unavailable");
    });
    window.on("closed", () => { if (this.entry === entry) this.close("native-close", true); });
    entry.sender.on("render-process-gone", () => { if (this.entry === entry) this.close("unavailable"); });
    entry.sender.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
      if (this.entry === entry && entry.ready && (details.isMainFrame ?? isMainFrame) !== false &&
          !(details.isSameDocument ?? isInPlace)) this.close("unavailable");
    });
    this.lifecycle(entry, "opening");
    void Promise.resolve().then(() => {
      if (this.entry === entry) return load();
    }).then(() => {
      if (this.entry !== entry) return;
      entry.ready = true;
      window.show();
      window.focus();
      this.lifecycle(entry, "open");
    }).catch(() => { if (this.entry === entry) this.close("unavailable"); });
    return binding;
  }

  registerIpc(): void {
    const owner = (event: IpcMainInvokeEvent) => { if (this.senderRole(event) !== "owner") throw invalid(); };
    const inspector = (event: IpcMainInvokeEvent) => { if (this.senderRole(event) !== "inspector") throw invalid(); };
    ipcMain.handle(prefix + "open", (event, target: DisplayInspectorTarget, snapshot: InspectorSnapshot, options?: unknown) => {
      owner(event);
      return this.open(target, snapshot, wantsPanelAtPointer(options));
    });
    ipcMain.handle(prefix + "publish", (event, binding: DisplayInspectorBinding, snapshot: InspectorSnapshot, rejected?: boolean, request?: number) => {
      owner(event);
      const entry = this.bound(binding);
      checkSnapshot(entry.state.binding, snapshot);
      const sequence = entry.state.sequence + 1;
      if (request !== undefined && (binding.kind !== "preprocess" || !isIndex(request) ||
        request !== (entry.state.acknowledgedRequest ?? 0) + 1 || request > entry.lastRequest)) throw invalid();
      entry.state = { ...entry.state, snapshot, sequence, ...(rejected === true ? { rejectedSequence: sequence } : {}),
        ...(request !== undefined ? { acknowledgedRequest: request } : {}) };
      entry.sender.send(prefix + "state-changed", entry.state);
    });
    ipcMain.handle(prefix + "state", (event) => { inspector(event); return this.entry!.state; });
    ipcMain.handle(prefix + "edit", (event, binding: DisplayInspectorBinding, action: InspectorAction) => {
      inspector(event);
      const entry = this.bound(binding);
      if (!entry.ready || !action) throw invalid();
      if (action.kind === "preprocess") {
        if (binding.kind !== "preprocess" || action.request !== entry.lastRequest + 1 || !validPreprocessEdit(action.edit)) throw invalid();
        entry.lastRequest = action.request;
        this.sendOwner("owner-edit", { binding: entry.state.binding, action });
        if (action.edit.kind === "draw" && entry.state.snapshot.kind === "preprocess" &&
            action.edit.revision === entry.state.snapshot.revision && this.main && !this.main.isDestroyed()) {
          if (this.main.isMinimized()) this.main.restore();
          this.main.focus();
        }
        return;
      }
      if (binding.kind || !validAction(action)) throw invalid();
      if (action.kind === "compare") {
        if (!action.active) { this.releaseCompare(entry); return; }
        if (!entry.window.isFocused() || entry.comparing) return;
        entry.comparing = true;
      }
      this.sendOwner("owner-edit", { binding: entry.state.binding, action });
    });
    ipcMain.handle(prefix + "focus", (event, binding: DisplayInspectorBinding) => {
      owner(event);
      const entry = this.bound(binding);
      if (entry.ready) { entry.window.show(); entry.window.focus(); }
    });
    ipcMain.handle(prefix + "dock", (event, binding: DisplayInspectorBinding, interrupted?: true) => {
      const role = this.senderRole(event);
      const entry = this.bound(binding);
      if (binding.kind === "preprocess") {
        if (role === "owner" && entry.ready) { this.requestPreprocessDock(entry); return; }
        if (role === "inspector" && interrupted === true) { this.close("unavailable"); return; }
        if (entry.lastRequest !== (entry.state.acknowledgedRequest ?? 0)) throw invalid();
      }
      this.close("dock");
    });
    ipcMain.handle(prefix + "revoke", (event, binding: DisplayInspectorBinding) => {
      owner(event);
      if (this.entry?.state.binding.generation === binding?.generation) {
        this.bound(binding);
        return this.close("revoked");
      }
    });
  }

  suspend(): void {
    this.shuttingDown = true;
    this.close("revoked");
  }

  resume(): void { this.shuttingDown = false; }

  dispose(): void {
    this.suspend();
    this.unsubscribe();
    screen.removeListener("display-removed", this.displayRemoved);
  }
}
