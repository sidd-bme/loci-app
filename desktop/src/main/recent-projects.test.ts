// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => process.env.LOCI_RECENT_PROJECT_TEST_ROOT },
}));

import { RecentProjectRegistry } from "./recent-projects";
import { createProject } from "./project-store";
import {
  PROJECT_MANIFEST_SCHEMA,
  type ProjectManifestV1,
} from "../shared/foundation-contracts";

let root: string;
let registryPath: string;

function manifest(title: string, updatedAt: string): ProjectManifestV1 {
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA,
    projectId: `project-${title.toLocaleLowerCase("en-US").replaceAll(" ", "-")}`,
    title,
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt,
    appVersion: "0.1.0",
    sources: [],
    displayRecipes: [],
    annotations: [],
    corrections: [],
    modelResults: [],
    reviews: [],
    jobs: [],
    migrations: [],
  };
}

async function project(name: string, minute: number) {
  const projectPath = path.join(root, `${name}.loci-project`);
  return createProject(
    projectPath,
    manifest(name, `2026-08-31T08:${String(minute).padStart(2, "0")}:00.000Z`),
    [],
  );
}

describe("recent project registry", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-recent-projects-"));
    registryPath = path.join(root, "private", "recent-projects.json");
    process.env.LOCI_RECENT_PROJECT_TEST_ROOT = root;
  });

  afterEach(async () => {
    delete process.env.LOCI_RECENT_PROJECT_TEST_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("deduplicates in most-recent order and returns only renderer-safe summaries", async () => {
    const registry = new RecentProjectRegistry(registryPath);
    const first = await project("First study", 1);
    const second = await project("Second study", 2);
    await registry.remember(first);
    const afterSecond = await registry.remember(second);
    const afterReopen = await registry.remember(first);

    expect(afterSecond.map(({ title }) => title)).toEqual(["Second study", "First study"]);
    expect(afterReopen.map(({ title }) => title)).toEqual(["First study", "Second study"]);
    expect(afterReopen[0]).toEqual({
      recentId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      title: "First study",
      updatedAt: "2026-08-31T08:01:00.000Z",
      sourceCount: 0,
    });
    expect(Object.keys(afterReopen[0]).sort()).toEqual([
      "recentId",
      "sourceCount",
      "title",
      "updatedAt",
    ]);
    expect(JSON.stringify(afterReopen)).not.toContain(root);
    expect(JSON.stringify(afterReopen)).not.toContain("projectPath");
    await expect(registry.resolve(afterReopen[0].recentId)).resolves.toBe(first.filePath);
    expect((await fs.stat(registryPath)).mode & 0o077).toBe(0);

    const stored = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(stored.entries).toHaveLength(2);
    expect(stored.entries[0].recentId).toBe(afterReopen[0].recentId);
    expect(stored.entries[0].projectPath).toBe(first.filePath);
  });

  it("retains at most eight usable projects", async () => {
    const registry = new RecentProjectRegistry(registryPath);
    for (let index = 0; index < 10; index += 1) {
      await registry.remember(await project(`Study ${index}`, index));
    }
    const recent = await registry.list();
    expect(recent).toHaveLength(8);
    expect(recent.map(({ title }) => title)).toEqual([
      "Study 9",
      "Study 8",
      "Study 7",
      "Study 6",
      "Study 5",
      "Study 4",
      "Study 3",
      "Study 2",
    ]);
  });

  it("prunes missing, non-regular, symlinked, and invalid project entries", async () => {
    const registry = new RecentProjectRegistry(registryPath);
    const kept = await project("Kept", 1);
    const missing = await project("Missing", 2);
    const directory = await project("Directory", 3);
    const linked = await project("Linked", 4);
    for (const current of [kept, missing, directory, linked]) {
      await registry.remember(current);
    }

    await fs.rm(missing.filePath);
    await fs.rm(directory.filePath);
    await fs.mkdir(directory.filePath);
    await fs.rm(linked.filePath);
    await fs.symlink(kept.filePath, linked.filePath);

    const recent = await registry.list();
    expect(recent.map(({ title }) => title)).toEqual(["Kept"]);
    const stored = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0].projectPath).toBe(kept.filePath);
  });

  it("resolves opaque ids only in main and supports remove and clear", async () => {
    const registry = new RecentProjectRegistry(registryPath);
    const first = await project("First", 1);
    const second = await project("Second", 2);
    await registry.remember(first);
    const recent = await registry.remember(second);

    await expect(registry.resolve("../First.loci-project")).resolves.toBeUndefined();
    await registry.remove(recent[0].recentId);
    await expect(registry.list()).resolves.toEqual([recent[1]]);
    await expect(registry.resolve(recent[0].recentId)).resolves.toBeUndefined();

    await registry.clear();
    await expect(registry.list()).resolves.toEqual([]);
    expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toEqual({
      schemaVersion: "loci.recent-projects/v1",
      entries: [],
    });
  });

  it("fails closed on malformed or linked registry state", async () => {
    const registry = new RecentProjectRegistry(registryPath);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({ password: "secret", entries: [] }));
    await expect(registry.list()).resolves.toEqual([]);

    await fs.rm(registryPath);
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify({
      schemaVersion: "loci.recent-projects/v1",
      entries: [],
    }));
    await fs.symlink(outside, registryPath);
    await expect(registry.list()).resolves.toEqual([]);
  });
});
