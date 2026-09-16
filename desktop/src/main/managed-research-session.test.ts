// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ManagedResearchSessionError,
  ManagedResearchSessionStore,
  type ManagedSessionReservation,
} from "./managed-research-session";

let root: string;

async function createManaged(
  store: ManagedResearchSessionStore,
  title = "Recovered image",
): Promise<ManagedSessionReservation> {
  const reservation = await store.reserve(title);
  await fs.mkdir(reservation.projectPath, { mode: 0o700 });
  await fs.writeFile(path.join(reservation.projectPath, "study.sqlite3"), "engine-owned");
  await store.adopt(reservation);
  return reservation;
}

describe("managed research sessions", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-managed-session-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores an opaque managed session with a private ownership marker and atomic record", async () => {
    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store, "Cell image");
    const state = await store.resolveActive();

    expect(state.projectPath).toBe(reservation.projectPath);
    expect(state.state).toMatchObject({
      status: "ready",
      sessionId: reservation.sessionId,
      title: "Cell image",
      storage: "managed",
      saved: false,
    });
    expect(JSON.stringify(state.state)).not.toContain(root);

    const markerPath = path.join(reservation.projectPath, ".loci-session-owner.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    expect(marker).toMatchObject({
      schemaVersion: "loci.managed-research-session/v1",
      sessionId: reservation.sessionId,
      title: "Cell image",
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(markerPath)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(root, "research-study.json"))).mode & 0o077).toBe(0);
    }
    const stored = JSON.parse(await fs.readFile(path.join(root, "research-study.json"), "utf8"));
    expect(stored.sessions[0]).toMatchObject({
      sessionId: reservation.sessionId,
      managed: true,
      savedPath: null,
      activeLocation: "managed",
    });
  });

  it("reports the registry activity timestamp without reading study contents", async () => {
    const fixed = "11111111-1111-4111-8111-111111111111";
    const times = ["2026-09-08T01:00:00.000Z", "2026-09-08T01:01:00.000Z"];
    const store = new ManagedResearchSessionStore(root, () => fixed, () => times.shift()!);
    const reservation = await store.reserve("Recent study");
    await fs.mkdir(reservation.projectPath, { mode: 0o700 });
    await fs.writeFile(path.join(reservation.projectPath, "study.sqlite3"), "opaque");

    const adopted = await store.adopt(reservation);

    expect(adopted.updatedAt).toBe("2026-09-08T01:01:00.000Z");
    await expect(store.listRecovery()).resolves.toMatchObject([{
      sessionId: fixed,
      updatedAt: "2026-09-08T01:01:00.000Z",
    }]);
  });

  it("survives a missing saved location and keeps the managed recovery copy", async () => {
    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store);
    const saved = path.join(root, "Saved study.loci-study");
    await fs.mkdir(saved);
    await store.rememberSaved(reservation.sessionId, saved);
    await fs.rm(saved, { recursive: true });

    const reopened = new ManagedResearchSessionStore(root);
    await expect(reopened.resolveActive()).resolves.toMatchObject({
      projectPath: null,
      state: {
        status: "recoverable",
        reason: "saved-study-missing",
        canKeep: true,
      },
    });
    const kept = await reopened.keep(reservation.sessionId);
    expect(kept.projectPath).toBe(reservation.projectPath);
    expect(kept.state).toMatchObject({ status: "ready", storage: "managed" });
    expect(await fs.readFile(path.join(reservation.projectPath, "study.sqlite3"), "utf8"))
      .toBe("engine-owned");
  });

  it("leaves the active session without allocating or deleting recovery work", async () => {
    const empty = new ManagedResearchSessionStore(path.join(root, "empty"));
    await empty.leaveActive();
    await expect(fs.lstat(path.join(root, "empty", "research-study.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store, "Recent work");
    await store.leaveActive();

    await expect(store.resolveActive()).resolves.toEqual({
      projectPath: null,
      state: { status: "empty" },
    });
    await expect(store.listRecovery()).resolves.toMatchObject([{
      sessionId: reservation.sessionId,
      title: "Recent work",
      status: "ready",
      storage: "managed",
    }]);
    expect(await fs.readFile(path.join(reservation.projectPath, "study.sqlite3"), "utf8"))
      .toBe("engine-owned");
    const registry = JSON.parse(await fs.readFile(path.join(root, "research-study.json"), "utf8"));
    expect(registry.activeSessionId).toBeNull();
    expect(registry.sessions).toHaveLength(1);
  });

  it("reopens a ready saved study at its saved location", async () => {
    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store);
    const saved = path.join(root, "Ready saved study.loci-study");
    await fs.mkdir(saved);
    await fs.writeFile(path.join(saved, "study.sqlite3"), "saved-study");
    await store.rememberSaved(reservation.sessionId, saved);
    await store.leaveActive();

    const kept = await store.keep(reservation.sessionId);
    expect(kept.projectPath).toBe(saved);
    expect(kept.state).toMatchObject({ status: "ready", storage: "saved" });
    expect(await fs.readFile(path.join(saved, "study.sqlite3"), "utf8")).toBe("saved-study");
    expect(await fs.readFile(path.join(reservation.projectPath, "study.sqlite3"), "utf8"))
      .toBe("engine-owned");
  });

  it("rejects linked saved studies and refuses to discard redirected managed directories", async () => {
    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store);
    const outside = path.join(root, "outside.loci-study");
    const savedLink = path.join(root, "linked.loci-study");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "untouched");
    await fs.symlink(outside, savedLink, process.platform === "win32" ? "junction" : "dir");

    await expect(store.rememberSaved(reservation.sessionId, savedLink)).rejects.toMatchObject({
      code: "session-unavailable",
    });

    const saved = path.join(root, "remembered.loci-study");
    await fs.mkdir(saved);
    await store.rememberSaved(reservation.sessionId, saved);
    await fs.rm(saved, { recursive: true });
    await fs.symlink(outside, saved, process.platform === "win32" ? "junction" : "dir");
    await expect(store.resolveActive()).resolves.toMatchObject({
      projectPath: null,
      state: { status: "recoverable", reason: "saved-study-unsafe", canKeep: true },
    });

    await fs.rm(reservation.projectPath, { recursive: true });
    await fs.symlink(outside, reservation.projectPath,
      process.platform === "win32" ? "junction" : "dir");
    await expect(store.discard(reservation.sessionId)).rejects.toBeInstanceOf(
      ManagedResearchSessionError,
    );
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("untouched");
  });

  it("fails bounded allocation on repeated collisions without changing the existing directory", async () => {
    const fixed = "11111111-1111-4111-8111-111111111111";
    const collision = path.join(root, "sessions", `${fixed}.loci-study`);
    await fs.mkdir(collision, { recursive: true });
    await fs.writeFile(path.join(collision, "keep.txt"), "existing");
    const store = new ManagedResearchSessionStore(root, () => fixed);

    await expect(store.reserve("Collision")).rejects.toMatchObject({ code: "session-collision" });
    expect(await fs.readFile(path.join(collision, "keep.txt"), "utf8")).toBe("existing");
  });

  it("moves only an ownership-marked managed directory to app trash and supports undo", async () => {
    const store = new ManagedResearchSessionStore(root);
    const reservation = await createManaged(store);
    const saved = path.join(root, "User study.loci-study");
    await fs.mkdir(saved);
    await fs.writeFile(path.join(saved, "user.txt"), "preserve");
    await store.rememberSaved(reservation.sessionId, saved);

    const { undoToken } = await store.discard(reservation.sessionId);
    await expect(fs.lstat(reservation.projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(saved, "user.txt"), "utf8")).toBe("preserve");
    await expect(store.resolveActive()).resolves.toEqual({
      projectPath: null,
      state: { status: "empty" },
    });

    await store.undoDiscard(undoToken);
    expect(await fs.readFile(path.join(reservation.projectPath, "study.sqlite3"), "utf8"))
      .toBe("engine-owned");
    expect((await store.resolveActive()).projectPath).toBe(saved);
  });
});
