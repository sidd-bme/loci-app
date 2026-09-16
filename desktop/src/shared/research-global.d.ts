import type { ResearchDesktopApi } from "./research-contracts";

declare global {
  interface Window { lociResearch?: ResearchDesktopApi }
}
