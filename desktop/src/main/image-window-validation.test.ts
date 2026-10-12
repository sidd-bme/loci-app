// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { imageViewDimensions, validateImageInteraction, validateImagePresentation } from "./image-window-validation";
const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Synthetic",
  metadata: { dimensions: { x: 100, y: 80, z: 4, t: 2, c: 2 } } };
const display = () => ({ mode: "plane", selection: { x: 0, y: 0, width: 100, height: 80, z: 0, t: 0, c: 0, level: 0 },
  channels: [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ff00ff" }],
  projection: "plane", tool: "rectangle", draft: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  annotations: [], camera: null, showScaleBar: true, showNavigator: true });
describe("detached display boundary", () => {
  it("uses declared medical YX/ZYX shapes without guessing missing axes", () => {
    const medical: ResearchSource = { ...source, source_kind: "medical", metadata: { shape: [4, 80, 100], geometry: { axes: "ZYX" } } };
    expect(imageViewDimensions(medical)).toEqual({ x: 100, y: 80, z: 4, t: 1, c: 1 });
    expect(validateImagePresentation(display(), medical).selection.width).toBe(100);
    for (const metadata of [{ shape: [4, 80, 100] }, { shape: [4, 80, 100], geometry: { axes: "XYZ" } },
      { shape: [4, 0, 100], geometry: { axes: "ZYX" } }]) {
      expect(() => imageViewDimensions({ ...medical, metadata })).toThrow(/dimensions/);
    }
    expect(imageViewDimensions({ ...medical, metadata: { shape: [80, 100], geometry: { axes: "YX" } } }).z).toBe(1);
  });
  it("accepts one RGB tone curve and rejects fake biological channels", () => {
    const rgb = { ...source, metadata: { ...source.metadata, sample_semantics: "RGB", dimensions: { ...source.metadata.dimensions!, c: 3 } } };
    expect(validateImagePresentation({ ...display(), interpretation: "histology" }, rgb).channels).toHaveLength(1);
    expect(() => validateImagePresentation({ ...display(), channels: [{ ...display().channels[0], channel: 1 }] }, rgb)).toThrow(/channel/i);
  });
  it("checks volume display interactions before forwarding them", () => {
    const event = { kind: "volume-display", channels: display().channels, renderMode: "mip", quality: 75 };
    expect(validateImageInteraction(event, source)).toEqual(event);
    for (const changes of [{ renderMode: "unsupported" }, { quality: 101 }, { quality: NaN }, { channels: [] }]) {
      expect(() => validateImageInteraction({ ...event, ...changes }, source)).toThrow();
    }
    expect(() => validateImagePresentation({ ...display(), interpretation: "cancer" }, source)).toThrow(/interpretation/);
  });
  it("copies display state without sharing renderer ownership", () => {
    const value = display(); const copy = validateImagePresentation(value, source);
    value.draft[0].x = 99; expect(copy.draft[0].x).toBe(10);
  });
  it("rejects nonfinite and out-of-grid source coordinates", () => {
    for (const point of [{ x: NaN, y: 1 }, { x: 101, y: 0 }, { x: 0, y: -1 }]) {
      expect(() => validateImageInteraction({ kind: "draft", plane: { t: 0, z: 0 }, points: [point] }, source)).toThrow(/coordinates/);
    }
    expect(() => validateImagePresentation({ ...display(), selection: { ...display().selection, level: 1 } }, source)).toThrow(/level-zero/);
  });
  it("rejects unknown modes, identity claims and unsafe channel settings", () => {
    expect(() => validateImagePresentation({ ...display(), sourceId: "another" }, source)).toThrow(/Unsupported/);
    expect(() => validateImagePresentation({ ...display(), mode: "mystery" }, source)).toThrow(/mode/);
    for (const changes of [{ gamma: 0 }, { opacity: 2 }, { low: 256 }, { channel: 2 }, { color: "url(file://x)" }]) {
      expect(() => validateImagePresentation({ ...display(), channels: [{ ...display().channels[0], ...changes }] }, source)).toThrow(/channel/i);
    }
  });
  it("bounds drafts and does not accept commands as viewport events", () => {
    expect(() => validateImageInteraction({ kind: "draft", plane: { t: 0, z: 0 }, points: Array(2049).fill({ x: 1, y: 1 }) }, source)).toThrow(/limit/);
    expect(() => validateImageInteraction({ kind: "execute", operation: "annotate_source" }, source)).toThrow(/Unsupported/);
    expect(() => validateImageInteraction({ kind: "camera", camera: { x: 2, y: 3, scale: Infinity } }, source)).toThrow(/camera/);
  });
});
