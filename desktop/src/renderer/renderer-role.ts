import type { AgentWorkspaceApi } from "../shared/agent-workspace-api";
import type { ImageWindowApi } from "../shared/image-window-api";

/** Roles are native sender capabilities. A window URL is never authority. */
export async function rendererRole(agent: Pick<AgentWorkspaceApi, "state"> | undefined,
  image: Pick<ImageWindowApi, "state"> | undefined): Promise<"workspace" | "image" | "main"> {
  if (agent) {
    try { if ((await agent.state()).role === "workspace") return "workspace"; }
    catch { /* Image-only senders can reject the workspace channel. */ }
  }
  if (image && (await image.state()).role === "image") return "image";
  return "main";
}
