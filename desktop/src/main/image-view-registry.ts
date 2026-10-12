import { randomUUID } from "node:crypto";

import {
  type ImageViewBindingInput,
  type ImageViewTargetSnapshot,
  MAX_CONTROL_VIEWS,
  MAX_IMAGE_VIEWS,
  validateImageViewBindingInput,
  validateTargetSnapshot,
} from "../shared/image-view-contracts";

interface ImageViewEntry {
  readonly viewId: string;
  readonly sessionEpoch: string;
  generation: number;
  sourceId: string;
  sourceSha256: string;
  resultId: string | null;
  resultRevisionHash: string | null;
}

function createDefensiveSnapshot(entry: ImageViewEntry): ImageViewTargetSnapshot {
  return Object.freeze({
    viewId: entry.viewId,
    sessionEpoch: entry.sessionEpoch,
    generation: entry.generation,
    sourceId: entry.sourceId,
    sourceSha256: entry.sourceSha256,
    resultId: entry.resultId,
    resultRevisionHash: entry.resultRevisionHash,
  });
}

function assertValidSenderIdentity(sender: unknown): void {
  if (sender === null || sender === undefined) {
    throw new Error("Sender identity cannot be null or undefined.");
  }
  if (
    typeof sender === "object" &&
    (sender instanceof String || sender instanceof Number || sender instanceof Boolean)
  ) {
    throw new Error("Sender identity cannot be a boxed primitive.");
  }
  if (typeof sender === "number" && !Number.isSafeInteger(sender)) {
    throw new Error("Sender identity number must be a safe integer.");
  }
}

/**
 * Pure in-memory coordinator registry for multi-window image view bindings,
 * control panel targeting, focus tracking, and pinning.
 */
export class ImageViewRegistry<TSender = unknown> {
  private sessionEpoch: string;
  private controlSender: TSender | null = null;
  private readonly imageViews = new Map<TSender, ImageViewEntry>();
  // History of focused viewIds, most recently focused at index 0
  private focusHistory: string[] = [];
  private pinnedViewId: string | null = null;

  constructor(initialEpoch?: string) {
    this.sessionEpoch = initialEpoch ?? `epoch-${randomUUID()}`;
  }

  getSessionEpoch(): string {
    return this.sessionEpoch;
  }

  registerControl(sender: TSender): void {
    assertValidSenderIdentity(sender);
    if (this.imageViews.has(sender)) {
      throw new Error("Sender is already registered as an image view.");
    }
    if (this.controlSender !== null) {
      if (this.controlSender === sender) {
        throw new Error("Control sender is already registered.");
      }
      throw new Error(`Cannot register more than ${MAX_CONTROL_VIEWS} control view.`);
    }
    this.controlSender = sender;
  }

  registerImageView(sender: TSender, binding: ImageViewBindingInput): ImageViewTargetSnapshot {
    assertValidSenderIdentity(sender);
    if (this.controlSender === sender) {
      throw new Error("Sender is already registered as a control view.");
    }
    if (this.imageViews.has(sender)) {
      throw new Error("Image view sender is already registered.");
    }
    if (this.imageViews.size >= MAX_IMAGE_VIEWS) {
      throw new Error(`Cannot register more than ${MAX_IMAGE_VIEWS} image views.`);
    }

    const validated = validateImageViewBindingInput(binding);
    const viewId = `view-${randomUUID()}`;
    const entry: ImageViewEntry = {
      viewId,
      sessionEpoch: this.sessionEpoch,
      generation: 0,
      sourceId: validated.sourceId,
      sourceSha256: validated.sourceSha256,
      resultId: validated.resultId,
      resultRevisionHash: validated.resultRevisionHash,
    };

    this.imageViews.set(sender, entry);
    // New view is immediately placed at the front of the focus history
    this.focusHistory.unshift(viewId);

    return createDefensiveSnapshot(entry);
  }

  rebindImageView(sender: TSender, binding: ImageViewBindingInput): ImageViewTargetSnapshot {
    assertValidSenderIdentity(sender);
    const entry = this.imageViews.get(sender);
    if (!entry) {
      throw new Error("Sender is not a registered image view.");
    }

    const validated = validateImageViewBindingInput(binding);
    entry.generation += 1;
    entry.sourceId = validated.sourceId;
    entry.sourceSha256 = validated.sourceSha256;
    entry.resultId = validated.resultId;
    entry.resultRevisionHash = validated.resultRevisionHash;

    return createDefensiveSnapshot(entry);
  }

  unregister(sender: TSender): void {
    if (this.controlSender === sender) {
      this.controlSender = null;
      return;
    }

    const entry = this.imageViews.get(sender);
    if (!entry) return;

    const { viewId } = entry;
    this.imageViews.delete(sender);
    this.focusHistory = this.focusHistory.filter((id) => id !== viewId);

    if (this.pinnedViewId === viewId) {
      // Closing a pinned target clears the pin and chooses the most recent live image or null
      this.pinnedViewId = null;
    }
  }

  recordFocus(sender: TSender): void {
    assertValidSenderIdentity(sender);
    if (sender === this.controlSender) {
      // Control focus keeps the current image target intact
      return;
    }
    const entry = this.imageViews.get(sender);
    if (!entry) {
      throw new Error("Cannot focus an unregistered sender.");
    }
    // Move to front of focus history
    this.focusHistory = [entry.viewId, ...this.focusHistory.filter((id) => id !== entry.viewId)];
  }

  pinTarget(viewId?: string): void {
    if (viewId !== undefined) {
      if (typeof viewId !== "string" || !viewId) {
        throw new Error("Invalid viewId to pin.");
      }
      const exists = this.findEntryByViewId(viewId);
      if (!exists) {
        throw new Error("Cannot pin unknown or inactive viewId.");
      }
      this.pinnedViewId = viewId;
      return;
    }

    const current = this.getControlTarget();
    if (!current) {
      throw new Error("Cannot pin when control has no active image target.");
    }
    this.pinnedViewId = current.viewId;
  }

  unpin(): void {
    this.pinnedViewId = null;
  }

  isPinned(): boolean {
    return this.pinnedViewId !== null;
  }

  getPinnedViewId(): string | null {
    return this.pinnedViewId;
  }

  switchStudy(): void {
    this.sessionEpoch = `epoch-${randomUUID()}`;
    this.imageViews.clear();
    this.focusHistory = [];
    this.pinnedViewId = null;
    // Retaining control registration is allowed and intended
  }

  getControlTarget(): ImageViewTargetSnapshot | null {
    if (this.pinnedViewId !== null) {
      const pinned = this.findEntryByViewId(this.pinnedViewId);
      if (pinned) return createDefensiveSnapshot(pinned);
      this.pinnedViewId = null;
    }
    for (const viewId of this.focusHistory) {
      const live = this.findEntryByViewId(viewId);
      if (live) return createDefensiveSnapshot(live);
    }
    return null;
  }

  getImageViewTarget(sender: TSender): ImageViewTargetSnapshot | null {
    const entry = this.imageViews.get(sender);
    return entry ? createDefensiveSnapshot(entry) : null;
  }

  captureTarget(sender: TSender, isMainFrame: boolean): ImageViewTargetSnapshot {
    if (!isMainFrame) {
      throw new Error("Request rejected: non-main-frame sender.");
    }
    assertValidSenderIdentity(sender);

    if (sender === this.controlSender) {
      const target = this.getControlTarget();
      if (!target) {
        throw new Error("Control sender has no active image target to capture.");
      }
      return target;
    }

    const entry = this.imageViews.get(sender);
    if (entry) {
      return createDefensiveSnapshot(entry);
    }

    throw new Error("Request rejected: unknown or destroyed sender.");
  }

  validateTarget(sender: TSender, isMainFrame: boolean, target: unknown): ImageViewTargetSnapshot {
    if (!isMainFrame) {
      throw new Error("Request rejected: non-main-frame sender.");
    }
    assertValidSenderIdentity(sender);

    const validated = validateTargetSnapshot(target);

    if (this.imageViews.has(sender)) {
      const current = this.imageViews.get(sender)!;
      if (validated.viewId !== current.viewId) {
        throw new Error("Image sender cannot target another view.");
      }
      this.assertTargetMatchesCurrent(validated, current);
      return createDefensiveSnapshot(current);
    }

    if (sender === this.controlSender) {
      const entry = this.findEntryByViewId(validated.viewId);
      if (!entry) {
        throw new Error("Target view is no longer registered or has been closed.");
      }
      this.assertTargetMatchesCurrent(validated, entry);
      return createDefensiveSnapshot(entry);
    }

    throw new Error("Request rejected: unknown or destroyed sender.");
  }

  private assertTargetMatchesCurrent(target: ImageViewTargetSnapshot, current: ImageViewEntry): void {
    if (target.sessionEpoch !== current.sessionEpoch) {
      throw new Error("Target session epoch is stale.");
    }
    if (target.generation !== current.generation) {
      throw new Error("Target generation is stale.");
    }
    if (target.sourceId !== current.sourceId) {
      throw new Error("Target source ID is mismatched.");
    }
    if (target.sourceSha256 !== current.sourceSha256) {
      throw new Error("Target source hash is mismatched.");
    }
    if (target.resultId !== current.resultId) {
      throw new Error("Target result ID is mismatched.");
    }
    if (target.resultRevisionHash !== current.resultRevisionHash) {
      throw new Error("Target result revision hash is mismatched.");
    }
  }

  private findEntryByViewId(viewId: string): ImageViewEntry | null {
    for (const entry of this.imageViews.values()) {
      if (entry.viewId === viewId) return entry;
    }
    return null;
  }

  getImageViewCount(): number {
    return this.imageViews.size;
  }

  hasControlSender(): boolean {
    return this.controlSender !== null;
  }

  isImageSender(sender: TSender): boolean {
    return this.imageViews.has(sender);
  }

  isControlSender(sender: TSender): boolean {
    return this.controlSender === sender;
  }
}
