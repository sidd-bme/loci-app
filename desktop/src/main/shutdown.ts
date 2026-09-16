export type ShutdownPromptChoice = "keep-waiting" | "force-quit";

export type ShutdownOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: unknown }
  | { kind: "force-quit" };

/**
 * Give durable writes a grace period, then keep asking for an explicit choice.
 * The underlying operation remains observed after force-quit so rejection can
 * never become an unhandled promise.
 */
export async function waitForShutdownDecision(
  operation: Promise<void>,
  prompt: () => Promise<ShutdownPromptChoice>,
  graceMilliseconds: number,
): Promise<ShutdownOutcome> {
  if (!Number.isFinite(graceMilliseconds) || graceMilliseconds < 0) {
    throw new RangeError("Shutdown grace period must be a non-negative number.");
  }
  const settled: Promise<ShutdownOutcome> = operation.then(
    () => ({ kind: "completed" }),
    (error: unknown) => ({ kind: "failed", error }),
  );
  let settledOutcome: ShutdownOutcome | undefined;
  void settled.then((outcome) => {
    settledOutcome = outcome;
  });

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promptDue = new Promise<{ kind: "prompt" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "prompt" }), graceMilliseconds);
    });
    const outcome = await Promise.race([
      settled,
      promptDue,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.kind !== "prompt") return outcome;
    const choice = await prompt();
    if (settledOutcome) return settledOutcome;
    if (choice === "force-quit") return { kind: "force-quit" };
  }
}
