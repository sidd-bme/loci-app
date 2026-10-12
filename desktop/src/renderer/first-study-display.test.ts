import { describe, expect, it } from "vitest";
import type { ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { FIRST_STUDY_SOURCE_SHA256, firstStudyDisplayChannels } from "./first-study-display";

const source: ResearchSource = { id: "a".repeat(32), name: "synthetic-shapes-v1.ome.tiff", sha256: FIRST_STUDY_SOURCE_SHA256, metadata: {} };
const project: ResearchSnapshot["project"] = { title: "Practice", first_study: {
  example_id: "synthetic-shapes-v1", source_id: source.id, source_sha256: source.sha256,
} };
const channels = [{ channel: 0, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true }];

describe("exact first-study display preset", () => {
  it("replaces only the display range without mutating acquisition defaults", () => {
    expect(firstStudyDisplayChannels(project, source, channels)).toEqual([{ ...channels[0], high: 200 }]);
    expect(channels[0].high).toBe(65535);
  });
  it("requires the exact authored bytes and study/source binding", () => {
    expect(firstStudyDisplayChannels({ title: "Other study" }, source, channels)).toBeNull();
    expect(firstStudyDisplayChannels(project, { ...source, id: "c".repeat(32) }, channels)).toBeNull();
    expect(firstStudyDisplayChannels(project, { ...source, sha256: "b".repeat(64) }, channels)).toBeNull();
    expect(firstStudyDisplayChannels({ ...project, first_study: { ...project.first_study!, source_sha256: "b".repeat(64) } },
      { ...source, sha256: "b".repeat(64) }, channels)).toBeNull();
    expect(firstStudyDisplayChannels({ ...project, first_study: { ...project.first_study!, source_sha256: "b".repeat(64) } }, source, channels)).toBeNull();
    expect(firstStudyDisplayChannels(project, source, [...channels, { ...channels[0], channel: 1 }])).toBeNull();
    expect(firstStudyDisplayChannels(project, source, [{ ...channels[0], channel: 1 }])).toBeNull();
  });
});
