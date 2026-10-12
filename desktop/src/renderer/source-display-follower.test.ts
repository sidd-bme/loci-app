import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import { SourceDisplayFollower } from "./source-display-follower";
import { SourceViewStore, type SourceViewState } from "./source-view-store";

const sourceId = "a".repeat(32), sha = "b".repeat(64);
const channel = { channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true };
const state: SourceViewState = { interpretation: "generic", channels: [channel], projection: "plane",
  selection: { x: 0, y: 0, width: 10, height: 10, t: 0, c: 0, z: 0, level: 0 }, camera: null };
const receipt = (revision: number, color = "#abcdef") => ({ source_id: sourceId, source_sha256: sha, revision,
  state: { ...state, channels: [{ ...channel, color }] } });
afterEach(() => vi.useRealTimers());

describe("source display following", () => {
  it("flushes prior local edits, pauses writes, adopts only newer revisions and resumes CAS at the adopted revision", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValueOnce(receipt(2)).mockResolvedValueOnce(receipt(3))
      .mockResolvedValueOnce(receipt(3)).mockResolvedValueOnce(receipt(4));
    const api = { execute } as unknown as ResearchDesktopApi;
    const error = vi.fn(), adopted = vi.fn();
    const store = new SourceViewStore(api, sourceId, sha, 1, error);
    store.save(state);
    const follower = new SourceDisplayFollower(api, sourceId, sha, store, adopted, error);
    await follower.start();
    expect(execute.mock.calls[0][0]).toBe("save_source_view");
    expect(adopted).toHaveBeenCalledExactlyOnceWith([{ ...channel, color: "#abcdef" }]);
    store.save(state);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute.mock.calls.filter(([operation]) => operation === "save_source_view")).toHaveLength(1);
    expect(adopted).toHaveBeenCalledTimes(1);
    await follower.stop();
    store.save(state); await store.flush();
    expect(execute.mock.lastCall?.[1]).toMatchObject({ expected_revision: 3 });
    expect(error).not.toHaveBeenCalled();
  });
  it.each([receipt(0), { ...receipt(2), source_sha256: "c".repeat(64) },
    { ...receipt(2), state: { ...state, channels: [{ ...channel, high: Number.NaN }] } }])(
    "rejects stale or mismatched display replies before adoption", async (reply) => {
      const execute = vi.fn().mockResolvedValue(reply), error = vi.fn(), adopted = vi.fn();
      const api = { execute } as unknown as ResearchDesktopApi;
      const store = new SourceViewStore(api, sourceId, sha, 1, error);
      const follower = new SourceDisplayFollower(api, sourceId, sha, store, adopted, error);
      await follower.start();
      expect(adopted).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
      expect(store.currentRevision).toBe(1); await follower.stop();
    },
  );
  it("discards a read that arrives after a source switch or stop", async () => {
    let resolve!: (value: unknown) => void;
    let markStarted!: () => void;
    const readStarted = new Promise<void>((done) => { markStarted = done; });
    const execute = vi.fn(() => new Promise((done) => { resolve = done; markStarted(); }));
    const api = { execute } as unknown as ResearchDesktopApi;
    const adopted = vi.fn(), error = vi.fn(), store = new SourceViewStore(api, sourceId, sha, 0, error);
    const follower = new SourceDisplayFollower(api, sourceId, sha, store, adopted, error);
    const started = follower.start(); await readStarted;
    const stopped = follower.stop(); resolve(receipt(1)); await started; await stopped;
    expect(adopted).not.toHaveBeenCalled(); expect(store.currentRevision).toBe(0);
  });
});
