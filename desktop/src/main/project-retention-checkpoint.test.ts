// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ProjectRetentionCheckpointError,
  ProjectRetentionCheckpointFailClosedError,
  checkpointProjectBeforeRetention,
  restoreProjectAfterRetention,
} from "./project-retention-checkpoint";

describe("project retention checkpoint ordering", () => {
  it("durably publishes the new project before changing pack ownership", async () => {
    const order: string[] = [];
    const referencedPacks = new Set(["working-old-r0.loci-result"]);
    let projectRevision = 7;
    const persisted = await checkpointProjectBeforeRetention({
      persist: async () => {
        // The old pack remains referenced for the entire durable write. A crash
        // here therefore cannot make the still-authoritative project unrestorable.
        expect(referencedPacks.has("working-old-r0.loci-result")).toBe(true);
        projectRevision = 8;
        order.push("project:durably-saved");
        return { revision: 8 };
      },
      reconcile: async (project) => {
        expect(projectRevision).toBe(8);
        referencedPacks.delete("working-old-r0.loci-result");
        referencedPacks.add("working-new-r0.loci-result");
        order.push(`retention:revision-${project.revision}`);
      },
      rollbackPersistence: async () => {
        throw new Error("rollback must not run");
      },
      reconcilePrevious: async () => {
        throw new Error("previous reconciliation must not run");
      },
    });

    expect(persisted).toEqual({ revision: 8 });
    expect(order).toEqual([
      "project:durably-saved",
      "retention:revision-8",
    ]);
    expect([...referencedPacks]).toEqual(["working-new-r0.loci-result"]);
  });

  it("verifies an opened project's pack ownership before replacing the usable session", async () => {
    const order: string[] = [];
    let activeProject = "project-old";

    await expect(restoreProjectAfterRetention({
      reconcile: async () => {
        expect(activeProject).toBe("project-old");
        order.push("retention:new-verified");
      },
      install: async () => {
        activeProject = "project-new";
        order.push("session:new-installed");
        return activeProject;
      },
    })).resolves.toBe("project-new");

    expect(order).toEqual(["retention:new-verified", "session:new-installed"]);
    expect(activeProject).toBe("project-new");
  });

  it("keeps the current session intact when opened-project retention cannot reconcile", async () => {
    const failure = new Error("missing active working pack");
    let activeProject = "project-old";
    let installCalled = false;

    await expect(restoreProjectAfterRetention({
      reconcile: async () => {
        throw failure;
      },
      install: async () => {
        installCalled = true;
        activeProject = "project-new";
        return activeProject;
      },
    })).rejects.toBe(failure);

    expect(installCalled).toBe(false);
    expect(activeProject).toBe("project-old");
  });

  it("does not make the prior pack set eligible when project persistence fails", async () => {
    const order: string[] = [];
    const original = new Error("disk full before atomic replacement");
    const referencedPacks = new Set(["working-old-r0.loci-result"]);

    await expect(checkpointProjectBeforeRetention({
      persist: async () => {
        order.push("project:failed");
        throw original;
      },
      reconcile: async () => {
        referencedPacks.clear();
        order.push("retention:changed");
      },
      rollbackPersistence: async () => {
        order.push("project:rollback");
        return { revision: 7 };
      },
      reconcilePrevious: async () => {
        order.push("retention:previous");
      },
    })).rejects.toBe(original);

    expect(order).toEqual(["project:failed"]);
    expect([...referencedPacks]).toEqual(["working-old-r0.loci-result"]);
  });

  it("restores the prior document and ownership after reconciliation fails", async () => {
    const order: string[] = [];
    const reconciliationFailure = new Error("ledger unavailable");
    const referencedPacks = new Set(["working-old-r0.loci-result"]);
    let captured: unknown;

    try {
      await checkpointProjectBeforeRetention({
        persist: async () => {
          order.push("project:new");
          return { revision: 8 };
        },
        reconcile: async () => {
          // The real retention store publishes atomically; model a failure
          // before its ownership set changes.
          expect([...referencedPacks]).toEqual(["working-old-r0.loci-result"]);
          order.push("retention:new-failed");
          throw reconciliationFailure;
        },
        rollbackPersistence: async (persisted) => {
          order.push(`project:previous-after-${persisted.revision}`);
          return { revision: 9, logicalRevision: 7 };
        },
        reconcilePrevious: async (rolledBack) => {
          referencedPacks.add("working-old-r0.loci-result");
          order.push(`retention:previous-${rolledBack.logicalRevision}`);
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(order).toEqual([
      "project:new",
      "retention:new-failed",
      "project:previous-after-8",
      "retention:previous-7",
    ]);
    expect(captured).toBeInstanceOf(ProjectRetentionCheckpointError);
    expect(captured).toMatchObject({
      code: "project-retention-checkpoint-rolled-back",
      cause: reconciliationFailure,
      rolledBack: { revision: 9, logicalRevision: 7 },
    });
    expect([...referencedPacks]).toEqual(["working-old-r0.loci-result"]);
  });

  it("rolls back a new project publication while preserving session-owned packs", async () => {
    const order: string[] = [];
    const sessionOwnedPacks = new Set(["working-new-r0.loci-result"]);
    let projectPublished = false;
    let activeProject: { projectId: string } | null = null;

    await expect(checkpointProjectBeforeRetention({
      persist: async () => {
        projectPublished = true;
        activeProject = { projectId: "project-new" };
        order.push("project:created");
        return activeProject;
      },
      reconcile: async () => {
        expect(projectPublished).toBe(true);
        expect(sessionOwnedPacks.has("working-new-r0.loci-result")).toBe(true);
        order.push("retention:new-failed");
        throw new Error("ledger unavailable");
      },
      rollbackPersistence: async () => {
        projectPublished = false;
        activeProject = null;
        order.push("project:discarded");
        return null;
      },
      reconcilePrevious: async () => {
        order.push("retention:no-prior-project");
      },
    })).rejects.toMatchObject({
      code: "project-retention-checkpoint-rolled-back",
      rolledBack: null,
    });

    expect(projectPublished).toBe(false);
    expect(activeProject).toBeNull();
    expect([...sessionOwnedPacks]).toEqual(["working-new-r0.loci-result"]);
    expect(order).toEqual([
      "project:created",
      "retention:new-failed",
      "project:discarded",
      "retention:no-prior-project",
    ]);
  });

  it("reports fail-closed when the prior checkpoint cannot be restored", async () => {
    const reconciliationFailure = new Error("ledger unavailable");
    const rollbackFailure = new Error("project rollback unavailable");
    let captured: unknown;

    try {
      await checkpointProjectBeforeRetention({
        persist: async () => ({ revision: 8 }),
        reconcile: async () => {
          throw reconciliationFailure;
        },
        rollbackPersistence: async () => {
          throw rollbackFailure;
        },
        reconcilePrevious: async () => undefined,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ProjectRetentionCheckpointFailClosedError);
    expect(captured).toMatchObject({
      code: "project-retention-checkpoint-fail-closed",
      cause: reconciliationFailure,
      rollbackFailure,
      persisted: { revision: 8 },
    });
  });
});
