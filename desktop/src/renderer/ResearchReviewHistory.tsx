import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchReview } from "../shared/research-contracts";

export function reviewLabel(review?: ResearchReview | null): string {
  const status = review?.disposition === "reviewed" ? "Reviewed" : review?.disposition === "excluded" ? "Excluded" : "To review";
  if (!review || review.disposition === "pending") return status;
  if (review.actor === "agent") return `${status} by agent`;
  if (review.schema === "loci.result-review/v2" && review.actor === "human") return `${status} by researcher`;
  return status;
}

export function researcherReviewed(result?: ResearchResult | null): boolean {
  return result?.review?.disposition === "reviewed" && result.review.actor !== "agent";
}

type HistoryPage = { result_id: string; revision_hash: string; events: ResearchReview[]; total_events: number; next_offset: number | null };

export function ResearchReviewHistory({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const currentEvent = result.review?.event_id ?? result.review?.reviewed_at ?? result.review?.disposition;
  useEffect(() => {
    generation.current++;
    setPage(null);
    setError("");
    setLoading(false);
  }, [result.id, result.revision_hash, currentEvent]);
  useEffect(() => {
    if (!open) return;
    void read(0);
    return () => { generation.current++; };
  }, [open, result.id, result.revision_hash, currentEvent]);
  async function read(offset: number) {
    const run = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const output = await api.execute("review_history", { result_id: result.id, offset, limit: 100 }) as HistoryPage;
      if (run !== generation.current) return;
      if (output.result_id !== result.id || output.revision_hash !== result.revision_hash || !Array.isArray(output.events))
        throw new Error("Review history does not match this result revision.");
      setPage((previous) => ({ ...output, events: offset ? [...(previous?.events ?? []), ...output.events] : output.events }));
    } catch (reason) {
      if (run === generation.current) setError(reason instanceof Error ? reason.message : "Could not read review history.");
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Review history</summary>
    {error && <p role="alert">{error}</p>}
    {page && !page.events.length && <p>No review decisions recorded.</p>}
    {page && <ol>{page.events.map((event, index) => <li key={event.event_id ?? `legacy-${index}`}>
      <strong>{reviewLabel(event)}</strong>
      <p>{event.reviewed_at ? new Date(event.reviewed_at).toLocaleString() : "Time unavailable"}
        {event.actor_id ? ` · ${event.actor_id} (declared)` : " · Legacy actor declaration"}</p>
      {event.reason && <p>{event.reason}</p>}
      {event.coverage && <p>Coverage: {event.coverage}</p>}
      {event.authority && <details><summary>Delegation record</summary>
        <p>Client: {event.authority.client_id}</p><p>Policy SHA-256: <code>{event.authority.policy_sha256}</code></p>
      </details>}
    </li>)}</ol>}
    {loading && <p role="status">Loading review history…</p>}
    {page?.next_offset !== null && page?.next_offset !== undefined && <button disabled={loading} onClick={() => void read(page.next_offset!)}>More decisions</button>}
  </details>;
}
