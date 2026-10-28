import { describe, expect, it } from "vitest";
import type { ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { researcherScopeLabel, sourceChannelLabel } from "./research-scope-labels";

describe("researcher scope presentation", () => {
  const source = { id: "source", sha256: "a".repeat(64), name: "Declared image",
    metadata: { dimensions: { x: 64, y: 48, c: 2, z: 4, t: 3 }, channel_names: ["Declared marker", ""] } } as ResearchSource;
  it("uses declared channel names and one-based plane labels without changing the API binding", () => {
    const selection: ResearchSelection = Object.freeze({ x: 0, y: 0, width: 64, height: 48, c: 0, z: 0, t: 0, level: 0 });
    expect(researcherScopeLabel(source, selection)).toBe("Whole image · 64 × 48 px · Declared marker · Z 1 · T 1");
    expect(sourceChannelLabel(source, 1)).toBe("Channel 2");
    expect(selection).toEqual({ x: 0, y: 0, width: 64, height: 48, c: 0, z: 0, t: 0, level: 0 });
  });
  it("keeps crop offsets and an exclusive Z stop correctly distinguished from displayed plane numbers", () => {
    const selection: ResearchSelection = Object.freeze({ x: 7, y: 9, width: 12, height: 15, c: 1, z: 1, z_stop: 4, t: 2, level: 0 });
    expect(researcherScopeLabel(source, selection)).toBe("Region: X 7, Y 9 · 12 × 15 px · Channel 2 · Z 2–4 · T 3");
    expect(selection.z_stop).toBe(4);
  });
});
