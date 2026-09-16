// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  DurableCorrectionFailClosedError,
  DurableCorrectionTransactionError,
  executeDurableCorrectionTransaction,
  runDurableCorrectionOnProjectLane,
  type DurableCorrectionFailureStage,
  type DurableCorrectionInvalidationContext,
  type DurableCorrectionRollbackContext,
  type DurableCorrectionTransactionSteps,
} from "./durable-correction-transaction";
import { DurableOperationTracker } from "./durable-operations";
import { ProjectSourceOperationQueue } from "./project-source-operations";

type Mutation = { revision: number };
type Publication = { artifact: string };
type Commit = { committedRevision: number };
type Checkpoint = { projectRevision: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

type Steps = DurableCorrectionTransactionSteps<
  Mutation,
  Publication,
  Commit,
  Checkpoint
>;

interface StepFixture {
  order: string[];
  rollbackContexts: Array<
    Readonly<DurableCorrectionRollbackContext<Mutation, Publication, Commit>>
  >;
  invalidationContexts: Array<
    Readonly<DurableCorrectionInvalidationContext<Mutation, Publication, Commit>>
  >;
  steps: Steps;
}

function fixture(overrides: Partial<Steps> = {}): StepFixture {
  const order: string[] = [];
  const rollbackContexts: StepFixture["rollbackContexts"] = [];
  const invalidationContexts: StepFixture["invalidationContexts"] = [];
  const steps: Steps = {
    mutate: () => {
      order.push("mutate");
      return { revision: 4 };
    },
    publish: (mutation) => {
      order.push(`publish:${mutation.revision}`);
      return { artifact: "working-result-r4" };
    },
    commit: (context) => {
      order.push(`commit:${context.publication.artifact}`);
      expect(Object.isFrozen(context)).toBe(true);
      return { committedRevision: context.mutation.revision };
    },
    checkpoint: (context) => {
      order.push(`checkpoint:${context.commit.committedRevision}`);
      expect(Object.isFrozen(context)).toBe(true);
      return { projectRevision: 9 };
    },
    rollback: (context) => {
      order.push(`rollback:${context.failedStage}`);
      rollbackContexts.push(context);
    },
    invalidate: (context) => {
      order.push(`invalidate:${context.failedStage}`);
      invalidationContexts.push(context);
    },
    ...overrides,
  };
  return { order, rollbackContexts, invalidationContexts, steps };
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected transaction to reject.");
}

describe("durable correction transaction", () => {
  it("orders the complete correction checkpoint between project saves", async () => {
    const projectOperations = new ProjectSourceOperationQueue();
    const resultOperations = new DurableOperationTracker();
    const firstSave = deferred<void>();
    const publication = deferred<void>();
    const order: string[] = [];

    const savingBefore = projectOperations.runProject(async () => {
      order.push("save-before:start");
      await firstSave.promise;
      order.push("save-before:finish");
    });
    const correcting = runDurableCorrectionOnProjectLane(
      projectOperations,
      resultOperations,
      async () => {
        order.push("correction:mutate");
        await publication.promise;
        order.push("correction:checkpoint");
        return "corrected";
      },
    );
    const savingAfter = projectOperations.runProject(async () => {
      order.push("save-after");
    });

    await vi.waitFor(() => expect(order).toEqual(["save-before:start"]));
    firstSave.resolve();
    await vi.waitFor(() => expect(order).toEqual([
      "save-before:start",
      "save-before:finish",
      "correction:mutate",
    ]));
    publication.resolve();

    await expect(Promise.all([savingBefore, correcting, savingAfter])).resolves.toEqual([
      undefined,
      "corrected",
      undefined,
    ]);
    expect(order).toEqual([
      "save-before:start",
      "save-before:finish",
      "correction:mutate",
      "correction:checkpoint",
      "save-after",
    ]);
  });
  it("enforces mutate -> publish -> commit -> checkpoint and returns frozen receipts", async () => {
    const test = fixture();

    const result = await executeDurableCorrectionTransaction(test.steps);

    expect(test.order).toEqual([
      "mutate",
      "publish:4",
      "commit:working-result-r4",
      "checkpoint:4",
    ]);
    expect(result).toEqual({
      mutation: { revision: 4 },
      publication: { artifact: "working-result-r4" },
      commit: { committedRevision: 4 },
      checkpoint: { projectRevision: 9 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.rollbackContexts).toEqual([]);
    expect(test.invalidationContexts).toEqual([]);
  });

  it("returns a mutation failure unchanged without rollback or invalidation", async () => {
    const original = new Error("mutation failed");
    const test = fixture({
      mutate: () => {
        test.order.push("mutate");
        throw original;
      },
    });

    const error = await captureFailure(
      () => executeDurableCorrectionTransaction(test.steps),
    );

    expect(error).toBe(original);
    expect(test.order).toEqual(["mutate"]);
    expect(test.rollbackContexts).toEqual([]);
    expect(test.invalidationContexts).toEqual([]);
  });

  it.each<{
    stage: DurableCorrectionFailureStage;
    expectedOrder: string[];
    publicationCompleted: boolean;
    commitCompleted: boolean;
  }>([
    {
      stage: "publish",
      expectedOrder: ["mutate", "publish", "rollback:publish"],
      publicationCompleted: false,
      commitCompleted: false,
    },
    {
      stage: "commit",
      expectedOrder: ["mutate", "publish", "commit", "rollback:commit"],
      publicationCompleted: true,
      commitCompleted: false,
    },
    {
      stage: "checkpoint",
      expectedOrder: [
        "mutate",
        "publish",
        "commit",
        "checkpoint",
        "rollback:checkpoint",
      ],
      publicationCompleted: true,
      commitCompleted: true,
    },
  ])(
    "rolls back a $stage failure before rejecting with its original cause",
    async ({ stage, expectedOrder, publicationCompleted, commitCompleted }) => {
      const original = new Error(`${stage} failed`);
      const test = fixture({
        mutate: () => {
          test.order.push("mutate");
          return { revision: 4 };
        },
        publish: () => {
          test.order.push("publish");
          if (stage === "publish") throw original;
          return { artifact: "working-result-r4" };
        },
        commit: () => {
          test.order.push("commit");
          if (stage === "commit") throw original;
          return { committedRevision: 4 };
        },
        checkpoint: () => {
          test.order.push("checkpoint");
          if (stage === "checkpoint") throw original;
          return { projectRevision: 9 };
        },
        rollback: (context) => {
          test.order.push(`rollback:${context.failedStage}`);
          test.rollbackContexts.push(context);
          expect(Object.isFrozen(context)).toBe(true);
        },
      });

      const error = await captureFailure(
        () => executeDurableCorrectionTransaction(test.steps),
      );

      expect(test.order).toEqual(expectedOrder);
      expect(error).toBeInstanceOf(DurableCorrectionTransactionError);
      expect(error).not.toBeInstanceOf(DurableCorrectionFailClosedError);
      expect(error).toMatchObject({
        code: "durable-correction-rolled-back",
        failedStage: stage,
        cause: original,
      });
      expect(test.rollbackContexts).toHaveLength(1);
      expect(test.rollbackContexts[0]).toMatchObject({
        failedStage: stage,
        failure: original,
        mutation: { revision: 4 },
        publicationCompleted,
        commitCompleted,
      });
      expect(test.rollbackContexts[0].publication).toEqual(
        publicationCompleted ? { artifact: "working-result-r4" } : undefined,
      );
      expect(test.rollbackContexts[0].commit).toEqual(
        commitCompleted ? { committedRevision: 4 } : undefined,
      );
      expect(test.invalidationContexts).toEqual([]);
    },
  );

  it("invalidates and throws the distinct fail-closed error when rollback fails", async () => {
    const original = new Error("checkpoint failed");
    const rollbackFailure = new Error("rollback failed");
    const test = fixture({
      checkpoint: () => {
        test.order.push("checkpoint");
        throw original;
      },
      rollback: (context) => {
        test.order.push(`rollback:${context.failedStage}`);
        test.rollbackContexts.push(context);
        throw rollbackFailure;
      },
      invalidate: (context) => {
        test.order.push(`invalidate:${context.failedStage}`);
        test.invalidationContexts.push(context);
        expect(Object.isFrozen(context)).toBe(true);
      },
    });

    const error = await captureFailure(
      () => executeDurableCorrectionTransaction(test.steps),
    );

    expect(test.order).toEqual([
      "mutate",
      "publish:4",
      "commit:working-result-r4",
      "checkpoint",
      "rollback:checkpoint",
      "invalidate:checkpoint",
    ]);
    expect(error).toBeInstanceOf(DurableCorrectionFailClosedError);
    expect(error).not.toBeInstanceOf(DurableCorrectionTransactionError);
    expect(error).toMatchObject({
      code: "durable-correction-fail-closed",
      failedStage: "checkpoint",
      cause: original,
      rollbackFailure,
      invalidationFailure: null,
      invalidationSucceeded: true,
    });
    expect(test.invalidationContexts).toHaveLength(1);
    expect(test.invalidationContexts[0]).toMatchObject({
      failedStage: "checkpoint",
      failure: original,
      rollbackFailure,
      publicationCompleted: true,
      commitCompleted: true,
    });
  });

  it("still rejects fail-closed with every cause when invalidation also fails", async () => {
    const original = new Error("commit failed");
    const rollbackFailure = new Error("rollback failed");
    const invalidationFailure = new Error("invalidation failed");
    const test = fixture({
      commit: () => {
        test.order.push("commit");
        throw original;
      },
      rollback: (context) => {
        test.order.push(`rollback:${context.failedStage}`);
        throw rollbackFailure;
      },
      invalidate: (context) => {
        test.order.push(`invalidate:${context.failedStage}`);
        test.invalidationContexts.push(context);
        throw invalidationFailure;
      },
    });

    const error = await captureFailure(
      () => executeDurableCorrectionTransaction(test.steps),
    );

    expect(test.order).toEqual([
      "mutate",
      "publish:4",
      "commit",
      "rollback:commit",
      "invalidate:commit",
    ]);
    expect(error).toBeInstanceOf(DurableCorrectionFailClosedError);
    expect(error).toMatchObject({
      code: "durable-correction-fail-closed",
      failedStage: "commit",
      cause: original,
      rollbackFailure,
      invalidationFailure,
      invalidationSucceeded: false,
    });
    expect((error as Error).message).toMatch(/must remain unusable/i);
    expect(test.invalidationContexts[0].rollbackFailure).toBe(rollbackFailure);
  });
});
