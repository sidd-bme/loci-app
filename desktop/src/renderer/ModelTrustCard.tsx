import {
  BadgeCheck,
  Beaker,
  ChevronDown,
  CircleHelp,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import React, { useId } from "react";

import type {
  ModelEvidenceStatus,
  ModelManifest,
} from "../shared/foundation-contracts";
import "./ModelTrustCard.css";

interface EvidencePresentation {
  label: string;
  description: string;
  icon: LucideIcon;
}

const EVIDENCE_PRESENTATION: Record<ModelEvidenceStatus, EvidencePresentation> = {
  unvalidated: {
    label: "Unvalidated",
    description: "This exact model artifact has not been evaluated by Loci.",
    icon: CircleHelp,
  },
  experimental: {
    label: "Experimental",
    description:
      "Technical QA or limited benchmark evidence exists, but biological performance is not established.",
    icon: Beaker,
  },
  "validated-for-domain": {
    label: "Validated for declared domain",
    description:
      "The exact model artifact passed locked gates only for the declared domain shown here.",
    icon: BadgeCheck,
  },
  "not-recommended": {
    label: "Not recommended",
    description:
      "This model failed, is unsupported, or is outside the domain in which it may be used reliably.",
    icon: ShieldAlert,
  },
};

interface ModelRolePresentation {
  label: string;
  description: string;
}

function roleForModel(model: Readonly<ModelManifest>): ModelRolePresentation {
  if (model.modelId === "cellpose-sam") {
    return {
      label: "Website-compatible default",
      description:
        "The default for reproducing the audited Cellpose Space behavior on routine uint8 images. This is a compatibility choice, not an accuracy recommendation.",
    };
  }
  if (model.modelId === "cellpose-sam-v2") {
    return {
      label: "Separate checkpoint · not the default",
      description:
        "This exact v2 checkpoint remains a separate, unvalidated option. Select it only intentionally and review every result.",
    };
  }
  if (model.modelId === "loci-classical") {
    return {
      label: "Built-in deterministic baseline",
      description:
        "Always available without a checkpoint. Its experimental status reflects technical QA, not biological validation.",
    };
  }
  return {
    label: "Registered model",
    description:
      "No default role is assigned. Confirm the declared domain and evidence before use.",
  };
}

export interface ModelTrustBadgeProps {
  evidenceStatus: ModelEvidenceStatus;
}

/** Compact, exact evidence state for selectors and result summaries. */
export function ModelTrustBadge({
  evidenceStatus,
}: ModelTrustBadgeProps): React.JSX.Element {
  const presentation = EVIDENCE_PRESENTATION[evidenceStatus];
  const Icon = presentation.icon;
  return (
    <span
      className={`model-trust-badge is-${evidenceStatus}`}
      data-evidence-status={evidenceStatus}
      aria-label={`Evidence state: ${presentation.label}. ${presentation.description}`}
    >
      <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
      <span>{presentation.label}</span>
    </span>
  );
}

export interface ModelTrustCardProps {
  model: Readonly<ModelManifest>;
  className?: string;
}

function artifactLabel(model: Readonly<ModelManifest>): string {
  if (model.artifact.sha256) return model.artifact.sha256;
  return model.artifact.bundled
    ? "Bundled artifact; digest not declared"
    : "No learned checkpoint";
}

/**
 * Standalone model-trust surface. It derives role wording from canonical model
 * identity so callers cannot accidentally promote Cellpose-SAM v2 as default.
 */
export default function ModelTrustCard({
  model,
  className = "",
}: ModelTrustCardProps): React.JSX.Element {
  const titleId = useId();
  const domainId = useId();
  const limitationsId = useId();
  const role = roleForModel(model);
  const evidence = EVIDENCE_PRESENTATION[model.evidenceStatus];

  return (
    <article
      className={`model-trust-card ${className}`.trim()}
      aria-labelledby={titleId}
      data-model-id={model.modelId}
    >
      <header className="model-trust-card__header">
        <div className="model-trust-card__meta">
          <span className="model-trust-card__role">{role.label}</span>
          <ModelTrustBadge evidenceStatus={model.evidenceStatus} />
        </div>
        <h3 id={titleId}>{model.name}</h3>
        <p className="model-trust-card__role-description">{role.description}</p>
      </header>

      <section className="model-trust-card__domain" aria-labelledby={domainId}>
        <h4 id={domainId}>Intended domain</h4>
        <p>{model.intendedDomain.summary}</p>
        <div className="model-trust-card__domain-tags" aria-label="Declared modalities">
          {model.intendedDomain.modalities.map((modality) => (
            <span key={modality}>{modality}</span>
          ))}
        </div>
      </section>

      <details className="model-trust-card__details">
        <summary>
          <span>
            <strong>Validation details and limitations</strong>
            <small>{evidence.description}</small>
          </span>
          <ChevronDown
            className="model-trust-card__disclosure-icon"
            size={15}
            aria-hidden="true"
          />
        </summary>

        <div className="model-trust-card__details-body">
          <section aria-labelledby={limitationsId}>
            <h4 id={limitationsId}>Known limitations</h4>
            <ul>
              {model.knownFailureModes.map((failureMode) => (
                <li key={failureMode}>{failureMode}</li>
              ))}
            </ul>
          </section>

          <section aria-label="Validation provenance">
            <h4>Validation provenance</h4>
            <dl>
              <div>
                <dt>Evidence state</dt>
                <dd>{evidence.label}</dd>
              </div>
              <div>
                <dt>Linked reports</dt>
                <dd>
                  {model.validationReportIds.length
                    ? model.validationReportIds.join(", ")
                    : "None"}
                </dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>{model.runtime.requiredVersion}</dd>
              </div>
              <div>
                <dt>Artifact SHA-256</dt>
                <dd><code>{artifactLabel(model)}</code></dd>
              </div>
            </dl>
          </section>

          <section aria-label="Model rights boundary">
            <h4>Rights boundary</h4>
            <p>
              Checkpoint: {model.rights.checkpointLicense}. Redistribution: {model.rights.redistribution}.
              Commercial use: {model.rights.commercialUse}.
            </p>
          </section>
        </div>
      </details>
    </article>
  );
}
