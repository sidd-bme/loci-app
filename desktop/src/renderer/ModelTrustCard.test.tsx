// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelEvidenceStatus } from "../shared/foundation-contracts";
import { MODEL_EVIDENCE_REGISTRY } from "../shared/model-registry";
import ModelTrustCard, { ModelTrustBadge } from "./ModelTrustCard";

afterEach(cleanup);

function canonicalModel(modelId: string) {
  const model = MODEL_EVIDENCE_REGISTRY.getModel(modelId);
  if (!model) throw new Error(`Missing canonical model ${modelId}`);
  return model;
}

describe("ModelTrustBadge", () => {
  it("presents every evidence state with its exact accessible label", () => {
    const states: Array<[ModelEvidenceStatus, string]> = [
      ["unvalidated", "Unvalidated"],
      ["experimental", "Experimental"],
      ["validated-for-domain", "Validated for declared domain"],
      ["not-recommended", "Not recommended"],
    ];
    render(
      <div>
        {states.map(([status]) => (
          <ModelTrustBadge evidenceStatus={status} key={status} />
        ))}
      </div>,
    );

    states.forEach(([status, label]) => {
      const badge = screen.getByText(label).closest("[data-evidence-status]");
      expect(badge).toHaveAttribute("data-evidence-status", status);
      expect(badge).toHaveAccessibleName(new RegExp(`^Evidence state: ${label}\\.`));
    });
  });
});

describe("ModelTrustCard", () => {
  it("describes original cpsam as the website-compatible default, not an accuracy claim", () => {
    const model = canonicalModel("cellpose-sam");
    render(<ModelTrustCard model={model} />);
    const card = screen.getByRole("article", { name: model.name });

    expect(within(card).getByText("Website-compatible default")).toBeVisible();
    expect(within(card).getByLabelText(/^Evidence state: Experimental\./)).toBeVisible();
    expect(card).toHaveTextContent("This is a compatibility choice, not an accuracy recommendation");
    expect(within(card).getByRole("heading", { name: "Intended domain" })).toBeVisible();
    expect(card).toHaveTextContent(model.intendedDomain.summary);
  });

  it("keeps cpsam_v2 explicitly unvalidated and never gives it a recommended label", () => {
    const model = canonicalModel("cellpose-sam-v2");
    render(<ModelTrustCard model={model} />);
    const card = screen.getByRole("article", { name: model.name });

    expect(within(card).getByText("Separate checkpoint · not the default")).toBeVisible();
    expect(within(card).getByLabelText(/^Evidence state: Unvalidated\./)).toBeVisible();
    expect(within(card).queryByText(/^Recommended(?: model)?$/i)).not.toBeInTheDocument();
    expect(within(card).queryByText(/recommended default/i)).not.toBeInTheDocument();
    expect(card).toHaveAttribute("data-model-id", "cellpose-sam-v2");
  });

  it("uses a native accessible disclosure for limitations and exact provenance", () => {
    const model = canonicalModel("cellpose-sam");
    render(<ModelTrustCard model={model} />);
    const card = screen.getByRole("article", { name: model.name });
    const summary = within(card).getByText("Validation details and limitations").closest("summary");
    const details = summary?.closest("details");

    expect(summary).not.toBeNull();
    expect(summary).toHaveAccessibleName(/Validation details and limitations/i);
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary as HTMLElement);
    expect(details).toHaveAttribute("open");
    expect(within(card).getByRole("heading", { name: "Known limitations" })).toBeVisible();
    expect(card).toHaveTextContent(model.knownFailureModes[0]);
    expect(card).toHaveTextContent(model.validationReportIds[0]);
    expect(card).toHaveTextContent(model.artifact.sha256 ?? "");
    expect(card).toHaveTextContent("Commercial use: restricted");
  });

  it("labels the built-in classical profile as an experimental deterministic baseline", () => {
    const model = canonicalModel("loci-classical");
    render(<ModelTrustCard model={model} />);
    const card = screen.getByRole("article", { name: model.name });

    expect(within(card).getByText("Built-in deterministic baseline")).toBeVisible();
    expect(within(card).getByLabelText(/^Evidence state: Experimental\./)).toBeVisible();
    expect(card).toHaveTextContent("No learned checkpoint");
  });
});
