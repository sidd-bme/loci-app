import { Clock3, FolderOpen, FolderUp, ImagePlus, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { RecentProjectSummary } from "../shared/contracts";
import BrandMark from "./BrandMark";

interface WelcomeWorkspaceProps {
  desktopAvailable: boolean;
  importing: boolean;
  busy: boolean;
  recentProjects: RecentProjectSummary[];
  onOpenImages: () => void;
  onOpenFolder: () => void;
  onOpenProject: () => void;
  onOpenRecentProject: (recentId: string) => void;
}

export default function WelcomeWorkspace({
  desktopAvailable,
  importing,
  busy,
  recentProjects,
  onOpenImages,
  onOpenFolder,
  onOpenProject,
  onOpenRecentProject,
}: WelcomeWorkspaceProps): React.JSX.Element {
  const [rippleSequence, setRippleSequence] = useState(0);
  const disabled = busy || !desktopAvailable;

  return (
    <div className="empty-state">
      <button
        className="welcome-mark-button"
        type="button"
        aria-label="Pulse Loci logo"
        title="Pulse the Loci mark"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setRippleSequence((sequence) => sequence + 1)}
      >
        <span className="welcome-mark-halo" aria-hidden="true" />
        <BrandMark />
        {rippleSequence > 0 && (
          <>
            <span
              key={`welcome-ripple-primary-${rippleSequence}`}
              className="welcome-ripple welcome-ripple-primary"
              data-sequence={rippleSequence}
              aria-hidden="true"
              onAnimationEnd={() => setRippleSequence(0)}
            />
            <span
              key={`welcome-ripple-secondary-${rippleSequence}`}
              className="welcome-ripple welcome-ripple-secondary"
              aria-hidden="true"
            />
          </>
        )}
      </button>
      <h1 className="empty-title">Bring every detail into focus.</h1>
      <p className="empty-copy">
        Open microscopy and histology images for careful viewing, display adjustment, and optional analysis. Source files remain read-only.
      </p>
      <div className="empty-actions">
        <button className="button button-primary" type="button" onClick={onOpenImages} disabled={disabled}>
          {importing ? <LoaderCircle className="loader" size={15} /> : <ImagePlus size={15} />}
          {importing ? "Inspecting…" : "Open images"}
        </button>
        <button className="button button-quiet" type="button" onClick={onOpenFolder} disabled={disabled}>
          <FolderOpen size={15} />
          Open folder
        </button>
        <button className="button button-quiet" type="button" onClick={onOpenProject} disabled={disabled}>
          <FolderUp size={15} />
          Open project
        </button>
      </div>
      <div className="format-note">
        <ShieldCheck size={12} />
        TIFF, PNG, JPEG, IMS · Sources stay read-only
      </div>
      {recentProjects.length > 0 && (
        <section className="recent-projects" aria-labelledby="recent-projects-heading">
          <div className="recent-projects-heading">
            <Clock3 size={12} aria-hidden="true" />
            <span id="recent-projects-heading">Recent projects</span>
          </div>
          <div className="recent-project-list">
            {recentProjects.slice(0, 4).map((project) => (
              <button
                key={project.recentId}
                className="recent-project-button"
                type="button"
                disabled={disabled}
                onClick={() => onOpenRecentProject(project.recentId)}
              >
                <span title={project.title}>{project.title}</span>
                <small>{project.sourceCount.toLocaleString()} source{project.sourceCount === 1 ? "" : "s"}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
