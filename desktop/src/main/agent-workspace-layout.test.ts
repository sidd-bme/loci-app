// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentWorkspaceLayoutStore, validateAgentWorkspaceLayout, type AgentWorkspaceLayout } from './agent-workspace-layout';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const value = (x = 10): AgentWorkspaceLayout => ({ schema: 'loci.agent-workspace-layout/v1', bounds: { x, y: 20, width: 1000, height: 700 } });
it('atomically persists only bounds under a hashed private study identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loci-agent-layout-')); directories.push(directory);
  const store = new AgentWorkspaceLayoutStore(directory), identity = '/private/Study.loci-study';
  expect(await store.read(identity)).toBeNull();
  await Promise.all([store.write(identity, value()), store.write(identity, value(30))]);
  expect(await store.read(identity)).toEqual(value(30));
  const files = await fs.readdir(directory); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
  expect(await fs.readFile(path.join(directory, files[0]), 'utf8')).not.toContain(identity);
  expect((await fs.stat(path.join(directory, files[0]))).mode & 0o777).toBe(0o600);
});
it('rejects symlinks and malformed or scientific state in a layout record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loci-agent-layout-')); directories.push(directory);
  const store = new AgentWorkspaceLayoutStore(directory), identity = '/private/Study'; await store.write(identity, value());
  const [file] = await fs.readdir(directory), target = path.join(directory, 'target.json');
  await fs.rename(path.join(directory, file), target); await fs.symlink(target, path.join(directory, file));
  await expect(store.read(identity)).rejects.toThrow('layout');
  expect(() => validateAgentWorkspaceLayout({ ...value(), permissions: ['execute'] })).toThrow();
  expect(() => validateAgentWorkspaceLayout({ ...value(), bounds: { ...value().bounds, x: NaN } })).toThrow();
});
