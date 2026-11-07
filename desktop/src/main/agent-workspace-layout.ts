import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { visibleImageBounds, type ImageWindowBounds } from "./image-window-layout";

export interface AgentWorkspaceLayout { schema: "loci.agent-workspace-layout/v1"; bounds: ImageWindowBounds }
export interface AgentWorkspaceLayouts { read(identity: string): Promise<AgentWorkspaceLayout | null>; write(identity: string, layout: AgentWorkspaceLayout): Promise<void> }
export function validateAgentWorkspaceLayout(value: unknown): AgentWorkspaceLayout {
  const v = value as AgentWorkspaceLayout;
  if (!v || Object.keys(v).sort().join(',') !== 'bounds,schema' || v.schema !== "loci.agent-workspace-layout/v1" || !v.bounds || Object.keys(v.bounds).sort().join(',') !== 'height,width,x,y' || Object.values(v.bounds).some(n => !Number.isSafeInteger(n)) || v.bounds.width < 1 || v.bounds.height < 1 || v.bounds.width > 16384 || v.bounds.height > 16384) throw new Error("Invalid local agent workspace layout.");
  return structuredClone(v);
}
export const visibleAgentWorkspaceBounds = visibleImageBounds;
/** Only window bounds are durable; plans, permissions and connection claims are not layout data. */
export class AgentWorkspaceLayoutStore implements AgentWorkspaceLayouts {
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file(identity: string): string { return path.join(this.directory, createHash('sha256').update(identity).digest('hex') + '.json'); }
  async read(identity: string): Promise<AgentWorkspaceLayout | null> {
    const file = this.file(identity); let info;
    try { info = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Invalid saved agent workspace layout file.");
    return validateAgentWorkspaceLayout(JSON.parse(await fs.readFile(file, 'utf8')));
  }
  write(identity: string, value: AgentWorkspaceLayout): Promise<void> {
    const content = JSON.stringify(validateAgentWorkspaceLayout(value)), file = this.file(identity);
    const write = async () => { await fs.mkdir(this.directory, { recursive: true }); const temporary = file + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    };
    const pending = this.writes.then(write, write); this.writes = pending; return pending;
  }
}
