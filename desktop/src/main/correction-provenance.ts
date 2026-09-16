import type { AnalysisCorrections } from "../shared/contracts";

/** Retain the engine's URL-safe operation identities across project saves. */
export function correctionOperationIds(
  corrections: Pick<AnalysisCorrections, "appliedOperations">,
): string[] {
  const ids = corrections.appliedOperations.map((operation) => operation.operation_id);
  if (
    ids.some((operationId) =>
      typeof operationId !== "string" ||
      operationId.trim() !== operationId ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/.test(operationId)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("The analysis engine returned invalid correction operation provenance.");
  }
  return ids as string[];
}
