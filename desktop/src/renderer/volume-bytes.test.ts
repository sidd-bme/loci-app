import { describe, expect, it } from "vitest";
import { decodeVolumeBytes, volumeByteDigest } from "./volume-bytes";

describe("decoded volume bytes", () => {
  it("preserves every byte including zeros and uint32 label IDs", () => {
    expect([...decodeVolumeBytes("AAAAAP////8=", 8)]).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
  });
  it("rejects a short decoded payload even with the expected number of base64 characters", () => {
    expect(() => decodeVolumeBytes("AA==", 3)).toThrow(/byte length/);
  });
  it("hashes only the view passed to the verifier", async () => {
    const view = new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4);
    expect(await volumeByteDigest(view)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
