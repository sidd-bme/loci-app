// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import { ResearchReviewHistory } from "./ResearchReviewHistory";

afterEach(cleanup);
const result: ResearchResult = { id: "a".repeat(32), source_id: "c".repeat(32), revision_hash: "b".repeat(64),
  kind: "segmentation", object_count: 2, created_at: "2026-10-17T00:00:00Z" };

it("loads decisions on demand, preserves actor and coverage, and rejects stale responses", async () => {
  let finish: (value: unknown) => void = () => {};
  const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ result_id: "d".repeat(32), revision_hash: result.revision_hash, events: [{
      event_id: "e".repeat(32), schema: "loci.result-review/v2", actor: "human", actor_id: "local-user",
      disposition: "excluded", reviewed_at: result.created_at, reason: "Boundary crosses an artefact", coverage: "Selected plane",
    }], total_events: 1, next_offset: null });
  const api = { execute } as unknown as ResearchDesktopApi;
  const view = render(<ResearchReviewHistory api={api} result={result} />);
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Review history"));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  view.rerender(<ResearchReviewHistory api={api} result={{ ...result, id: "d".repeat(32) }} />);
  expect(await screen.findByText("Excluded by researcher")).toBeVisible();
  expect(screen.getByText("Coverage: Selected plane")).toBeVisible();
  await act(async () => finish({ result_id: result.id, revision_hash: result.revision_hash,
    events: [{ disposition: "reviewed", actor: "agent", reason: "Stale first result" }], total_events: 1, next_offset: null }));
  expect(screen.queryByText("Stale first result")).not.toBeInTheDocument();
});
