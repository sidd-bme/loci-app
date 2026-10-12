// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type { ResearchSnapshot } from "../shared/research-contracts";
import { ResearchViewAccess } from "./research-view-access";

const SOURCE_ID = "a".repeat(32);
const SOURCE_SHA = "b".repeat(64);
const RESULT_ID = "c".repeat(32);
const RESULT_REVISION = "d".repeat(64);

function target(result = false): ImageViewTargetSnapshot {
  return {
    viewId: "view-main-issued",
    sessionEpoch: "epoch-main-issued",
    generation: 0,
    sourceId: SOURCE_ID,
    sourceSha256: SOURCE_SHA,
    resultId: result ? RESULT_ID : null,
    resultRevisionHash: result ? RESULT_REVISION : null,
  };
}

function snapshot(): ResearchSnapshot {
  return {
    project: { title: "Study" },
    sources: [{ id: SOURCE_ID, name: "Source", sha256: SOURCE_SHA, metadata: {} }],
    results: [{
      id: RESULT_ID,
      source_id: SOURCE_ID,
      source_sha256: SOURCE_SHA,
      kind: "processed",
      created_at: "2026-09-20T00:00:00Z",
      revision_hash: RESULT_REVISION,
      object_count: 0,
    }],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    jobs: [],
    operations: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides: Partial<{
  project: string | null;
  epoch: number;
  switching: boolean;
  snapshot: (project: string) => Promise<ResearchSnapshot>;
  control: (project: string, operation: string, request: Record<string, unknown>) => Promise<unknown>;
  viewer: (
    project: string,
    operation: string,
    request: Record<string, unknown>,
    lane: string,
    scope: string,
  ) => Promise<unknown>;
}> = {}) {
  const state = {
    project: overrides.project === undefined ? "/private/Study.loci-study" : overrides.project,
    epoch: overrides.epoch ?? 1,
    switching: overrides.switching ?? false,
  };
  const snapshotCall = vi.fn(overrides.snapshot ?? (async () => snapshot()));
  const control = vi.fn(overrides.control ?? (async (_project, _operation, request) => ({
    source_id: request.source_id,
    source_sha256: SOURCE_SHA,
  })));
  const viewer = vi.fn(overrides.viewer ?? (async (_project, operation, request) => operation === "result_view"
    ? { result_id: request.result_id, revision_hash: RESULT_REVISION }
    : { source_id: request.source_id, source_sha256: SOURCE_SHA }));
  const cancel = vi.fn();
  const access = new ResearchViewAccess({
    documentState: () => ({ ...state }),
    snapshot: snapshotCall,
    executeControl: control,
    executeViewer: viewer,
    cancelViewerScope: cancel,
  });
  return { access, state, snapshotCall, control, viewer, cancel };
}

describe("main-only research image view access", () => {
  it("does not resolve or auto-open a study for the coordinator snapshot", async () => {
    const { access, snapshotCall } = harness({ project: null });
    await expect(access.getSnapshot()).rejects.toThrow("Create or open a study");
    expect(snapshotCall).not.toHaveBeenCalled();
  });

  it("uses the main-issued view ID as queue scope while preserving the renderer sub-lane", async () => {
    const { access, viewer } = harness();
    await expect(access.execute(
      target(),
      "viewer_tile",
      { source_id: SOURCE_ID, overview: true },
      { viewer_lane: "comparison_a" },
    )).resolves.toMatchObject({ source_id: SOURCE_ID, source_sha256: SOURCE_SHA });
    expect(viewer).toHaveBeenCalledWith(
      "/private/Study.loci-study",
      "viewer_tile",
      { source_id: SOURCE_ID, overview: true },
      "comparison_a",
      "view-main-issued",
    );
  });

  it("allows only read operations unless trusted main explicitly grants annotation", async () => {
    const { access, control } = harness();
    const annotation = {
      source_id: SOURCE_ID,
      source_sha256: SOURCE_SHA,
      expected_revision: 4,
      action: "undo",
    };
    await expect(access.execute(target(), "annotate_source", annotation)).rejects.toThrow(
      "not available",
    );
    await expect(access.execute(
      target(),
      "annotate_source",
      annotation,
      undefined,
      "annotate",
    )).resolves.toMatchObject({ source_id: SOURCE_ID, source_sha256: SOURCE_SHA });
    expect(control).toHaveBeenCalledWith(
      "/private/Study.loci-study",
      "annotate_source",
      annotation,
    );
    await expect(access.execute(
      target(),
      "annotate_source",
      { ...annotation, expected_revision: -1 },
      undefined,
      "annotate",
    )).rejects.toThrow("non-negative safe integer");
  });

  it("rejects path injection and target identity mismatches before engine access", async () => {
    const { access, snapshotCall } = harness();
    await expect(access.execute(target(), "viewer_tile", {
      source_id: SOURCE_ID,
      selection: { source_path: "/private/source.tif", project_id: "embedded" },
    })).rejects.toThrow("project or path field");
    await expect(access.execute(target(), "source_view", {
      source_id: "e".repeat(32),
    })).rejects.toThrow("does not match");
    expect(snapshotCall).not.toHaveBeenCalled();
  });

  it("verifies exact source and result revisions against the current engine snapshot", async () => {
    const wrongSource = snapshot();
    wrongSource.sources[0].sha256 = "f".repeat(64);
    const sourceAccess = harness({ snapshot: async () => wrongSource });
    await expect(sourceAccess.access.execute(target(), "source_view", {
      source_id: SOURCE_ID,
    })).rejects.toThrow("source is stale");
    expect(sourceAccess.control).not.toHaveBeenCalled();

    const stale = snapshot();
    stale.results[0].revision_hash = "e".repeat(64);
    const { access, viewer } = harness({ snapshot: async () => stale });
    await expect(access.execute(target(true), "result_view", {
      result_id: RESULT_ID,
      axis: "z",
    })).rejects.toThrow("result is stale");
    expect(viewer).not.toHaveBeenCalled();
  });

  it("rejects same-path document replacement during verification or execution", async () => {
    const verifying = deferred<ResearchSnapshot>();
    const first = harness({ snapshot: async () => verifying.promise });
    const firstRequest = first.access.execute(target(), "source_view", { source_id: SOURCE_ID });
    first.state.epoch += 1;
    verifying.resolve(snapshot());
    await expect(firstRequest).rejects.toThrow("study changed");
    expect(first.control).not.toHaveBeenCalled();

    const rendering = deferred<unknown>();
    const second = harness({ viewer: async () => rendering.promise });
    const secondRequest = second.access.execute(
      target(),
      "viewer_tile",
      { source_id: SOURCE_ID, overview: true },
    );
    await vi.waitFor(() => expect(second.viewer).toHaveBeenCalled());
    second.state.epoch += 1;
    rendering.resolve({ source_id: SOURCE_ID, source_sha256: SOURCE_SHA });
    await expect(secondRequest).rejects.toThrow("study changed");
  });

  it("does not dispatch when the captured target closes during snapshot verification", async () => {
    const verification = deferred<ResearchSnapshot>();
    const { access, control } = harness({ snapshot: async () => verification.promise });
    let current = true;
    const assertTargetCurrent = vi.fn(() => {
      if (!current) throw new Error("The captured image view has closed.");
    });
    const request = access.execute(
      target(),
      "annotate_source",
      {
        source_id: SOURCE_ID,
        source_sha256: SOURCE_SHA,
        expected_revision: 2,
        action: "undo",
      },
      undefined,
      "annotate",
      assertTargetCurrent,
    );
    current = false;
    verification.resolve(snapshot());
    await expect(request).rejects.toThrow("has closed");
    expect(assertTargetCurrent).toHaveBeenCalledTimes(2);
    expect(control).not.toHaveBeenCalled();
  });

  it("rejects sources that require relinking", async () => {
    const unavailable = snapshot();
    unavailable.sources[0].locator_state = "relink-required";
    const { access, viewer } = harness({ snapshot: async () => unavailable });
    await expect(access.execute(
      target(),
      "viewer_tile",
      { source_id: SOURCE_ID, overview: true },
    )).rejects.toThrow("source is stale");
    expect(viewer).not.toHaveBeenCalled();
  });

  it("checks returned identities and cancels only the requested queue scope", async () => {
    const { access, cancel } = harness({
      viewer: async () => ({ source_id: "f".repeat(32), source_sha256: SOURCE_SHA }),
    });
    await expect(access.execute(
      target(),
      "viewer_tile",
      { source_id: SOURCE_ID, overview: true },
    )).rejects.toThrow("response source_id");
    access.cancel("view-main-issued");
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0][0]).toBe("view-main-issued");
    expect(cancel.mock.calls[0][1]).toBeInstanceOf(Error);
  });
});
