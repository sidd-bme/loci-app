// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { useAnnotationDrafts } from "./annotation-draft";

const first = { id: "a".repeat(32), sha256: "1".repeat(64), name: "First",
  metadata: { dimensions: { x: 64, y: 48, z: 200, t: 2, c: 1 } } } as ResearchSource;
const second = { ...first, id: "b".repeat(32), sha256: "2".repeat(64), name: "Second" };
const line = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
const polygon = [...line, { x: 5, y: 6 }];
const initial = { epoch: 1, sources: [first, second], source: first, z: 0, t: 0, mode: "general" as "general" | "epidermis" };
function setup() {
  return renderHook((props) => useAnnotationDrafts(props.epoch, props.sources, props.source,
    { z: props.z, t: props.t }, props.mode), { initialProps: initial });
}

describe("source-bound annotation drafts", () => {
  it("recovers points and fields independently for each exact tool and plane", () => {
    const view = setup();
    act(() => view.result.current.setTool("line"));
    act(() => view.result.current.setPoints(line));
    act(() => view.result.current.control.updateFields({ label: "Distance A" }));
    act(() => view.result.current.setTool("polygon"));
    expect(view.result.current.points).toEqual([]);
    expect(view.result.current.control.fields.label).toBe("");
    act(() => view.result.current.setPoints(polygon));
    view.rerender({ ...initial, z: 1 });
    expect(view.result.current.points).toEqual([]);
    act(() => view.result.current.setPoints([{ x: 11, y: 12 }]));
    view.rerender(initial);
    expect(view.result.current.points).toEqual(polygon);
    act(() => view.result.current.setTool("line"));
    expect(view.result.current.points).toEqual(line);
    expect(view.result.current.control.fields.label).toBe("Distance A");
    view.rerender({ ...initial, t: 1 });
    expect(view.result.current.points).toEqual([]);
    view.rerender(initial);
    expect(view.result.current.points).toEqual(line);
  });

  it("remembers general and epidermal tools without reinterpreting their coordinates", () => {
    const view = setup();
    act(() => view.result.current.setTool("line"));
    act(() => view.result.current.setPoints(line));
    view.rerender({ ...initial, mode: "epidermis" });
    expect(view.result.current.tool).toBe("transect");
    expect(view.result.current.points).toEqual([]);
    act(() => view.result.current.setPoints([{ x: 9, y: 10 }]));
    view.rerender(initial);
    expect(view.result.current.tool).toBe("line");
    expect(view.result.current.points).toEqual(line);
  });

  it("recovers the original source while keeping another source empty", () => {
    const view = setup();
    act(() => view.result.current.setTool("line"));
    act(() => view.result.current.setPoints(line));
    view.rerender({ ...initial, source: second });
    expect(view.result.current.tool).toBe("navigate");
    expect(view.result.current.points).toEqual([]);
    view.rerender(initial);
    expect(view.result.current.tool).toBe("line");
    expect(view.result.current.points).toEqual(line);
  });

  it("invalidates changed source hashes and replacement document epochs", () => {
    const view = setup();
    act(() => view.result.current.setTool("polygon"));
    act(() => view.result.current.setPoints(polygon));
    const replacement = { ...first, sha256: "3".repeat(64) };
    view.rerender({ ...initial, sources: [replacement, second], source: replacement });
    expect(view.result.current.points).toEqual([]);
    view.rerender(initial);
    act(() => view.result.current.setTool("polygon"));
    expect(view.result.current.points).toEqual([]);
    act(() => view.result.current.setPoints(polygon));
    const finishOldSave = view.result.current.control.captureCommit();
    view.rerender({ ...initial, epoch: 2 });
    expect(view.result.current.points).toEqual([]);
    act(() => view.result.current.setTool("polygon"));
    act(() => view.result.current.setPoints(line));
    act(finishOldSave);
    expect(view.result.current.points).toEqual(line);
  });

  it("clears only the submitted version and leaves subsequent draft edits intact", () => {
    const view = setup();
    act(() => view.result.current.setTool("line"));
    act(() => view.result.current.setPoints(line));
    const finishOldSave = view.result.current.control.captureCommit();
    act(() => view.result.current.setPoints([{ x: 7, y: 8 }]));
    act(finishOldSave);
    expect(view.result.current.points).toEqual([{ x: 7, y: 8 }]);
    const finishCurrentSave = view.result.current.control.captureCommit();
    view.rerender({ ...initial, source: second });
    act(finishCurrentSave);
    view.rerender(initial);
    expect(view.result.current.points).toEqual([]);
  });

  it("bounds retained drafts visibly without evicting existing work", () => {
    const view = setup();
    act(() => view.result.current.setTool("point"));
    for (let z = 0; z < 128; z++) {
      view.rerender({ ...initial, z });
      act(() => view.result.current.setPoints([{ x: 1, y: 2 }]));
    }
    view.rerender({ ...initial, z: 128 });
    act(() => view.result.current.setPoints([{ x: 7, y: 8 }]));
    expect(view.result.current.points).toEqual([]);
    expect(view.result.current.control.notice).toMatch(/128 unfinished drafts/);
    view.rerender(initial);
    expect(view.result.current.points).toEqual([{ x: 1, y: 2 }]);
    act(() => view.result.current.setPoints([]));
    view.rerender({ ...initial, z: 128 });
    act(() => view.result.current.setPoints([{ x: 7, y: 8 }]));
    expect(view.result.current.points).toEqual([{ x: 7, y: 8 }]);
    expect(view.result.current.control.notice).toBeNull();
  });
});
