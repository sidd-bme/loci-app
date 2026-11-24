import type { PanelOpenOptions } from "./panel-open-options";
import type { ResearchDimensions, ResearchSource } from "./research-contracts";

export type StudyNavigatorTarget = {
  projectId: string | null;
  studyGeneration: number;
  documentGeneration: number;
};

export type StudyNavigatorBinding = StudyNavigatorTarget & {
  generation: number;
};

export type StudyNavigatorOpenOptions = PanelOpenOptions;

export type StudyNavigatorSource = Pick<
  ResearchSource,
  "id" | "sha256" | "name" | "browser_location" | "size_bytes" | "source_kind" | "locator_state"
> & {
  metadata: Pick<
    ResearchSource["metadata"],
    "format" | "axes" | "shape" | "dimensions" | "channel_names" | "channel_dtypes" | "sample_semantics"
  > & {
    physical_calibration?: { axes?: string; spacing?: number[]; unit?: string } | null;
  };
};

export type StudyNavigatorSnapshot = {
  studyName: string;
  sources: StudyNavigatorSource[];
  activeSourceId: string | null;
  activeSourceSha256: string | null;
  selectedSourceIds: string[];
  resultCounts?: Record<string, number>;
  reorderDisabled: boolean;
  busy: boolean;
};

export type StudyNavigatorSourceRef = {
  sourceId: string;
  sourceSha256: string;
};

export type StudyNavigatorAction =
  | {
      kind: "activate";
      sourceId: string;
      sourceSha256: string;
      modifier: "none" | "toggle" | "range";
      visibleSourceIds?: string[];
    }
  | {
      kind: "toggle-selection";
      sourceId: string;
      sourceSha256: string;
    }
  | {
      kind: "reorder";
      order: StudyNavigatorSourceRef[];
    };

export type StudyNavigatorState = {
  binding: StudyNavigatorBinding;
  sequence: number;
  rejectedSequence?: number;
  snapshot: StudyNavigatorSnapshot;
};

export type StudyNavigatorLifecycle = {
  binding: StudyNavigatorBinding;
  status: "opening" | "open" | "closed";
  reason?: "dock" | "native-close" | "unavailable" | "display-removed" | "revoked";
};

export const STUDY_NAVIGATOR_IPC = "loci-study-navigator:";

export interface StudyNavigatorApi {
  state(): Promise<StudyNavigatorState>;
  act(binding: StudyNavigatorBinding, action: StudyNavigatorAction): Promise<void>;
  dock(binding: StudyNavigatorBinding): Promise<void>;
  onState(listener: (state: StudyNavigatorState) => void): () => void;
}

export interface StudyNavigatorOwnerApi {
  open(
    target: StudyNavigatorTarget,
    snapshot: StudyNavigatorSnapshot,
    options?: StudyNavigatorOpenOptions,
  ): Promise<StudyNavigatorBinding>;
  publish(
    binding: StudyNavigatorBinding,
    snapshot: StudyNavigatorSnapshot,
    rejected?: boolean,
  ): Promise<void>;
  focus(binding: StudyNavigatorBinding): Promise<void>;
  dock(binding: StudyNavigatorBinding): Promise<void>;
  revoke(binding: StudyNavigatorBinding): Promise<void>;
  onLifecycle(listener: (value: StudyNavigatorLifecycle) => void): () => void;
  onAction(listener: (value: { binding: StudyNavigatorBinding; action: StudyNavigatorAction }) => void): () => void;
}

export function sameStudyNavigatorTarget(
  a: StudyNavigatorTarget | null,
  b: StudyNavigatorTarget | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.projectId === b.projectId &&
    a.studyGeneration === b.studyGeneration &&
    a.documentGeneration === b.documentGeneration
  );
}

const dimensionAxes = ["t", "c", "z", "y", "x", "s"] as const;

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function sourceMetadataAxes(metadata: ResearchSource["metadata"]): string | undefined {
  const axes = metadata.axes ?? metadata.geometry?.axes;
  return typeof axes === "string" && /^[a-z]+$/i.test(axes) && new Set(axes.toLowerCase()).size === axes.length
    ? axes : undefined;
}

/** Read labeled dimensions without assigning meanings to unlabeled legacy shapes. */
export function sourceMetadataDimensions(metadata: ResearchSource["metadata"]): Partial<ResearchDimensions> {
  const axes = sourceMetadataAxes(metadata)?.toLowerCase();
  const { dimensions, shape } = metadata;
  const shapeAxisOrder = Array.isArray(shape) && shape.length === axes?.length && shape.every(validSize)
    ? axes : undefined;
  const known: Partial<ResearchDimensions> = {};
  for (const axis of dimensionAxes) {
    const declared = dimensions?.[axis] ?? (shapeAxisOrder ? shape?.[shapeAxisOrder.indexOf(axis)] : undefined);
    if (validSize(declared)) known[axis] = declared;
  }
  return known;
}

export function sourceSampleLayout(metadata: ResearchSource["metadata"], samples: number | undefined) {
  const semantics = typeof metadata.sample_semantics === "string" ? metadata.sample_semantics.toUpperCase() : undefined;
  if (semantics === "RGB" || semantics === "RGBA") {
    const expected = semantics === "RGB" ? 3 : 4;
    return { compact: semantics, description: samples === expected ? `${samples} ${semantics} components` : `${semantics} components` };
  }
  return samples !== undefined && samples > 1
    ? { compact: `${samples}S`, description: `${samples} samples per pixel` }
    : null;
}

/** Trim a ResearchSource to renderer-safe fields needed by the detached Images navigator. */
export function trimStudyNavigatorSource(source: ResearchSource): StudyNavigatorSource {
  const metadata = source.metadata ?? {};
  const axes = sourceMetadataAxes(metadata);
  const { dimensions, shape } = metadata;
  const calibration = metadata.physical_calibration;
  const calibrationAxes = calibration && "axes" in calibration && typeof calibration.axes === "string"
    ? calibration.axes : undefined;
  const browserLocation = source.browser_location
    ? {
        relative_path: source.browser_location.relative_path,
        root: source.browser_location.root
          ? { id: source.browser_location.root.id, name: source.browser_location.root.name }
          : null,
      }
    : undefined;
  return {
    id: source.id,
    sha256: source.sha256,
    name: source.name,
    ...(browserLocation ? { browser_location: browserLocation } : {}),
    ...(typeof source.size_bytes === "number" && Number.isSafeInteger(source.size_bytes) && source.size_bytes >= 0
      ? { size_bytes: source.size_bytes }
      : {}),
    ...(source.source_kind ? { source_kind: source.source_kind } : {}),
    ...(source.locator_state ? { locator_state: source.locator_state } : {}),
    metadata: {
      ...(metadata.format ? { format: metadata.format } : {}),
      ...(axes ? { axes } : {}),
      ...(Array.isArray(shape) && shape.length === axes?.length && shape.every(validSize) ? { shape: [...shape] } : {}),
      ...(dimensions ? { dimensions: {
        t: dimensions.t, c: dimensions.c, z: dimensions.z, y: dimensions.y, x: dimensions.x,
        ...(dimensions.s !== undefined ? { s: dimensions.s } : {}),
      } } : {}),
      ...(Array.isArray(metadata.channel_names) ? { channel_names: [...metadata.channel_names] } : {}),
      ...(Array.isArray(metadata.channel_dtypes) ? { channel_dtypes: [...metadata.channel_dtypes] } : {}),
      ...(metadata.sample_semantics ? { sample_semantics: metadata.sample_semantics } : {}),
      ...(calibration
        ? {
            physical_calibration: {
              ...(calibrationAxes ? { axes: calibrationAxes } : {}),
              ...(Array.isArray(calibration.spacing) ? { spacing: [...calibration.spacing] } : {}),
              ...(calibration.unit ? { unit: calibration.unit } : {}),
            },
          }
        : {}),
    },
  };
}

declare global {
  interface Window {
    lociStudyNavigator?: StudyNavigatorApi;
    lociStudyNavigatorOwner?: StudyNavigatorOwnerApi;
  }
}
