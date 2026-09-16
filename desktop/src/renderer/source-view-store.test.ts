import { describe, it, expect, vi } from "vitest";
import { SourceViewStore, type SourceViewState } from "./source-view-store";
import type { ResearchDesktopApi } from "../shared/research-contracts";

const state = (x: number) => ({ camera: { x, y: 1, scale: 1 } } as SourceViewState);
describe("source view persistence", () => {
  it("serializes saves and coalesces pending navigation without crossing sources", async () => {
    let resolve: (value: unknown) => void = () => {};
    const execute = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce({ source_id: "a", source_sha256: "hash", revision: 2 });
    const store = new SourceViewStore({ execute } as unknown as ResearchDesktopApi, "a", "hash", 0, vi.fn());
    store.save(state(1)); const flushing = store.flush();
    store.save(state(2)); store.save(state(3));
    let secondFinished = false;
    const secondFlush = store.flush().then(() => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    resolve({ source_id: "a", source_sha256: "hash", revision: 1 }); await flushing;
    await secondFlush;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toMatchObject({ expected_revision: 1, state: { camera: { x: 3 } } });
    await store.flush();
  });
  it("freezes the last queued view while a document picker switches projects", async () => {
    const execute = vi.fn().mockResolvedValue({ source_id: "a", source_sha256: "hash", revision: 1 });
    const store = new SourceViewStore({ execute } as unknown as ResearchDesktopApi, "a", "hash", 0, vi.fn());
    store.save(state(1)); store.pause(); store.save(state(2));
    expect(await store.flush()).toBe(true);
    expect(execute.mock.calls[0][1].state.camera.x).toBe(1);
    store.resume(); execute.mockResolvedValue({ source_id: "a", source_sha256: "hash", revision: 2 });
    store.save(state(3)); await store.flush();
    expect(execute.mock.calls[1][1].state.camera.x).toBe(3);
  });
  it("stops after an unverifiable save and reports it", async () => {
    const execute = vi.fn().mockResolvedValue({ source_id: "different", source_sha256: "hash", revision: 1 });
    const failed = vi.fn();
    const store = new SourceViewStore({ execute } as unknown as ResearchDesktopApi, "a", "hash", 0, failed);
    store.save(state(1)); await store.flush(); store.save(state(2)); await store.flush();
    expect(execute).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledOnce();
  });
  it("adopts a verified external revision before the next local save", async () => {
    const execute = vi.fn().mockResolvedValue({ source_id: "a", source_sha256: "hash", revision: 5 });
    const store = new SourceViewStore({ execute } as unknown as ResearchDesktopApi, "a", "hash", 2, vi.fn());
    store.adoptRevision(4);
    store.save(state(3));
    await store.flush();
    expect(execute).toHaveBeenCalledWith("save_source_view", expect.objectContaining({ expected_revision: 4 }));
  });
  it("discards pending state and cancelled timers when discarded", async () => {
    const execute = vi.fn();
    const store = new SourceViewStore({ execute } as unknown as ResearchDesktopApi, "a", "hash", 0, vi.fn());
    store.save(state(1));
    store.discard();
    await store.flush();
    expect(execute).not.toHaveBeenCalled();
  });
});
