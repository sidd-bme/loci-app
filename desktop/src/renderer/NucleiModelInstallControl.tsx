import React from "react";
import { NUCLEI_MODEL_INSTALL } from "../shared/nuclei-model-install";

export const NUCLEI_INSTALL_ORIGIN =
  "BioImage.IO affable-shark v0 (hypha.aicell.io · original Zenodo 6647674)";

export const NUCLEI_INSTALL_DOWNLOADING_STATUS =
  "Downloading from BioImage.IO (affable-shark v0) and verifying SHA-256 and CPU reference tensors…";

export type NucleiInstallState = {
  phase: "idle" | "installing" | "cancelling" | "cancelled" | "failed";
  status?: string;
  error?: string;
  cancelPending?: boolean;
};

export type NucleiModelMatch = {
  modelId: string;
  state: "ready" | "reimport-required";
};

export interface NucleiModelInstallController {
  supported: boolean;
  canCancel: boolean;
  availability: "unknown" | "not-installed" | "ready" | "reimport-required";
  installedModelId: string | null;
  state: NucleiInstallState;
  busyBlocked: boolean;
  unavailableReason: string | null;
  onInstall: () => void;
  onCancel: () => void;
}

export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes >= 1024 ** 3) {
    const gib = bytes / 1024 ** 3;
    return Number.isInteger(gib) ? `${gib} GiB` : `${gib.toFixed(1)} GiB`;
  }
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes)} B`;
}

/**
 * Matches only the normal engine model_list DTO: exact package.package_sha256,
 * explicit availability.state, and reference_qualification.compatible === true.
 */
export function findInstalledNucleiModel(
  models: readonly Record<string, unknown>[],
): NucleiModelMatch | null {
  const target = NUCLEI_MODEL_INSTALL.packageSha256;
  let recovery: NucleiModelMatch | null = null;
  for (const item of models) {
    if (typeof item.model_id !== "string" || !item.model_id) continue;
    const pkg = item.package as Record<string, unknown> | undefined;
    if (pkg?.package_sha256 !== target) continue;
    const availability = (item.availability as Record<string, unknown> | undefined)?.state;
    const compatible =
      (item.reference_qualification as Record<string, unknown> | undefined)?.compatible === true;
    if (availability === "ready" && compatible) {
      return { modelId: item.model_id, state: "ready" };
    }
    if (availability === "reimport-required" && !recovery) {
      recovery = { modelId: item.model_id, state: "reimport-required" };
    }
  }
  return recovery;
}

export function NucleiModelInstallControl({
  surface,
  install,
  selectedModelId,
  onSelectInstalled,
}: {
  surface: "model-zoo" | "model-panel";
  install: NucleiModelInstallController;
  selectedModelId?: string;
  onSelectInstalled?: (modelId: string) => void;
}): React.JSX.Element | null {
  if (!install.supported) return null;

  const { phase, status, error, cancelPending } = install.state;
  const active = phase === "installing" || phase === "cancelling";
  const ready = !active && install.availability === "ready";
  const recovery = !active && install.availability === "reimport-required";
  const stateAttr = install.unavailableReason
    ? "unavailable"
    : active
      ? phase
      : ready
        ? "ready"
        : phase === "failed" || phase === "cancelled"
          ? phase
          : recovery
            ? "reimport-required"
            : "not-installed";

  const statusText = active
    ? (status ?? NUCLEI_INSTALL_DOWNLOADING_STATUS)
    : ready
      ? "Installed and ready in this study (works offline)"
      : phase === "cancelled"
        ? "Download cancelled. No model was installed in this study."
        : recovery
          ? "Files unavailable in this study"
          : null;

  const downloadSize = formatByteCount(NUCLEI_MODEL_INSTALL.downloadBytes);
  const memoryBudget = formatByteCount(NUCLEI_MODEL_INSTALL.workingBytes);
  const digestShort = `${NUCLEI_MODEL_INSTALL.packageSha256.slice(0, 12)}…`;
  const primaryBtnClass =
    surface === "model-zoo"
      ? "model-library-action-btn model-library-action-btn--primary"
      : "research-primary";
  const secondaryBtnClass =
    surface === "model-zoo" ? "model-library-action-btn" : undefined;

  return (
    <section
      className={
        surface === "model-zoo"
          ? "model-zoo-detail__primary-action"
          : "research-model-records"
      }
      aria-label="Nuclei boundary ONNX installation"
      data-nuclei-install-surface={surface}
      data-nuclei-install-state={stateAttr}
    >
      <p>
        {surface === "model-panel" && <strong>BioImage.IO 2D Nuclei Boundary ONNX · </strong>}
        {downloadSize} download &amp; storage · {memoryBudget} CPU · {NUCLEI_INSTALL_ORIGIN}
      </p>

      {statusText && (
        <p role="status" aria-live="polite" data-nuclei-install-status={stateAttr}>
          {statusText}
        </p>
      )}

      {phase === "failed" && error && !ready && (
        <div
          className={surface === "model-zoo" ? "model-library-error" : "research-derived-notice"}
          role="alert"
          data-nuclei-install-error="true"
        >
          {error} Retry when online, or use Import model package… offline with a local ONNX-only directory.
        </div>
      )}

      {install.unavailableReason ? (
        <>
          <button type="button" className={primaryBtnClass} disabled title={install.unavailableReason}>
            Install for this study
          </button>
          <p className="model-zoo-detail__unavailable-note">{install.unavailableReason}</p>
        </>
      ) : (
        <div className="research-actions">
          {!ready && (
            <button
              type="button"
              className={primaryBtnClass}
              disabled={active || install.busyBlocked}
              onClick={install.onInstall}
            >
              {active
                ? "Installing & verifying…"
                : recovery
                  ? "Reinstall for this study"
                  : "Install for this study"}
            </button>
          )}
          {active && install.canCancel && (
            <button
              type="button"
              className={secondaryBtnClass}
              disabled={Boolean(cancelPending)}
              onClick={install.onCancel}
            >
              Cancel download
            </button>
          )}
          {surface === "model-panel" &&
            ready &&
            install.installedModelId &&
            onSelectInstalled &&
            selectedModelId !== install.installedModelId && (
              <button
                type="button"
                disabled={install.busyBlocked}
                onClick={() => onSelectInstalled(install.installedModelId!)}
              >
                Select installed nuclei model
              </button>
            )}
        </div>
      )}

      <details
        className={
          surface === "model-zoo"
            ? "model-library-details"
            : "research-technical-record"
        }
      >
        <summary>Origin &amp; verification</summary>
        <p>
          Installs adapter <code>0.1.0-publication-20261015-r2</code> (SHA-256{" "}
          <code title={NUCLEI_MODEL_INSTALL.packageSha256}>{digestShort}</code>) into
          the current study only. Does not run inference. Reference check verifies
          CPU ONNX Runtime compatibility only, not biological accuracy.
        </p>
      </details>
    </section>
  );
}
