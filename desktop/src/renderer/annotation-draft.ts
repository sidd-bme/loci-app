import { useCallback, useState } from "react";
import type { ResearchSelection, ResearchSource } from "../shared/research-contracts";
import type { AnnotationTool, ImagePoint } from "./ImageViewport";

export type AnnotationDraftFields = {
  label: string;
  transectClass: "suprapapillary" | "ridge-base" | "custom";
  upperBoundary: string; lowerBoundary: string; orientationRule: string; exclusions: string; transectReviewer: string;
};
export const DEFAULT_ANNOTATION_DRAFT_FIELDS: AnnotationDraftFields = {
  label: "", transectClass: "suprapapillary", upperBoundary: "Stratum granulosum (viable epidermis)",
  lowerBoundary: "Dermal-epidermal junction", orientationRule: "Perpendicular to local basement membrane",
  exclusions: "Tears, folds, appendages excluded", transectReviewer: "",
};
const EMPTY_POINTS: ImagePoint[] = [];
const MAX_DRAFTS = 128;
type Draft = { sourceId: string; sourceSha256: string; points: ImagePoint[]; fields: AnnotationDraftFields; version: number };
type Store = { epoch: number; fingerprints: string; drafts: Record<string, Draft>; tools: Record<string, AnnotationTool>; notice: string | null };
export type AnnotationDraftControl = {
  key: string; fields: AnnotationDraftFields; notice: string | null;
  updateFields: (fields: Partial<AnnotationDraftFields>) => void;
  captureCommit: () => () => void;
};

/** Session-only drafts. They never enter study snapshots or source annotation receipts. */
export function useAnnotationDrafts(epoch: number, sources: ResearchSource[], source: ResearchSource | null,
  selection: Pick<ResearchSelection, "z" | "t">, mode: "general" | "epidermis" = "general") {
  const fingerprints = JSON.stringify(sources.map((item) => [item.id, item.sha256]));
  const [store, setStore] = useState<Store>(() => ({ epoch, fingerprints, drafts: {}, tools: {}, notice: null }));
  let current = store;
  if (store.epoch !== epoch || store.fingerprints !== fingerprints) {
    const exactSources = new Set(sources.map((item) => JSON.stringify([item.id, item.sha256])));
    current = { epoch, fingerprints, notice: null,
      drafts: store.epoch === epoch ? Object.fromEntries(Object.entries(store.drafts)
        .filter(([, draft]) => exactSources.has(JSON.stringify([draft.sourceId, draft.sourceSha256])))) : {},
      tools: store.epoch === epoch ? Object.fromEntries(Object.entries(store.tools).filter(([key]) => {
        const [id, hash] = JSON.parse(key) as string[];
        return exactSources.has(JSON.stringify([id, hash]));
      })) : {},
    };
    // Synchronize derived identity before children can receive an old document's draft.
    setStore(current);
  }
  const sourceKey = source ? JSON.stringify([source.id, source.sha256, mode]) : "";
  const tool = current.tools[sourceKey] ?? (mode === "epidermis" ? "transect" : "navigate");
  const key = JSON.stringify([epoch, source?.id, source?.sha256, selection.z, selection.t, tool]);
  const draft = current.drafts[key];
  const exactSourceStillExists = (state: Store) => state.epoch === epoch && source !== null
    && (JSON.parse(state.fingerprints) as string[][]).some(([id, hash]) => id === source.id && hash === source.sha256);
  const setTool = useCallback((next: AnnotationTool) => {
    setStore((state) => exactSourceStillExists(state) ? { ...state, tools: { ...state.tools, [sourceKey]: next } } : state);
  }, [epoch, source?.id, source?.sha256, sourceKey]);
  const update = useCallback((change: (previous: Draft) => Draft | null) => {
    setStore((state) => {
      if (!exactSourceStillExists(state)) return state;
      const previous = state.drafts[key];
      const next = change(previous ?? { sourceId: source!.id, sourceSha256: source!.sha256,
        points: EMPTY_POINTS, fields: DEFAULT_ANNOTATION_DRAFT_FIELDS, version: 0 });
      if (!next) {
        const { [key]: _removed, ...drafts } = state.drafts;
        return { ...state, drafts, notice: null };
      }
      if (!previous && Object.keys(state.drafts).length >= MAX_DRAFTS) return {
        ...state, notice: "128 unfinished drafts are retained. Save or clear a draft before starting another.",
      };
      return { ...state, drafts: { ...state.drafts, [key]: { ...next, version: (previous?.version ?? 0) + 1 } }, notice: null };
    });
  }, [epoch, source?.id, source?.sha256, key]);
  const setPoints = useCallback((next: ImagePoint[] | ((previous: ImagePoint[]) => ImagePoint[])) => {
    update((previous) => {
      const points = typeof next === "function" ? next(previous.points) : next;
      if (!points.length) return null;
      const dimensions = source?.metadata.dimensions;
      if (points.length > 2048 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.y < 0 || (dimensions && (point.x > dimensions.x || point.y > dimensions.y)))) return previous;
      return { ...previous, points };
    });
  }, [update, source?.metadata.dimensions]);
  const updateFields = useCallback((fields: Partial<AnnotationDraftFields>) => {
    update((previous) => ({ ...previous, fields: { ...previous.fields, ...fields } }));
  }, [update]);
  const version = draft?.version;
  const captureCommit = useCallback(() => () => {
    setStore((state) => {
      if (!exactSourceStillExists(state) || state.drafts[key]?.version !== version) return state;
      const { [key]: _saved, ...drafts } = state.drafts;
      return { ...state, drafts, notice: null };
    });
  }, [epoch, source?.id, source?.sha256, key, version]);
  return {
    tool, setTool, points: draft?.points ?? EMPTY_POINTS, setPoints,
    control: { key, fields: draft?.fields ?? DEFAULT_ANNOTATION_DRAFT_FIELDS, notice: current.notice,
      updateFields, captureCommit } satisfies AnnotationDraftControl,
  };
}
