import { describe, expect, it } from "vitest";
import { checkedVisionRequest, checkedVisionReceipt } from "./vision-handoff";
const request = { source_id: "a".repeat(32), selection: { x: 1, y: 2, width: 20, height: 10, t: 0, c: 0, z: 0, level: 0 },
  channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }], projection: "plane", max_size: 1536 };
describe("vision handoff IPC contract", () => {
  it("clones the explicit rendering request and rejects nonfinite or hidden extra fields", () => {
    const result = checkedVisionRequest(request); expect(result).toEqual(request); expect(result).not.toBe(request);
    for (const bad of [ { ...request, destination: "/tmp/hidden" }, { ...request, max_size: 2049 },
      { ...request, selection: { ...request.selection, z_stop: 0 } },
      { ...request, channels: [{ ...request.channels[0], high: Infinity }] },
      { ...request, channels: [request.channels[0], request.channels[0]] } ]) expect(() => checkedVisionRequest(bad)).toThrow();
  });
  it("binds all four artifact hashes to the source without exposing paths", () => {
    const sha = "b".repeat(64);
    const receipt = { schema: "loci.vision-handoff-receipt/v1", source_id: request.source_id, source_sha256: sha,
      status: "provisional-visualization", basename: "image.loci-vision", artifacts: Object.fromEntries(
        ["image.png", "context.json", "README.md", "manifest.json"].map((name) => [name, { sha256: sha, size_bytes: 100 }])) };
    expect(checkedVisionReceipt(receipt, request.source_id, sha)).toEqual(receipt);
    expect(() => checkedVisionReceipt(receipt, "c".repeat(32), sha)).toThrow();
    expect(() => checkedVisionReceipt({ ...receipt, basename: "/tmp/image.loci-vision" }, request.source_id, sha)).toThrow();
    expect(() => checkedVisionReceipt({ ...receipt, artifacts: {} }, request.source_id, sha)).toThrow();
  });
});
