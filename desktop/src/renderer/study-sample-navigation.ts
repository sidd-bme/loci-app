import type { ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";

/** Resolve against the current visible snapshot, never an earlier row or a filename. */
export function resolveStudySource(snapshot: ResearchSnapshot | null, target: Pick<ResearchSource, "id" | "sha256">): ResearchSource {
  const source = snapshot?.sources.find((row) => row.id === target.id && row.sha256 === target.sha256);
  if (!source) throw new Error("This image is no longer available with the selected source fingerprint. Return to Samples and choose it again.");
  return source;
}
export function resolveStudyResult(snapshot: ResearchSnapshot | null, target: ResearchResult): ResearchResult {
  const result = snapshot?.results.find((row) => row.id === target.id && row.revision_hash === target.revision_hash &&
    row.source_id === target.source_id && row.source_sha256 === target.source_sha256);
  if (!result || !target.source_sha256) throw new Error("This exact result revision is no longer available. Return to Samples and choose it again.");
  resolveStudySource(snapshot, { id: result.source_id, sha256: target.source_sha256 });
  return result;
}
