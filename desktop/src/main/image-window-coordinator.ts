import { screen, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { ResearchBridge } from "./research-bridge";
import { ImageWindowLayoutStore, displayForLayout, visibleImageBounds, type ImageLayout, type ImageLayoutView } from "./image-window-layout";
import { sanitizedWorkerErrorMessage } from "./worker-client";
import { ImageViewRegistry } from "./image-view-registry";
import { HEX_32_PATTERN, type ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type { ImageWindowEntry, ImageWindowPresentation, ImageWindowState } from "../shared/image-window-api";
import { imageViewDimensions, validateImagePresentation, validateImageInteraction } from "./image-window-validation";

interface Entry extends ImageWindowEntry {
  window: BrowserWindow;
  sender: WebContents;
  load: () => Promise<void>;
  presentation: ImageWindowPresentation | null;
  requestGeneration: number;
}

type WindowFactory = () => { window: BrowserWindow; load: () => Promise<void> };

/** Native sender identity owns the capability. Renderer parameters never grant a role. */
export class ImageWindowCoordinator {
  private readonly registry = new ImageViewRegistry<WebContents>();
  private readonly entries = new Map<string, Entry>();
  private control: BrowserWindow | null = null;
  private opening = false;
  private restoring = false;
  private layoutError: string | undefined;
  private layoutTimer: NodeJS.Timeout | null = null;
  private pendingLayout: { document: string; layout: ImageLayout } | null = null;

  constructor(private readonly bridge: ResearchBridge, private readonly factory: WindowFactory, private readonly layouts?: ImageWindowLayoutStore) {
    bridge.onViewDocumentChanged(() => this.revokeDocument());
  }

  registerControl(window: BrowserWindow): void {
    this.registry.registerControl(window.webContents);
    this.control = window;
    const sender = window.webContents;
    window.on("closed", () => {
      this.control = null;
      this.revokeDocument();
      this.registry.unregister(sender);
    });
  }

  private sender(event: IpcMainInvokeEvent, controlOnly = false): WebContents {
    const sender = event.sender;
    if (sender.isDestroyed() || event.senderFrame !== sender.mainFrame ||
      !(this.registry.isControlSender(sender) || (!controlOnly && this.registry.isImageSender(sender)))) {
      throw new Error("This window cannot use that image-view capability.");
    }
    return sender;
  }

  private target(event: IpcMainInvokeEvent, value: unknown, controlOnly = false): Entry {
    const sender = this.sender(event, controlOnly);
    const target = this.registry.validateTarget(sender, true, value);
    const entry = this.entries.get(target.viewId);
    if (!entry) throw new Error("This image view has closed. Reopen it from the workspace.");
    return entry;
  }

  private state(sender: WebContents): ImageWindowState {
    const control = this.registry.isControlSender(sender);
    const own = this.registry.getImageViewTarget(sender);
    return {
      role: control ? "control" : "image",
      views: [...this.entries.values()].filter((entry) => control || entry.target.viewId === own?.viewId)
        .map(({ target, source, label, status, initialPresentation, window }) => ({ target, source, label, status, initialPresentation, fullscreen: window.isFullScreen() })),
      target: control ? this.registry.getControlTarget() : own,
      pinned: this.registry.isPinned(),
      layoutError: this.layoutError,
    };
  }

  private notify(): void {
    const senders = [this.control?.webContents, ...[...this.entries.values()].map((entry) => entry.sender)];
    for (const sender of senders) {
      if (sender && !sender.isDestroyed()) sender.send("loci-image:state-changed", this.state(sender));
    }
  }

  private queueLayout(): void {
    const document = this.bridge.getViewDocumentIdentity();
    if (!this.layouts || !document || this.restoring) return;
    const entries = [...this.entries.values()];
    // Empty/returned layouts retain the last arrangement for explicit restoration.
    if (!entries.length) return;
    const pin = this.registry.getPinnedViewId();
    this.pendingLayout = { document, layout: {
      schema: "loci.image-layout/v1",
      views: entries.map((entry) => ({ sourceId: entry.target.sourceId, sourceSha256: entry.target.sourceSha256,
        bounds: entry.window.getNormalBounds(), display: displayForLayout(entry.presentation) })),
      pinnedIndex: pin === null ? null : entries.findIndex((entry) => entry.target.viewId === pin),
    } };
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => { void this.flushLayout().catch(() => {
      this.layoutError = "Could not save the local window layout. Study annotations are unaffected.";
      this.notify();
    }); }, 300);
  }

  async flushLayout(): Promise<void> {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    const pending = this.pendingLayout;
    this.pendingLayout = null;
    if (pending && this.layouts) { await this.layouts.write(pending.document, pending.layout); this.layoutError = undefined; }
  }

  private closeEntry(entry: Entry): void {
    this.bridge.cancelImageView(entry.target.viewId);
    this.registry.unregister(entry.sender);
    this.entries.delete(entry.target.viewId);
    this.queueLayout();
    if (!entry.window.isDestroyed()) entry.window.destroy();
    this.notify();
  }

  private revokeDocument(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.registry.switchStudy();
    for (const entry of entries) {
      this.bridge.cancelImageView(entry.target.viewId);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    this.notify();
  }

  private async open(sourceId: unknown, restored?: ImageLayoutView, seed?: unknown): Promise<void> {
    if (this.opening) throw new Error("An image window is already opening.");
    if (typeof sourceId !== "string" || !HEX_32_PATTERN.test(sourceId)) throw new Error("Choose a valid source image.");
    if (this.entries.size >= 2) throw new Error("Two image windows are already open. Return one to the workspace first.");
    this.opening = true;
    const epoch = this.registry.getSessionEpoch();
    try {
      const snapshot = await this.bridge.getViewSnapshot();
      if (epoch !== this.registry.getSessionEpoch()) throw new Error("The study changed while opening the view.");
      const source = snapshot.sources.find((item) => item.id === sourceId);
      if (!source || source.locator_state === "relink-required") throw new Error("Relink this image before opening a detached view.");
      if (restored && restored.sourceSha256 !== source.sha256) throw new Error("The saved layout source hash has changed. Open this image again.");
      imageViewDimensions(source);
      let initialPresentation = restored?.display ? validateImagePresentation(restored.display, source) : undefined;
      if (seed !== undefined) {
        if (!seed || typeof seed !== "object" || Array.isArray(seed) ||
          Object.keys(seed).some((key) => !["sourceSha256", "presentation"].includes(key)) ||
          (seed as { sourceSha256?: unknown }).sourceSha256 !== source.sha256)
          throw new Error("The display transfer does not match this source.");
        initialPresentation = validateImagePresentation((seed as { presentation?: unknown }).presentation, source);
        if (initialPresentation.draft.length || initialPresentation.tool !== "navigate")
          throw new Error("Finish the active drawing before detaching this image.");
      }
      const { window, load } = this.factory();
      if (restored) window.setBounds(visibleImageBounds(restored.bounds, screen.getAllDisplays().map((display) => display.workArea)));
      let target: ImageViewTargetSnapshot;
      try {
        target = this.registry.registerImageView(window.webContents, { sourceId: source.id, sourceSha256: source.sha256 });
      } catch (error) { window.destroy(); throw error; }
      const usedLabels = new Set([...this.entries.values()].map((entry) => entry.label));
      const entry: Entry = { target, source, label: usedLabels.has("A") ? "B" : "A", status: "ready", window, sender: window.webContents, load, presentation: initialPresentation ?? null, initialPresentation, requestGeneration: 0 };
      this.entries.set(target.viewId, entry);
      window.setTitle(`Loci · ${entry.label} · ${source.name}`);
      window.on("enter-full-screen", () => this.notify());
      window.on("leave-full-screen", () => this.notify());
      window.on("move", () => this.queueLayout());
      window.on("resize", () => this.queueLayout());
      window.on("focus", () => {
        if (this.registry.isImageSender(window.webContents)) {
          this.registry.recordFocus(window.webContents); this.notify();
        }
      });
      window.on("closed", () => {
        if (this.entries.get(target.viewId) === entry) this.closeEntry(entry);
      });
      window.webContents.on("render-process-gone", () => {
        this.bridge.cancelImageView(entry.target.viewId);
        entry.initialPresentation = displayForLayout(entry.presentation) ?? undefined;
        // The old command generation is revoked; the native shell remains recoverable.
        entry.target = this.registry.rebindImageView(window.webContents, {
          sourceId: source.id, sourceSha256: source.sha256,
        });
        entry.status = "crashed";
        this.notify();
      });
      try { await load(); }
      catch (error) { this.closeEntry(entry); throw error; }
      if (!this.entries.has(target.viewId)) throw new Error("The study changed while opening the view.");
      window.show();
      this.queueLayout();
      this.notify();
    } finally { this.opening = false; }
  }

  registerIpc(): void {
    const handle = (name: string, controlOnly: boolean,
      operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      ipcMain.handle(`loci-image:${name}`, async (event, ...args: unknown[]) => {
        this.sender(event, controlOnly);
        try { return await operation(event, ...args); }
        catch (error) { throw new Error(sanitizedWorkerErrorMessage(error instanceof Error ? error.message : error)); }
      });
    };
    handle("state", false, (event) => this.state(event.sender));
    handle("open", true, async (event, sourceId, seed) => {
      if (this.restoring) throw new Error("Wait for the saved layout to finish opening.");
      await this.open(sourceId, undefined, seed); return this.state(event.sender);
    });
    handle("restore", true, async (event) => {
      if (this.entries.size || this.opening || this.restoring) throw new Error("Return the current image windows before restoring a layout.");
      const document = this.bridge.getViewDocumentIdentity();
      if (!document || !this.layouts) throw new Error("Open the saved study before restoring its windows.");
      await this.flushLayout();
      const epoch = this.registry.getSessionEpoch();
      const layout = await this.layouts.read(document);
      if (!layout?.views.length) throw new Error("There is no saved image-window layout for this study yet.");
      if (epoch !== this.registry.getSessionEpoch()) throw new Error("The study changed while restoring the layout.");
      this.restoring = true;
      try {
        for (const view of layout.views) await this.open(view.sourceId, view);
        if (layout.pinnedIndex !== null) this.registry.pinTarget([...this.entries.keys()][layout.pinnedIndex]);
        this.notify();
      } catch (error) { this.revokeDocument(); throw error; }
      finally { this.restoring = false; }
      return this.state(event.sender);
    });
    handle("close", false, (event, target) => this.closeEntry(this.target(event, target)));
    handle("close-all", true, async () => { this.queueLayout(); await this.flushLayout(); this.revokeDocument(); });
    handle("pin", true, (event, target) => {
      if (target === null) this.registry.unpin();
      else this.registry.pinTarget(this.target(event, target, true).target.viewId);
      this.queueLayout(); this.notify();
    });
    handle("focus", false, (event, target) => {
      if (target === null) { this.control?.show(); this.control?.focus(); }
      else { const entry = this.target(event, target); entry.window.show(); entry.window.focus(); }
    });
    handle("fullscreen", false, (event, target, value) => {
      if (typeof value !== "boolean") throw new Error("Choose a valid fullscreen state.");
      this.target(event, target).window.setFullScreen(value);
    });
    handle("reopen", true, async (event, target) => {
      const entry = this.target(event, target, true);
      if (entry.status !== "crashed") throw new Error("This image window is already running.");
      await entry.load();
      entry.status = "ready";
      entry.window.show(); this.notify();
    });
    handle("presentation", false, (event) => {
      const target = this.registry.captureTarget(event.sender, true);
      const entry = this.entries.get(target.viewId);
      return entry?.presentation ? { target: entry.target, presentation: entry.presentation } : null;
    });
    handle("publish", true, (event, target, value) => {
      const entry = this.target(event, target, true);
      entry.presentation = validateImagePresentation(value, entry.source);
      this.queueLayout();
      if (!entry.window.webContents.isDestroyed() && entry.status === "ready") {
        entry.window.webContents.send("loci-image:presentation-changed", { target: entry.target, presentation: entry.presentation });
      }
    });
    handle("interact", false, (event, target, value) => {
      if (!this.registry.isImageSender(event.sender)) throw new Error("Only an image window can emit a viewport interaction.");
      const entry = this.target(event, target);
      const interaction = validateImageInteraction(value, entry.source);
      if (interaction.kind === "draft" && (!entry.presentation ||
        interaction.plane.t !== entry.presentation.selection.t || interaction.plane.z !== entry.presentation.selection.z))
        throw new Error("The annotation plane changed. Draw the region again on the displayed plane.");
      if (this.control && !this.control.isDestroyed()) this.control.webContents.send("loci-image:interaction", { target: entry.target, interaction });
    });
    handle("execute", false, async (event, target, operation, request, options) => {
      const entry = this.target(event, target);
      if (entry.status !== "ready") throw new Error("Reopen the crashed image window before using its controls.");
      // Fixed reservations: two views, each <=32 MiB native volume payload, one decoder.
      if (operation === "viewer_volume") {
        const limit = (request as { max_decoded_bytes?: unknown } | null)?.max_decoded_bytes;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit > 32 * 1024 ** 2 || limit < 1024 ** 2)
          throw new Error("Detached volumes require a decoded payload budget between 1 and 32 MiB.");
      }
      const generation = entry.requestGeneration;
      const assertLive = () => {
        this.target(event, target);
        if (generation !== entry.requestGeneration) throw new Error("Image view cancelled.");
      };
      const result = await this.bridge.executeImageView(entry.target, operation, request, options,
        this.registry.isControlSender(event.sender) ? "annotate" : "read", assertLive);
      this.target(event, target); // Closing, crashing or replacing a study discards a late reply.
      return result;
    });
    handle("export-figure", false, (event, target, request) => {
      const entry = this.target(event, target);
      const value = request as { source_id?: unknown; source_sha256?: unknown } | null;
      if (!value || value.source_id !== entry.target.sourceId || value.source_sha256 !== entry.target.sourceSha256)
        throw new Error("The figure does not match this image window's source.");
      return this.bridge.exportVolumeFigure(request, () => { this.target(event, target); });
    });
    handle("cancel", false, (event, target) => {
      const entry = this.target(event, target);
      entry.requestGeneration++;
      this.bridge.cancelImageView(entry.target.viewId);
    });
  }
}
