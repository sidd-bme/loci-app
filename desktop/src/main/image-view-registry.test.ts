// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  HEX_32_PATTERN,
  HEX_64_PATTERN,
  type ImageViewBindingInput,
  TARGET_SNAPSHOT_KEYS,
  validateImageViewBindingInput,
  validateTargetSnapshot,
} from "../shared/image-view-contracts";
import { ImageViewRegistry } from "./image-view-registry";

const SOURCE_A = "a".repeat(32);
const HASH_A = "1".repeat(64);
const SOURCE_B = "b".repeat(32);
const HASH_B = "2".repeat(64);
const RESULT_A = "c".repeat(32);
const RESULT_HASH_A = "3".repeat(64);

describe("image-view-contracts", () => {
  it("validates a raw source target snapshot with exactly seven keys", () => {
    const rawTarget = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: null,
    };

    const validated = validateTargetSnapshot(rawTarget);
    expect(validated).toEqual(rawTarget);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.keys(validated).sort()).toEqual([...TARGET_SNAPSHOT_KEYS].sort());
  });

  it("validates a result-bound target snapshot", () => {
    const resultTarget = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 1,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: RESULT_A,
      resultRevisionHash: RESULT_HASH_A,
    };

    const validated = validateTargetSnapshot(resultTarget);
    expect(validated.resultId).toBe(RESULT_A);
    expect(validated.resultRevisionHash).toBe(RESULT_HASH_A);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it("rejects unexpected target keys or role claims", () => {
    const maliciousTarget = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: null,
      role: "control",
      nativeHandle: 999,
    };

    expect(() => validateTargetSnapshot(maliciousTarget)).toThrow(/unsupported fields/i);
  });

  it("rejects boxed string, number, and boolean objects in target snapshots", () => {
    const boxedSourceId = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: Object(SOURCE_A),
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: null,
    };
    expect(() => validateTargetSnapshot(boxedSourceId)).toThrow(/plain object|sourceId/i);

    const boxedGeneration = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: Object(0),
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: null,
    };
    expect(() => validateTargetSnapshot(boxedGeneration)).toThrow(/plain object|generation/i);

    const boxedTargetObject = Object({
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: null,
    });
    // plain record check should accept normal object literal wrapped in Object(), but reject boxed String
    const boxedStringTarget = new String("invalid");
    expect(() => validateTargetSnapshot(boxedStringTarget)).toThrow(/plain object/i);
  });

  it("rejects mismatched result ID and result revision hash pairs", () => {
    const onlyResultId = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: RESULT_A,
      resultRevisionHash: null,
    };
    expect(() => validateTargetSnapshot(onlyResultId)).toThrow(/must both be present or both be null/i);

    const onlyResultHash = {
      viewId: "view-123",
      sessionEpoch: "epoch-456",
      generation: 0,
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
      resultId: null,
      resultRevisionHash: RESULT_HASH_A,
    };
    expect(() => validateTargetSnapshot(onlyResultHash)).toThrow(/must both be present or both be null/i);
  });

  it("rejects non-hex or uppercase hex IDs and hashes", () => {
    expect(() =>
      validateTargetSnapshot({
        viewId: "view-123",
        sessionEpoch: "epoch-456",
        generation: 0,
        sourceId: SOURCE_A.toUpperCase(),
        sourceSha256: HASH_A,
        resultId: null,
        resultRevisionHash: null,
      }),
    ).toThrow(/sourceId/i);

    expect(() =>
      validateTargetSnapshot({
        viewId: "view-123",
        sessionEpoch: "epoch-456",
        generation: 0,
        sourceId: SOURCE_A,
        sourceSha256: HASH_A.slice(0, 63),
        resultId: null,
        resultRevisionHash: null,
      }),
    ).toThrow(/sourceSha256/i);
  });

  it("validates and freezes image view binding input", () => {
    const valid: ImageViewBindingInput = {
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
    };
    const validated = validateImageViewBindingInput(valid);
    expect(validated.sourceId).toBe(SOURCE_A);
    expect(validated.resultId).toBeNull();
    expect(Object.isFrozen(validated)).toBe(true);

    expect(() => validateImageViewBindingInput({ ...valid, extraField: "invalid" })).toThrow(
      /unsupported fields/i,
    );
  });
});

describe("ImageViewRegistry", () => {
  it("enforces registration limits: 1 control window and at most 2 image views", () => {
    const registry = new ImageViewRegistry<number>();

    registry.registerControl(100);
    expect(() => registry.registerControl(100)).toThrow(/already registered/i);
    expect(() => registry.registerControl(101)).toThrow(/more than 1 control view/i);

    registry.registerImageView(1, { sourceId: SOURCE_A, sourceSha256: HASH_A });
    registry.registerImageView(2, { sourceId: SOURCE_B, sourceSha256: HASH_B });

    expect(() =>
      registry.registerImageView(3, { sourceId: SOURCE_A, sourceSha256: HASH_A }),
    ).toThrow(/more than 2 image views/i);

    // Cross-registration prevention
    expect(() => registry.registerImageView(100, { sourceId: SOURCE_A, sourceSha256: HASH_A })).toThrow(
      /already registered as a control view/i,
    );
    expect(() => registry.registerControl(1)).toThrow(/already registered as an image view/i);
  });

  it("supports same-source dual views with independent viewIds and generations", () => {
    const registry = new ImageViewRegistry<string>();
    registry.registerControl("control");

    const target1 = registry.registerImageView("image-1", {
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
    });
    const target2 = registry.registerImageView("image-2", {
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
    });

    expect(target1.sourceId).toBe(SOURCE_A);
    expect(target2.sourceId).toBe(SOURCE_A);
    expect(target1.viewId).not.toBe(target2.viewId);
    expect(target1.generation).toBe(0);
    expect(target2.generation).toBe(0);

    // Image 1 cannot target Image 2
    expect(() => registry.validateTarget("image-1", true, target2)).toThrow(
      /Image sender cannot target another view/i,
    );
    // Image 2 cannot target Image 1
    expect(() => registry.validateTarget("image-2", true, target1)).toThrow(
      /Image sender cannot target another view/i,
    );

    // Each can target itself
    expect(registry.validateTarget("image-1", true, target1).viewId).toBe(target1.viewId);
    expect(registry.validateTarget("image-2", true, target2).viewId).toBe(target2.viewId);
  });

  it("returns defensive snapshots that cannot mutate registry authority", () => {
    const registry = new ImageViewRegistry<number>();
    const snapshot = registry.registerImageView(1, {
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      // @ts-expect-error - verifying immutable runtime freeze
      snapshot.sourceId = SOURCE_B;
    }).toThrow();

    const target = registry.captureTarget(1, true);
    expect(target.sourceId).toBe(SOURCE_A);
  });

  it("rejects non-main-frame senders, unknown senders, and destroyed senders", () => {
    const registry = new ImageViewRegistry<number>();
    registry.registerControl(100);
    const target = registry.registerImageView(1, {
      sourceId: SOURCE_A,
      sourceSha256: HASH_A,
    });

    // Subframe sender
    expect(() => registry.captureTarget(1, false)).toThrow(/non-main-frame/i);
    expect(() => registry.validateTarget(1, false, target)).toThrow(/non-main-frame/i);

    // Unknown sender
    expect(() => registry.captureTarget(999, true)).toThrow(/unknown or destroyed sender/i);
    expect(() => registry.validateTarget(999, true, target)).toThrow(/unknown or destroyed sender/i);

    // Destroyed sender
    registry.unregister(1);
    expect(() => registry.captureTarget(1, true)).toThrow(/unknown or destroyed sender/i);
    expect(() => registry.validateTarget(1, true, target)).toThrow(/unknown or destroyed sender/i);
  });

  it("updates focus history across A, B, and control while preserving control target", () => {
    const registry = new ImageViewRegistry<string>();
    registry.registerControl("control");

    const targetA = registry.registerImageView("A", { sourceId: SOURCE_A, sourceSha256: HASH_A });
    expect(registry.getControlTarget()?.viewId).toBe(targetA.viewId);

    const targetB = registry.registerImageView("B", { sourceId: SOURCE_B, sourceSha256: HASH_B });
    // B registration focuses B
    expect(registry.getControlTarget()?.viewId).toBe(targetB.viewId);

    // Focus A explicitly
    registry.recordFocus("A");
    expect(registry.getControlTarget()?.viewId).toBe(targetA.viewId);

    // Focus Control keeps target intact
    registry.recordFocus("control");
    expect(registry.getControlTarget()?.viewId).toBe(targetA.viewId);
  });

  it("handles pinning and unpinning: pin fixes control target while focus history continues", () => {
    const registry = new ImageViewRegistry<string>();
    registry.registerControl("control");

    const targetA = registry.registerImageView("A", { sourceId: SOURCE_A, sourceSha256: HASH_A });
    const targetB = registry.registerImageView("B", { sourceId: SOURCE_B, sourceSha256: HASH_B });

    registry.recordFocus("A");
    expect(registry.getControlTarget()?.viewId).toBe(targetA.viewId);

    // Pin target A
    registry.pinTarget();
    expect(registry.isPinned()).toBe(true);
    expect(registry.getPinnedViewId()).toBe(targetA.viewId);

    // Focus B while pinned: control target remains A!
    registry.recordFocus("B");
    expect(registry.getControlTarget()?.viewId).toBe(targetA.viewId);

    // Unpin: follows last live focused image (B)
    registry.unpin();
    expect(registry.isPinned()).toBe(false);
    expect(registry.getControlTarget()?.viewId).toBe(targetB.viewId);
  });

  it("clears pin when pinned target is closed and chooses the most recent live image or null", () => {
    const registry = new ImageViewRegistry<string>();
    registry.registerControl("control");

    const targetA = registry.registerImageView("A", { sourceId: SOURCE_A, sourceSha256: HASH_A });
    const targetB = registry.registerImageView("B", { sourceId: SOURCE_B, sourceSha256: HASH_B });

    registry.recordFocus("A");
    registry.pinTarget(targetA.viewId);
    expect(registry.isPinned()).toBe(true);

    // Focus B, then close A
    registry.recordFocus("B");
    registry.unregister("A");

    // Pin is cleared, and control target falls back to live view B
    expect(registry.isPinned()).toBe(false);
    expect(registry.getControlTarget()?.viewId).toBe(targetB.viewId);

    // Close remaining view B: target becomes null
    registry.unregister("B");
    expect(registry.getControlTarget()).toBeNull();
  });

  it("allows control to complete captured target A after focus shifts to B", () => {
    const registry = new ImageViewRegistry<string>();
    registry.registerControl("control");

    const targetA = registry.registerImageView("A", { sourceId: SOURCE_A, sourceSha256: HASH_A });
    const targetB = registry.registerImageView("B", { sourceId: SOURCE_B, sourceSha256: HASH_B });

    // Focus A and capture target for a gesture
    registry.recordFocus("A");
    const capturedA = registry.captureTarget("control", true);
    expect(capturedA.viewId).toBe(targetA.viewId);

    // Focus shifts to B during gesture
    registry.recordFocus("B");
    expect(registry.getControlTarget()?.viewId).toBe(targetB.viewId);

    // Gesture completes: control validates capturedA -> SUCCESS!
    const validated = registry.validateTarget("control", true, capturedA);
    expect(validated.viewId).toBe(targetA.viewId);
    expect(validated.sourceId).toBe(SOURCE_A);
  });

  it("invalidates captured targets on closure, rebind, study switch, and native ID reuse", () => {
    const registry = new ImageViewRegistry<number>();
    registry.registerControl(100);

    // 1. Invalidation on closure
    const targetA = registry.registerImageView(1, { sourceId: SOURCE_A, sourceSha256: HASH_A });
    const capturedA = registry.captureTarget(100, true);
    registry.unregister(1);
    expect(() => registry.validateTarget(100, true, capturedA)).toThrow(/no longer registered|closed/i);

    // 2. Invalidation on rebind (generation increments)
    const targetB = registry.registerImageView(2, { sourceId: SOURCE_B, sourceSha256: HASH_B });
    const capturedB = registry.captureTarget(100, true);
    expect(capturedB.generation).toBe(0);

    const reboundB = registry.rebindImageView(2, {
      sourceId: SOURCE_B,
      sourceSha256: HASH_B,
      resultId: RESULT_A,
      resultRevisionHash: RESULT_HASH_A,
    });
    expect(reboundB.generation).toBe(1);

    // Old captured target with generation 0 must be rejected
    expect(() => registry.validateTarget(100, true, capturedB)).toThrow(/generation is stale/i);
    // New target with generation 1 succeeds
    const validatedRebound = registry.validateTarget(100, true, reboundB);
    expect(validatedRebound.generation).toBe(1);
    expect(validatedRebound.resultId).toBe(RESULT_A);

    // 3. Invalidation on study switch (sessionEpoch changes)
    const epochBefore = registry.getSessionEpoch();
    registry.switchStudy();
    const epochAfter = registry.getSessionEpoch();
    expect(epochBefore).not.toBe(epochAfter);

    // Old target from previous study epoch rejected
    expect(() => registry.validateTarget(100, true, reboundB)).toThrow(
      /no longer registered|closed/i,
    );

    // 4. Native ID reuse must never resurrect old target
    // Register native sender 2 again in the new study
    const newTarget = registry.registerImageView(2, { sourceId: SOURCE_B, sourceSha256: HASH_B });
    expect(newTarget.viewId).not.toBe(targetB.viewId);
    expect(newTarget.sessionEpoch).toBe(epochAfter);

    // Old target from sender 2's previous incarnation is rejected
    expect(() => registry.validateTarget(2, true, reboundB)).toThrow();
  });

  it("rejects malformed and boxed sender identities", () => {
    const registry = new ImageViewRegistry<unknown>();

    expect(() => registry.registerControl(null)).toThrow(/null or undefined/i);
    expect(() => registry.registerControl(undefined)).toThrow(/null or undefined/i);
    expect(() => registry.registerControl(Object("sender-1"))).toThrow(/boxed primitive/i);
    expect(() => registry.registerControl(new Number(42))).toThrow(/boxed primitive/i);
    expect(() => registry.registerControl(1.5)).toThrow(/safe integer/i);
  });
});
