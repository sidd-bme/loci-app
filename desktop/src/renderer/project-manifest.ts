import type { ImportedImage, SourceMetadata, ViewerDisplaySettings } from "../shared/contracts";
import {
  PROJECT_MANIFEST_SCHEMA,
  type ProjectManifestV1,
  type ProjectReviewRecord,
  type ProjectSourceReference,
  type SourceFingerprint,
  type WorkspaceKind,
} from "../shared/foundation-contracts";
import { describeAndRecommendWorkspace, recommendWorkspace } from "../shared/source-routing";

const PENDING_FINGERPRINT: SourceFingerprint = {
  status: "pending",
  algorithm: "sha256",
  sha256: null,
  verifiedAt: null,
};

export interface ProjectManifestState {
  sources: ImportedImage[];
  displayBySourceId: Record<string, ViewerDisplaySettings>;
  workspaceOverrideBySourceId: Record<string, WorkspaceKind>;
  reviews?: ProjectReviewRecord[];
  defaultDisplay: ViewerDisplaySettings;
}

export interface ProjectManifestIdentity {
  projectId: string;
  title: string;
  createdAt: string;
}

function hasInspectedMetadata(source: ImportedImage): source is ImportedImage & SourceMetadata {
  return Number.isSafeInteger(source.width) &&
    Number.isSafeInteger(source.height) &&
    Number.isSafeInteger(source.channels) &&
    Number.isSafeInteger(source.pageCount) &&
    typeof source.dtype === "string" &&
    Boolean(source.dtype) &&
    typeof source.format === "string" &&
    Boolean(source.format);
}

function sourceFingerprint(
  sourceId: string,
  previousSourceById: ReadonlyMap<string, ProjectSourceReference>,
): SourceFingerprint {
  return previousSourceById.get(sourceId)?.fingerprint ??
    { ...PENDING_FINGERPRINT };
}

function projectSource(
  source: ImportedImage,
  state: ProjectManifestState,
  previousSourceById: ReadonlyMap<string, ProjectSourceReference>,
): ProjectSourceReference {
  const fingerprint = sourceFingerprint(source.sourceId, previousSourceById);
  const base = {
    sourceId: source.sourceId,
    displayName: source.name,
    relativeLabel: source.relativePath,
    fingerprint,
  };
  if (source.restoredDescriptor) {
    const descriptor = {
      ...structuredClone(source.restoredDescriptor),
      displayName: source.name,
      relativeLabel: source.relativePath,
      fingerprint,
    };
    return {
      ...base,
      inspectionStatus: "ready",
      descriptor,
      workspace: recommendWorkspace(
        descriptor,
        state.workspaceOverrideBySourceId[source.sourceId] ?? null,
      ),
      inspectionFailure: null,
    };
  }
  if (!hasInspectedMetadata(source)) {
    const existing = previousSourceById.get(source.sourceId);
    if (existing?.inspectionStatus === "ready") {
      return {
        ...existing,
        displayName: source.name,
        relativeLabel: source.relativePath,
        fingerprint,
        descriptor: {
          ...existing.descriptor,
          displayName: source.name,
          relativeLabel: source.relativePath,
          fingerprint,
        },
      };
    }
    return {
      ...base,
      inspectionStatus: "pending",
      descriptor: null,
      workspace: null,
      inspectionFailure: null,
    };
  }
  const { descriptor, recommendation } = describeAndRecommendWorkspace(source, {
    fingerprint,
    userOverride: state.workspaceOverrideBySourceId[source.sourceId] ?? null,
  });
  return {
    ...base,
    inspectionStatus: "ready",
    descriptor,
    workspace: recommendation,
    inspectionFailure: null,
  };
}

export function createProjectManifest(
  identity: ProjectManifestIdentity,
  state: ProjectManifestState,
  options: {
    appVersion: string;
    now: string;
    previous?: ProjectManifestV1 | null;
  },
): ProjectManifestV1 {
  const previous = options.previous ?? null;
  const sourceIds = new Set(state.sources.map(({ sourceId }) => sourceId));
  const previousSourceById = new Map(
    previous?.sources.map((source) => [source.sourceId, source] as const) ?? [],
  );
  const previousDisplayBySourceId = new Map(
    previous?.displayRecipes.map((recipe) => [recipe.sourceId, recipe] as const) ?? [],
  );
  const retainedJobs = previous?.jobs.filter((job) =>
    job.spec.inputs.every(({ sourceId }) => sourceIds.has(sourceId)) &&
    (job.result === null || job.result.sourceFingerprints.every(({ sourceId }) => sourceIds.has(sourceId)))) ?? [];
  const retainedResultManifestIds = new Set(
    retainedJobs.flatMap((job) => job.result ? [job.result.resultManifestId] : []),
  );
  const retainedModelResults = previous?.modelResults.filter(({ sourceId, resultManifestId }) =>
    sourceIds.has(sourceId) && retainedResultManifestIds.has(resultManifestId)) ?? [];
  const retainedResultIds = new Set(retainedModelResults.map(({ resultId }) => resultId));
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA,
    projectId: identity.projectId,
    title: identity.title,
    createdAt: identity.createdAt,
    updatedAt: options.now,
    appVersion: options.appVersion,
    sources: state.sources.map((source) => projectSource(source, state, previousSourceById)),
    displayRecipes: state.sources.map((source) => ({
      recipeId: `display:${source.sourceId}`,
      sourceId: source.sourceId,
      settings: structuredClone(state.displayBySourceId[source.sourceId] ?? state.defaultDisplay),
      channelSettings: previousDisplayBySourceId.get(source.sourceId)?.channelSettings ?? [],
    })),
    annotations: previous?.annotations.filter(({ sourceId }) => sourceIds.has(sourceId)) ?? [],
    corrections: previous?.corrections.filter(({ sourceId, resultId }) =>
      sourceIds.has(sourceId) && retainedResultIds.has(resultId)) ?? [],
    modelResults: retainedModelResults,
    reviews: (state.reviews ?? previous?.reviews ?? []).filter(({ sourceId }) =>
      sourceIds.has(sourceId)),
    jobs: retainedJobs,
    migrations: previous?.migrations ?? [],
  };
}

export function restoredDisplayRecipes(
  manifest: ProjectManifestV1,
): Record<string, ViewerDisplaySettings> {
  return Object.fromEntries(
    manifest.displayRecipes.map((recipe) => [recipe.sourceId, structuredClone(recipe.settings)]),
  );
}

export function restoredWorkspaceOverrides(
  manifest: ProjectManifestV1,
): Record<string, WorkspaceKind> {
  return Object.fromEntries(
    manifest.sources.flatMap((source) =>
      source.inspectionStatus === "ready" && source.workspace.userOverride
        ? [[source.sourceId, source.workspace.userOverride] as const]
        : []),
  );
}
