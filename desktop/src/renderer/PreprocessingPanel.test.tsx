// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDimensions,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import {
  PreprocessingPanel,
  PreprocessingScopeControl,
} from "./PreprocessingPanel";

afterEach(cleanup);

const baseDimensions: ResearchDimensions = { t: 1, c: 1, z: 1, y: 64, x: 64 };
const baseSelection: ResearchSelection = {
  x: 0,
  y: 0,
  width: 64,
  height: 64,
  t: 0,
  c: 0,
  z: 0,
  level: 0,
};

function makeSource(overrides?: Partial<ResearchSource>): ResearchSource {
  return {
    id: "a".repeat(32),
    name: "Specimen.tif",
    sha256: "b".repeat(64),
    source_kind: "native",
    metadata: {
      dimensions: baseDimensions,
      levels: [
        {
          index: 0,
          dimensions: baseDimensions,
          calibration: null,
        },
      ],
    },
    ...overrides,
  };
}

function makeRecipe(steps: Array<Record<string, unknown>> = []): ResearchRecipe {
  return {
    steps,
    segmentation: {
      method: "components",
      threshold: 100,
      polarity: "bright",
      min_size: 1,
      exclude_border: false,
    },
    measurement_channels: [0],
    gates: [],
    working_bytes: 512 * 1024 ** 2,
  };
}

function PanelHarness({
  initialSteps = [],
  source = makeSource(),
  selection = baseSelection,
  busy = false,
  externalConfigurationValid = true,
  numberKey = "k0",
  onPreview,
  onRecipeChange,
}: {
  initialSteps?: Array<Record<string, unknown>>;
  source?: ResearchSource | null;
  selection?: ResearchSelection;
  busy?: boolean;
  externalConfigurationValid?: boolean;
  numberKey?: string;
  onPreview?: (recipe: ResearchRecipe) => void;
  onRecipeChange?: (recipe: ResearchRecipe) => void;
}) {
  const [recipe, setRecipeState] = useState<ResearchRecipe>(() =>
    makeRecipe(initialSteps),
  );
  const [panelValid, setPanelValid] = useState(true);
  const setRecipe: typeof setRecipeState = (updater) => {
    setRecipeState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      onRecipeChange?.(next);
      return next;
    });
  };
  return (
    <PreprocessingPanel
      source={source}
      selection={selection}
      recipe={recipe}
      setRecipe={setRecipe}
      onPreview={() => onPreview?.(recipe)}
      busy={busy}
      numberKey={numberKey}
      onNumberValidity={setPanelValid}
      configurationValid={externalConfigurationValid && panelValid}
    />
  );
}

describe("PreprocessingScopeControl", () => {
  it("shows compact whole image scope and omits Z/T for single-plane single-timepoint images", () => {
    render(
      <PreprocessingScopeControl
        selection={baseSelection}
        dimensions={baseDimensions}
        drawing={false}
        onSelectWholeImage={vi.fn()}
        onStartDrawRegion={vi.fn()}
        onCancelDrawRegion={vi.fn()}
      />,
    );

    const whole = screen.getByRole("button", { name: "Whole image" });
    const region = screen.getByRole("button", { name: "Region" });
    expect(whole).toHaveAttribute("aria-pressed", "true");
    expect(region).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("64 × 64 px · 1 plane")).toBeInTheDocument();
    expect(screen.queryByText(/\bZ\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bT\b/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Redraw region" })).not.toBeInTheDocument();
  });

  it("shows Z and T metadata only when the source has multiple planes or timepoints", () => {
    const { rerender } = render(
      <PreprocessingScopeControl
        selection={{ ...baseSelection, z: 2, t: 1 }}
        dimensions={{ ...baseDimensions, z: 5, t: 4 }}
        drawing={false}
        onSelectWholeImage={vi.fn()}
        onStartDrawRegion={vi.fn()}
        onCancelDrawRegion={vi.fn()}
      />,
    );

    expect(screen.getByText("64 × 64 px · 1 plane")).toBeInTheDocument();
    expect(screen.getByText("Z 3/5 · T 2/4")).toBeInTheDocument();

    rerender(
      <PreprocessingScopeControl
        selection={{ ...baseSelection, z: 1, z_stop: 4, t: 0 }}
        dimensions={{ ...baseDimensions, z: 5, t: 1 }}
        drawing={false}
        onSelectWholeImage={vi.fn()}
        onStartDrawRegion={vi.fn()}
        onCancelDrawRegion={vi.fn()}
      />,
    );

    expect(screen.getByText("64 × 64 px · 3 planes")).toBeInTheDocument();
    expect(screen.getByText("Z 2–4/5")).toBeInTheDocument();
  });

  it("handles contextual region drawing, Escape/Cancel without mutating scope, and Redraw for active regions", () => {
    const onSelectWholeImage = vi.fn();
    const onStartDrawRegion = vi.fn();
    const onCancelDrawRegion = vi.fn();

    const { rerender } = render(
      <PreprocessingScopeControl
        selection={baseSelection}
        dimensions={baseDimensions}
        drawing={false}
        onSelectWholeImage={onSelectWholeImage}
        onStartDrawRegion={onStartDrawRegion}
        onCancelDrawRegion={onCancelDrawRegion}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Region" }));
    expect(onStartDrawRegion).toHaveBeenCalledTimes(1);

    // While drawing from whole image, actual scope remains Whole image until a drag completes.
    rerender(
      <PreprocessingScopeControl
        selection={baseSelection}
        dimensions={baseDimensions}
        drawing={true}
        onSelectWholeImage={onSelectWholeImage}
        onStartDrawRegion={onStartDrawRegion}
        onCancelDrawRegion={onCancelDrawRegion}
      />,
    );

    expect(screen.getByRole("button", { name: "Whole image" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Region" })).toHaveAttribute("data-drawing", "true");
    expect(screen.getByText("Drag a rectangle on the image. Right-drag still pans.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel drawing" }));
    expect(onCancelDrawRegion).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("region", { name: "Analysis scope" }), { key: "Escape" });
    expect(onCancelDrawRegion).toHaveBeenCalledTimes(2);

    // Once a crop is applied, Region becomes active with coordinates and a contextual Redraw action.
    rerender(
      <PreprocessingScopeControl
        selection={{ ...baseSelection, x: 8, y: 12, width: 32, height: 24 }}
        dimensions={baseDimensions}
        drawing={false}
        onSelectWholeImage={onSelectWholeImage}
        onStartDrawRegion={onStartDrawRegion}
        onCancelDrawRegion={onCancelDrawRegion}
      />,
    );

    expect(screen.getByRole("button", { name: "Whole image" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("32 × 24 px · 1 plane · X 8, Y 12")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Redraw region" }));
    expect(onStartDrawRegion).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Whole image" }));
    expect(onSelectWholeImage).toHaveBeenCalledTimes(1);
  });
});

describe("PreprocessingPanel", () => {
  it("renders a restrained empty pipeline, grouped 6-op chooser, keyboard navigation, and Escape focus return", () => {
    render(<PanelHarness />);

    expect(screen.queryByRole("heading", { name: /^Preprocess$/i })).not.toBeInTheDocument();
    expect(screen.getByText("Processing pipeline")).toBeInTheDocument();
    expect(screen.getByText("0 steps")).toBeInTheDocument();
    expect(screen.getByText("No steps configured. Steps run in sequence.")).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Add processing step" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const smoothing = screen.getByRole("group", { name: "Smoothing" });
    const bgIntensity = screen.getByRole("group", { name: "Background & intensity" });
    const morphology = screen.getByRole("group", { name: "Morphology" });

    expect(within(smoothing).getByRole("button", { name: "Gaussian blur" })).toBeInTheDocument();
    expect(within(smoothing).getByRole("button", { name: "Median filter" })).toBeInTheDocument();
    expect(within(bgIntensity).getByRole("button", { name: "Background subtraction" })).toBeInTheDocument();
    expect(within(bgIntensity).getByRole("button", { name: "Subtract constant" })).toBeInTheDocument();
    expect(within(morphology).getByRole("button", { name: "Morphological opening" })).toBeInTheDocument();
    expect(within(morphology).getByRole("button", { name: "Morphological closing" })).toBeInTheDocument();

    // Arrow key navigation & Escape focus recovery
    const gaussianBtn = within(smoothing).getByRole("button", { name: "Gaussian blur" });
    gaussianBtn.focus();
    fireEvent.keyDown(gaussianBtn, { key: "ArrowDown" });
    expect(within(smoothing).getByRole("button", { name: "Median filter" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(within(morphology).getByRole("button", { name: "Morphological closing" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(gaussianBtn).toHaveFocus();
    fireEvent.keyDown(gaussianBtn, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("shows verified geometry units only when the source supports that calibration", () => {
    // 1. Explicitly uncalibrated native level -> px (never µm)
    const { rerender } = render(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 1.5 }]}
        source={makeSource()}
      />,
    );
    expect(screen.getByText("px")).toBeInTheDocument();
    expect(screen.queryByText("µm")).not.toBeInTheDocument();

    // 2. Calibrated micrometre native level -> µm
    const calibratedUmSource = makeSource({
      metadata: {
        dimensions: baseDimensions,
        levels: [
          {
            index: 0,
            dimensions: baseDimensions,
            calibration: { axes: "YX", spacing: [0.5, 0.5], unit: "um" },
          },
        ],
      },
    });
    rerender(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 1.5 }]}
        source={calibratedUmSource}
      />,
    );
    expect(screen.getByText("µm")).toBeInTheDocument();

    // 3. Incomplete/missing calibration -> unit unverified (never fabricated µm)
    const unverifiedSource = makeSource({
      metadata: {
        dimensions: baseDimensions,
        levels: [{ index: 0, dimensions: baseDimensions }],
      },
    });
    rerender(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 1.5 }]}
        source={unverifiedSource}
      />,
    );
    expect(screen.getByText("unit unverified")).toBeInTheDocument();
    expect(screen.queryByText("µm")).not.toBeInTheDocument();

    // 4. Calibrated medical mm -> mm
    const medicalSource = makeSource({
      source_kind: "medical",
      metadata: {
        dimensions: baseDimensions,
        geometry: {
          axes: "YX",
          unit: "mm",
          affine: [
            [0.25, 0, 0, 0],
            [0, 0.25, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
          ],
        },
      },
    });
    rerender(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 1.5 }]}
        source={medicalSource}
      />,
    );
    expect(screen.getByText("mm")).toBeInTheDocument();

    // 5. Subtract constant reflects actual preceding intensity basis (never misleading 'raw' on derived intermediates)
    cleanup();
    render(
      <PanelHarness
        initialSteps={[
          { op: "gaussian", sigma: 1.5 },
          { op: "subtract_constant", value: 100 },
        ]}
        source={calibratedUmSource}
      />,
    );
    // Activate Step 2 (Subtract constant after Gaussian blur) -> step 1 intensity
    fireEvent.click(screen.getByRole("button", { name: /02 Subtract constant/i }));
    expect(screen.getByText("step 1 intensity")).toBeInTheDocument();
    expect(screen.queryByText("raw")).not.toBeInTheDocument();

    // Move Subtract constant up to Step 1 -> source intensity
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect(screen.getByText("source intensity")).toBeInTheDocument();
  });

  it("preserves invalid drafts and blocked preview across collapse, switching steps, reorder, and clears on removal or Escape", () => {
    const onPreview = vi.fn();
    render(<PanelHarness onPreview={onPreview} />);

    // Add step 1: Gaussian blur
    fireEvent.click(screen.getByRole("button", { name: "Add processing step" }));
    fireEvent.click(screen.getByRole("button", { name: "Gaussian blur" }));
    const step1Input = screen.getByLabelText("Step 1 sigma");
    expect(step1Input).toHaveFocus();

    // Enter invalid draft (-2) on step 1
    fireEvent.change(step1Input, { target: { value: "-2" } });
    expect(step1Input).toHaveValue("-2");
    expect(step1Input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/0 to 1000000/);
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();

    // Collapse step 1 -> streamlined single-line row hides duplicate actions, keeps Invalid badge & blocks preview
    fireEvent.click(screen.getByRole("button", { name: /Gaussian blur/i }));
    expect(screen.queryByLabelText("Step 1 sigma")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove gaussian" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move step 1 down" })).not.toBeInTheDocument();
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();

    // Add step 2: Subtract constant (valid) -> step 2 opens, step 1 stays collapsed & invalid
    fireEvent.click(screen.getByRole("button", { name: "Add processing step" }));
    fireEvent.click(screen.getByRole("button", { name: "Subtract constant" }));
    fireEvent.change(screen.getByLabelText("Step 2 value"), { target: { value: "25" } });
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();

    // Move Step 2 (Subtract constant) UP past invalid Step 1 -> invalid draft travels WITH Gaussian blur to Step 2!
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    const itemsAfterMove = screen.getAllByRole("listitem");
    expect(itemsAfterMove[0]).toHaveTextContent("01");
    expect(itemsAfterMove[0]).toHaveTextContent("Subtract constant");
    expect(itemsAfterMove[1]).toHaveTextContent("02");
    expect(itemsAfterMove[1]).toHaveTextContent("Gaussian blur");
    expect(within(itemsAfterMove[1]).getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();
    // Moving Step 2 to the top boundary disabled Move up, so focus stays on its toggle button
    expect(within(itemsAfterMove[0]).getByRole("button", { name: /01 Subtract constant/i })).toHaveFocus();

    // Expand step 2 (moved Gaussian blur) -> exact invalid text "-2" & alert are preserved
    fireEvent.click(within(itemsAfterMove[1]).getByRole("button", { name: /Gaussian blur/i }));
    const movedInput = screen.getByLabelText("Step 2 sigma");
    expect(movedInput).toHaveValue("-2");
    expect(movedInput).toHaveAttribute("aria-invalid", "true");

    // Press Escape -> reverts to last applied value (1) and re-enables Preview
    fireEvent.keyDown(movedInput, { key: "Escape" });
    expect(movedInput).toHaveValue("1");
    expect(movedInput).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeEnabled();

    // Make step 2 invalid again, collapse it, re-expand to remove -> validity recovers & focus restores to neighbor
    fireEvent.change(movedInput, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();
    fireEvent.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: /Gaussian blur/i }));
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();
    fireEvent.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: /Gaussian blur/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove gaussian" }));

    expect(screen.getByRole("button", { name: /01 Subtract constant/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls[0][0].steps).toEqual([
      { op: "subtract_constant", value: 25 },
    ]);
  });

  it("supports duplicate op editing, manual reordering, focus recovery after removal, and submits exact ordered steps without extra keys", () => {
    const onPreview = vi.fn();
    render(<PanelHarness onPreview={onPreview} />);

    // Add first Gaussian blur and set sigma = 1.25
    fireEvent.click(screen.getByRole("button", { name: "Add processing step" }));
    fireEvent.click(screen.getByRole("button", { name: "Gaussian blur" }));
    fireEvent.change(screen.getByLabelText("Step 1 sigma"), { target: { value: "1.25" } });

    // Add second Gaussian blur (duplicate op!) and set sigma = 4.5
    fireEvent.click(screen.getByRole("button", { name: "Add processing step" }));
    fireEvent.click(screen.getByRole("button", { name: "Gaussian blur" }));
    fireEvent.change(screen.getByLabelText("Step 2 sigma"), { target: { value: "4.5" } });

    // Move currently expanded Step 2 (Gaussian 4.5) up to Step 1
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));

    // Add Morphological opening and set radius = 2, then move it up to Step 2
    fireEvent.click(screen.getByRole("button", { name: "Add processing step" }));
    fireEvent.click(screen.getByRole("button", { name: "Morphological opening" }));
    fireEvent.change(screen.getByLabelText("Step 3 radius"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Move step 3 up" }));

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("01");
    expect(rows[0]).toHaveTextContent("Gaussian blur");
    expect(rows[0]).toHaveTextContent("σ 4.5 px");
    expect(rows[1]).toHaveTextContent("02");
    expect(rows[1]).toHaveTextContent("Morphological opening");
    expect(rows[2]).toHaveTextContent("03");
    expect(rows[2]).toHaveTextContent("Gaussian blur");
    expect(rows[2]).toHaveTextContent("σ 1.25 px");

    // Edit the first duplicate Gaussian blur independently
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Gaussian blur/i }));
    fireEvent.change(screen.getByLabelText("Step 1 sigma"), { target: { value: "3.75" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    const submittedSteps = onPreview.mock.calls[0][0].steps;
    expect(submittedSteps).toEqual([
      { op: "gaussian", sigma: 3.75 },
      { op: "opening", radius: 2 },
      { op: "gaussian", sigma: 1.25 },
    ]);
    // Verify strict schema purity: no internal UI id key leaks into recipe.steps
    for (const step of submittedSteps) {
      expect(Object.keys(step).sort()).toEqual(
        step.op === "opening" ? ["op", "radius"] : ["op", "sigma"],
      );
    }

    // Removing Step 1 restores focus to next neighboring row (Morphological opening, now 01)
    fireEvent.click(screen.getByRole("button", { name: "Remove gaussian" }));
    expect(screen.getByRole("button", { name: /01 Morphological opening/i })).toHaveFocus();

    // Removing remaining two steps restores focus to Add processing step when pipeline becomes empty
    fireEvent.click(screen.getByRole("button", { name: /01 Morphological opening/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove opening" }));
    expect(screen.getByRole("button", { name: /01 Gaussian blur/i })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /01 Gaussian blur/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove gaussian" }));
    expect(screen.getByRole("button", { name: "Add processing step" })).toHaveFocus();
  });

  it("surfaces clip_negative once in expanded rows, preserves serialized identity on undo, and supports duplicate ops with distinct clip flags", () => {
    const onPreview = vi.fn();
    render(
      <PanelHarness
        initialSteps={[
          { op: "subtract_background", sigma: 2.5, clip_negative: false },
          { op: "subtract_background", sigma: 6 },
        ]}
        onPreview={onPreview}
      />,
    );

    // Step 1 starts expanded with explicit clip_negative: false preserved until toggled
    const clipBoxes = screen.getAllByRole("checkbox", { name: "Clip negative values to zero" });
    expect(clipBoxes).toHaveLength(1);
    expect(clipBoxes[0]).not.toBeChecked();

    // Preview unchanged -> preserves explicit false on step 1 and implicit omitted key on step 2
    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview.mock.calls[0][0].steps).toEqual([
      { op: "subtract_background", sigma: 2.5, clip_negative: false },
      { op: "subtract_background", sigma: 6 },
    ]);
    expect("clip_negative" in onPreview.mock.calls[0][0].steps[0]).toBe(true);
    expect("clip_negative" in onPreview.mock.calls[0][0].steps[1]).toBe(false);

    // Toggle step 1 on, then off -> restores original explicit clip_negative: false record
    fireEvent.click(clipBoxes[0]);
    expect(clipBoxes[0]).toBeChecked();
    fireEvent.click(clipBoxes[0]);
    expect(clipBoxes[0]).not.toBeChecked();

    // Expand step 2 (duplicate op!), enable clip_negative, leave step 1 off -> collapsed summary shows ≥0 when collapsed
    fireEvent.click(screen.getByRole("button", { name: /02 Background subtraction/i }));
    const step2Clip = screen.getByRole("checkbox", { name: "Clip negative values to zero" });
    expect(step2Clip).not.toBeChecked();
    fireEvent.click(step2Clip);
    expect(step2Clip).toBeChecked();

    // Collapse step 2 -> shows clip indicator on collapsed summary
    fireEvent.click(screen.getByRole("button", { name: /02 Background subtraction/i }));
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("σ 6 px · ≥0");

    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview.mock.calls[1][0].steps).toEqual([
      { op: "subtract_background", sigma: 2.5, clip_negative: false },
      { op: "subtract_background", sigma: 6, clip_negative: true },
    ]);

    // Undo clip on step 2 -> restores original omitted-key record (implicit false)
    fireEvent.click(screen.getByRole("button", { name: /02 Background subtraction/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clip negative values to zero" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview.mock.calls[2][0].steps).toEqual([
      { op: "subtract_background", sigma: 2.5, clip_negative: false },
      { op: "subtract_background", sigma: 6 },
    ]);
    expect("clip_negative" in onPreview.mock.calls[2][0].steps[1]).toBe(false);
  });

  it("clears collapsed invalid drafts on numberKey restore and keeps flatfield guidance plus clip_negative toggle", () => {
    const onPreview = vi.fn();
    const { rerender } = render(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 2 }]}
        numberKey="k0"
      />,
    );
    // Gaussian blur does not support clip_negative
    expect(screen.queryByRole("checkbox", { name: "Clip negative values to zero" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Step 1 sigma"), { target: { value: "1.5e" } });
    fireEvent.click(screen.getByRole("button", { name: /Gaussian blur/i }));
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();

    // Restoring applied numbers increments numberKey -> clears collapsed invalid draft
    rerender(
      <PanelHarness
        initialSteps={[{ op: "gaussian", sigma: 2 }]}
        numberKey="k1"
      />,
    );
    expect(screen.queryByText("Invalid")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeEnabled();

    // External flatfield step keeps its reference guidance and exposes clip_negative toggle
    cleanup();
    render(
      <PanelHarness
        initialSteps={[{ op: "flatfield", clip_negative: true }]}
        onPreview={onPreview}
      />,
    );
    expect(screen.getByText("Flat-field correction")).toBeInTheDocument();
    expect(screen.getByText(/Flat-field and dark-field references/)).toBeInTheDocument();
    const flatClip = screen.getByRole("checkbox", { name: "Clip negative values to zero" });
    expect(flatClip).toBeChecked();
    fireEvent.click(flatClip);
    expect(flatClip).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview selected crop" }));
    expect(onPreview.mock.calls[0][0].steps).toEqual([
      { op: "flatfield", clip_negative: false },
    ]);
    expect(screen.getByRole("button", { name: "Remove flatfield" })).toBeInTheDocument();
  });
});
