import type { ResearchDesktopApi } from "./research-contracts";

export type SettingsPage = "appearance" | "compute";
export type SettingsWindowNavigation = { page: SettingsPage; revision: number };

export type SettingsWindowApi = {
  getNavigation(): Promise<SettingsWindowNavigation>;
  onNavigate(callback: (route: SettingsWindowNavigation) => void): () => void;
  close(): Promise<void>;
  requestQuit(): Promise<void>;
  computeTargets: NonNullable<ResearchDesktopApi["computeTargets"]>;
};

declare global {
  interface Window { lociSettings?: SettingsWindowApi; }
}
