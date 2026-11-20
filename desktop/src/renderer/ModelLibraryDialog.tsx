import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  Compass,
  ExternalLink,
  Layers,
  Search,
  X,
} from "lucide-react";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MODEL_LIBRARY_ENTRIES,
  MODEL_LIBRARY_NATIVE_BASELINES,
  findModelLibraryLinkIdByUrl,
  requireModelLibraryLinkId,
  type ModelLibraryEntry,
  type ModelLibraryFilterGroup,
  type ModelLibraryId,
  type ModelLibraryLinkId,
  type ModelLibraryWorkbenchRouteKind,
} from "../shared/model-library";
import {
  BUNDLED_MODEL_ZOO_EXAMPLES,
  type ModelZooExampleRegistry,
  type ModelZooResolvedExample,
} from "./model-zoo/examples";
import ModelZooComparison from "./model-zoo/ModelZooComparison";
import {
  countModelZooEntries,
  filterModelZooEntries,
} from "./model-zoo/search";
import "./ModelLibraryDialog.css";

export interface ModelLibraryDialogProps {
  onClose: () => void;
  onOpenLink?: (linkId: ModelLibraryLinkId) => Promise<void> | void;
  onSelectWorkbenchRoute?: (
    route: ModelLibraryWorkbenchRouteKind,
    modelId: ModelLibraryId,
  ) => void;
  workbenchRouteUnavailableReason?: string | null;
  initialModelId?: ModelLibraryId;
  reducedMotion?: boolean;
  /** Optional synthetic or custom example registry for unit testing. */
  examples?: ModelZooExampleRegistry;
}

function detectReducedMotion(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (
    typeof document !== "undefined" &&
    document.documentElement.dataset.motion === "reduced"
  ) {
    return true;
  }
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return true;
  }
  return false;
}

function CreditAddressValue({
  url,
  label,
  caption,
  onOpenLink,
}: {
  url: string;
  label: string;
  caption?: string;
  onOpenLink: (linkId: ModelLibraryLinkId) => void;
}): React.JSX.Element {
  const registeredId = findModelLibraryLinkIdByUrl(url);
  if (registeredId) {
    return (
      <button
        type="button"
        className="model-zoo-inline-link"
        onClick={() => onOpenLink(registeredId)}
        title={`Open registered ${label} in your browser`}
      >
        <span>{caption ?? url}</span>
        <ArrowUpRight size={11} aria-hidden="true" />
      </button>
    );
  }
  return <code className="model-zoo-plain-address">{url}</code>;
}

function ModelZooCard({
  entry,
  example,
  onSelect,
  onOpenLink,
  selectButtonRef,
}: {
  entry: Readonly<ModelLibraryEntry>;
  example: Readonly<ModelZooResolvedExample> | null;
  onSelect: (modelId: ModelLibraryId) => void;
  onOpenLink: (linkId: ModelLibraryLinkId) => void;
  selectButtonRef?: React.Ref<HTMLButtonElement>;
}): React.JSX.Element {
  const titleId = useId();
  const [showingOriginal, setShowingOriginal] = useState(false);
  const [thumbFallback, setThumbFallback] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    setShowingOriginal(false);
    setThumbFallback(false);
    setMediaError(false);
  }, [entry.id, example?.thumbnailUrl, example?.originalUrl, example?.overlayUrl]);

  const isLocal = entry.filterGroup === "local";
  const isPaired = example?.kind === "prediction";

  const activeImageSrc = example
    ? isPaired && showingOriginal
      ? example.originalUrl
      : thumbFallback
        ? isPaired
          ? example.overlayUrl
          : example.originalUrl
        : example.thumbnailUrl
    : null;

  const activeImageAlt = example
    ? isPaired
      ? showingOriginal
        ? `Original reference input for ${entry.title}: ${example.credit.subject}`
        : `Prediction overlay example for ${entry.title}: ${example.credit.subject}`
      : `Reference input image for ${entry.title}: ${example.credit.subject}`
    : "";

  const previewLayerAttr = example
    ? isPaired
      ? showingOriginal
        ? "original"
        : "overlay"
      : "original"
    : "none";

  return (
    <article
      className="model-zoo-card"
      aria-labelledby={titleId}
      data-model-id={entry.id}
      data-execution-mode={entry.executionMode}
      data-example-kind={example?.kind ?? "unavailable"}
      data-preview-layer={previewLayerAttr}
    >
      <div className="model-zoo-card__media">
        {activeImageSrc && !mediaError ? (
          <img
            src={activeImageSrc}
            alt={activeImageAlt}
            decoding="async"
            draggable={false}
            className="model-zoo-card__img"
            data-layer={previewLayerAttr}
            onError={() => {
              if (!showingOriginal && !thumbFallback && example) {
                setThumbFallback(true);
              } else {
                setMediaError(true);
              }
            }}
          />
        ) : (
          <div className="model-zoo-card__media-empty">
            <span className="model-zoo-card__media-empty-title">
              {mediaError
                ? "Example image failed to decode"
                : "Reference imagery pending"}
            </span>
            <span className="model-zoo-card__media-empty-meta">
              {entry.taskLabel}
            </span>
          </div>
        )}

        {isPaired && !mediaError && (
          <button
            type="button"
            className="model-zoo-card__layer-toggle"
            aria-pressed={showingOriginal}
            aria-label={
              showingOriginal
                ? `Showing original input for ${entry.title}. Switch to prediction overlay`
                : `Showing prediction overlay for ${entry.title}. Switch to original input`
            }
            onClick={() => setShowingOriginal((current) => !current)}
          >
            <span data-active={!showingOriginal ? "true" : "false"}>
              Overlay
            </span>
            <span data-active={showingOriginal ? "true" : "false"}>
              Original
            </span>
          </button>
        )}
      </div>

      <div className="model-zoo-card__body">
        <div className="model-zoo-card__head">
          <h3 id={titleId} className="model-zoo-card__title">
            <button
              ref={selectButtonRef}
              type="button"
              className="model-zoo-card__select"
              onClick={() => onSelect(entry.id)}
            >
              {entry.title}
            </button>
          </h3>
        </div>

        <div className="model-zoo-card__meta">
          <span
            className={`model-library-badge ${
              isLocal
                ? "model-library-badge--execution-local"
                : "model-library-badge--execution-external"
            }`}
          >
            {isLocal ? (
              <Boxes size={10} aria-hidden="true" />
            ) : (
              <Layers size={10} aria-hidden="true" />
            )}
            <span>{entry.executionShortLabel}</span>
          </span>
          <span className="model-zoo-card__task">{entry.taskLabel}</span>
        </div>

        <p className="model-zoo-card__summary">{entry.cardSummary}</p>

        <div className="model-zoo-card__footer">
          <button
            type="button"
            className="model-zoo-card__publisher"
            aria-label={`Open official ${entry.title} source (${entry.primaryLink.label} on ${entry.primaryLink.hostLabel})`}
            title={`Open ${entry.primaryLink.label} (${entry.primaryLink.hostLabel}) in your browser`}
            onClick={() => onOpenLink(entry.primaryLink.id)}
          >
            <span>{entry.publisherBadge}</span>
            <ExternalLink size={11} aria-hidden="true" />
          </button>
          <span className="model-zoo-card__inspect-cue" aria-hidden="true">
            Details
          </span>
        </div>
      </div>
    </article>
  );
}

function ModelZooDetail({
  entry,
  example,
  isReducedMotion,
  onOpenLink,
  onSelectWorkbenchRoute,
  workbenchRouteUnavailableReason,
}: {
  entry: Readonly<ModelLibraryEntry>;
  example: Readonly<ModelZooResolvedExample> | null;
  isReducedMotion: boolean;
  onOpenLink: (linkId: ModelLibraryLinkId) => void;
  onSelectWorkbenchRoute?: (
    route: ModelLibraryWorkbenchRouteKind,
    modelId: ModelLibraryId,
  ) => void;
  workbenchRouteUnavailableReason?: string | null;
}): React.JSX.Element {
  const isLocal = entry.filterGroup === "local";
  const routeDisabled = Boolean(workbenchRouteUnavailableReason);

  return (
    <div
      className="model-zoo-detail"
      data-model-id={entry.id}
      data-execution-mode={entry.executionMode}
    >
      <div className="model-zoo-detail__media-col">
        <ModelZooComparison
          entry={entry}
          example={example}
          reducedMotion={isReducedMotion}
        />
      </div>

      <div className="model-zoo-detail__info-col">
        <div className="model-zoo-detail__badges">
          <span
            className={`model-library-badge ${
              isLocal
                ? "model-library-badge--execution-local"
                : "model-library-badge--execution-external"
            }`}
          >
            {isLocal ? (
              <Boxes size={11} aria-hidden="true" />
            ) : (
              <Layers size={11} aria-hidden="true" />
            )}
            <span>{entry.executionBadge}</span>
          </span>
          <span className="model-zoo-detail__verification">
            {entry.verificationBadge}
          </span>
        </div>

        <p className="model-zoo-detail__summary">{entry.summary}</p>

        <dl className="model-zoo-spec-list">
          <div>
            <dt>Version</dt>
            <dd>{entry.artifact.version}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{entry.target}</dd>
          </div>
          <div>
            <dt>Modality</dt>
            <dd>{entry.modalitySummary}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>
              {entry.executionBadge} · {entry.artifact.runtimeRequirement}
            </dd>
          </div>
          <div>
            <dt>Input contract</dt>
            <dd>{entry.inputContract}</dd>
          </div>
          <div>
            <dt>In Loci</dt>
            <dd>{entry.lociPathway}</dd>
          </div>
        </dl>

        <div className="model-zoo-detail__primary-action">
          {onSelectWorkbenchRoute && (
            <button
              type="button"
              className="model-library-action-btn model-library-action-btn--primary"
              disabled={routeDisabled}
              title={
                workbenchRouteUnavailableReason ??
                `Open ${entry.workbenchRoute.inspectorLocation}`
              }
              onClick={() =>
                onSelectWorkbenchRoute(entry.workbenchRoute.kind, entry.id)
              }
            >
              <Compass size={14} aria-hidden="true" />
              <span>{entry.workbenchRoute.actionLabel}</span>
            </button>
          )}
          {workbenchRouteUnavailableReason && (
            <p className="model-zoo-detail__unavailable-note">
              {workbenchRouteUnavailableReason}
            </p>
          )}
        </div>

        <section
          className="model-zoo-detail__links-section"
          aria-label="Official publisher and paper links"
        >
          <h3>Official sources &amp; publication</h3>
          <div className="model-zoo-detail__links">
            <button
              type="button"
              className="model-library-action-btn"
              title={`Open official external source (${entry.primaryLink.hostLabel}) in your browser`}
              onClick={() => onOpenLink(entry.primaryLink.id)}
            >
              <span>{entry.primaryLink.label}</span>
              <span className="model-library-action-btn__host">
                ({entry.primaryLink.hostLabel})
              </span>
              <ExternalLink size={12} aria-hidden="true" />
            </button>
            {entry.secondaryLinks.map((link) => (
              <button
                key={link.id}
                type="button"
                className="model-library-action-btn"
                title={`Open official external reference (${link.hostLabel}) in your browser`}
                onClick={() => onOpenLink(link.id)}
              >
                <span>{link.label}</span>
                <span className="model-library-action-btn__host">
                  ({link.hostLabel})
                </span>
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        <details className="model-library-details model-zoo-provenance">
          <summary>
            <span>Rights, reference &amp; provenance</span>
            <ChevronDown
              className="model-library-details__chevron"
              size={14}
              aria-hidden="true"
            />
          </summary>
          <div className="model-library-details__body">
            <section
              className="model-library-details__section"
              aria-label="Task and verification"
            >
              <h4>Task &amp; verification</h4>
              <p>{entry.taskSummary}</p>
              <p>{entry.verificationDetail}</p>
            </section>

            <section
              className="model-library-details__section"
              aria-label="Reference"
            >
              <h4>Reference</h4>
              <p>
                {entry.citation.authors} ({entry.citation.year}).{" "}
                <strong>{entry.citation.title}</strong>. {entry.citation.venue}.{" "}
                <span>Status: {entry.citation.publicationStatus}.</span> DOI:{" "}
                <code>{entry.citation.doi}</code>
              </p>
              {entry.citation.secondaryNote && (
                <p>{entry.citation.secondaryNote}</p>
              )}
            </section>

            <section
              className="model-library-details__section"
              aria-label="Known limitations"
            >
              <h4>Known limitations</h4>
              <ul>
                {entry.limitations.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </section>

            <section
              className="model-library-details__section"
              aria-label="Artifact and rights provenance"
            >
              <h4>Artifact &amp; rights record</h4>
              <dl className="model-library-details__kv">
                <div>
                  <dt>Artifact ID</dt>
                  <dd>
                    <code>{entry.artifact.artifactId}</code>
                  </dd>
                </div>
                <div>
                  <dt>File / package</dt>
                  <dd>
                    <code>{entry.artifact.fileName}</code>
                  </dd>
                </div>
                <div>
                  <dt>Version / revision</dt>
                  <dd>{entry.artifact.version}</dd>
                </div>
                <div>
                  <dt>SHA-256 digest</dt>
                  <dd>
                    {entry.artifact.sha256 ? (
                      <code>{entry.artifact.sha256}</code>
                    ) : (
                      "User-supplied external runtime checkpoint"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Digest provenance</dt>
                  <dd>{entry.artifact.digestBasisLabel}</dd>
                </div>
                {entry.artifact.sizeBytes !== null && (
                  <div>
                    <dt>Exact size</dt>
                    <dd>{entry.artifact.sizeBytes.toLocaleString()} bytes</dd>
                  </div>
                )}
                <div>
                  <dt>Runtime</dt>
                  <dd>{entry.artifact.runtimeRequirement}</dd>
                </div>
                <div>
                  <dt>Weights &amp; commercial</dt>
                  <dd>
                    {entry.rights.weightsLicense} · Commercial use:{" "}
                    {entry.rights.commercialUse}
                  </dd>
                </div>
                <div>
                  <dt>Code licence</dt>
                  <dd>{entry.rights.codeLicense}</dd>
                </div>
                <div>
                  <dt>Redistribution</dt>
                  <dd>{entry.rights.redistribution}</dd>
                </div>
                <div>
                  <dt>Training lineage</dt>
                  <dd>{entry.rights.trainingDataLineage}</dd>
                </div>
              </dl>
              {entry.artifact.companionNote && (
                <p>{entry.artifact.companionNote}</p>
              )}
            </section>

            {example && (
              <section
                className="model-library-details__section"
                aria-label="Example image credit"
              >
                <h4>Example image credit</h4>
                <dl className="model-library-details__kv">
                  <div>
                    <dt>Example version</dt>
                    <dd>{example.credit.modelVersion}</dd>
                  </div>
                  <div>
                    <dt>Attribution</dt>
                    <dd>{example.credit.attribution}</dd>
                  </div>
                  <div>
                    <dt>Image licence</dt>
                    <dd>
                      {typeof example.credit.extraMetadata.licenseUrl === "string" ? (
                        <CreditAddressValue
                          url={example.credit.extraMetadata.licenseUrl}
                          label={example.credit.imageLicense}
                          onOpenLink={onOpenLink}
                          caption={example.credit.imageLicense}
                        />
                      ) : example.credit.imageLicense}
                    </dd>
                  </div>
                  <div>
                    <dt>Prediction origin</dt>
                    <dd>
                      {example.credit.predictionOrigin ??
                        "None (reference input only)"}
                    </dd>
                  </div>
                  <div>
                    <dt>Image source</dt>
                    <dd>
                      <CreditAddressValue
                        url={example.credit.sourceUrl}
                        label="example image source"
                        onOpenLink={onOpenLink}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Publication</dt>
                    <dd>
                      <CreditAddressValue
                        url={example.credit.publicationUrl}
                        label="example publication"
                        onOpenLink={onOpenLink}
                      />
                    </dd>
                  </div>
                </dl>
              </section>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

const FILTER_LABELS: ReadonlyArray<{
  readonly id: ModelLibraryFilterGroup;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "local", label: "Local" },
  { id: "external", label: "External" },
];

export default function ModelLibraryDialog({
  onClose,
  onOpenLink,
  onSelectWorkbenchRoute,
  workbenchRouteUnavailableReason = null,
  initialModelId,
  reducedMotion,
  examples = BUNDLED_MODEL_ZOO_EXAMPLES,
}: ModelLibraryDialogProps): React.JSX.Element {
  const titleId = useId();
  const statusId = useId();
  const [filter, setFilter] = useState<ModelLibraryFilterGroup>("all");
  const [query, setQuery] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<ModelLibraryId | null>(
    null,
  );
  const [linkError, setLinkError] = useState<string | null>(null);
  const [isReducedMotion, setIsReducedMotion] = useState(() =>
    detectReducedMotion(reducedMotion),
  );

  const dialogRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cardSelectRefs = useRef<
    Partial<Record<ModelLibraryId, HTMLButtonElement | null>>
  >({});
  const returningModelIdRef = useRef<ModelLibraryId | null>(null);
  const selectedModelIdRef = useRef<ModelLibraryId | null>(selectedModelId);
  selectedModelIdRef.current = selectedModelId;
  const queryRef = useRef(query);
  queryRef.current = query;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setIsReducedMotion(detectReducedMotion(reducedMotion));
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setIsReducedMotion(detectReducedMotion(reducedMotion));
    media?.addEventListener?.("change", update);
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(update)
        : null;
    if (observer && typeof document !== "undefined") {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-motion"],
      });
    }
    return () => {
      media?.removeEventListener?.("change", update);
      observer?.disconnect();
    };
  }, [reducedMotion]);

  useEffect(() => {
    const prior =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (initialModelId && cardSelectRefs.current[initialModelId]) {
      const target = cardSelectRefs.current[initialModelId]!;
      target.scrollIntoView?.({ block: "nearest" });
      target.focus();
    } else if (searchInputRef.current) {
      searchInputRef.current.focus();
    } else {
      closeButtonRef.current?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const shell = dialogRef.current;
      if (!shell || shell.closest("[hidden], [inert]")) return;

      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        if (selectedModelIdRef.current !== null) {
          returningModelIdRef.current = selectedModelIdRef.current;
          setSelectedModelId(null);
          return;
        }
        if (
          document.activeElement === searchInputRef.current &&
          queryRef.current.length > 0
        ) {
          setQuery("");
          return;
        }
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = [
        ...shell.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])",
        ),
      ].filter(
        (item) =>
          item.tabIndex >= 0 &&
          !item.closest("[hidden], [inert]") &&
          (!item.closest("details:not([open])") ||
            Boolean(item.closest("summary"))),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (prior?.isConnected) prior.focus();
    };
  }, [initialModelId]);

  useEffect(() => {
    if (selectedModelId !== null) {
      backButtonRef.current?.focus();
      return;
    }
    const returningId = returningModelIdRef.current;
    if (returningId) {
      returningModelIdRef.current = null;
      const cardBtn = cardSelectRefs.current[returningId];
      if (cardBtn) {
        cardBtn.scrollIntoView?.({ block: "nearest" });
        cardBtn.focus();
      } else {
        searchInputRef.current?.focus();
      }
    }
  }, [selectedModelId]);

  const handleOpenLink = (linkId: ModelLibraryLinkId) => {
    setLinkError(null);
    try {
      const validatedId = requireModelLibraryLinkId(linkId);
      const dispatcher =
        onOpenLink ?? window.lociResearch?.openModelLibraryLink;
      if (!dispatcher) {
        setLinkError(
          "External link opening is unavailable in this environment.",
        );
        return;
      }
      void Promise.resolve(dispatcher(validatedId)).catch((error) => {
        setLinkError(
          error instanceof Error
            ? error.message
            : "Could not open the official model source.",
        );
      });
    } catch (error) {
      setLinkError(
        error instanceof Error
          ? error.message
          : "Choose a registered official model-library source.",
      );
    }
  };

  const onFilterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowRight",
        "ArrowDown",
        "ArrowLeft",
        "ArrowUp",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      return;
    }
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='radio']",
      ),
    ];
    if (!buttons.length) return;
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : current === -1
            ? 0
            : (current + (backwards ? buttons.length - 1 : 1)) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
    buttons[next].click();
  };

  const counts = useMemo(
    () => countModelZooEntries(MODEL_LIBRARY_ENTRIES, query, examples),
    [query, examples],
  );

  const visibleEntries = useMemo(
    () => filterModelZooEntries(MODEL_LIBRARY_ENTRIES, filter, query, examples),
    [filter, query, examples],
  );

  const selectedEntry = useMemo(
    () =>
      selectedModelId
        ? MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === selectedModelId) ??
          null
        : null,
    [selectedModelId],
  );

  const trimmedQuery = query.trim();
  const isFiltered = trimmedQuery.length > 0 || filter !== "all";
  const countLabel = isFiltered
    ? `${visibleEntries.length} of ${MODEL_LIBRARY_ENTRIES.length}`
    : `${MODEL_LIBRARY_ENTRIES.length}`;

  const statusText =
    visibleEntries.length === 0
      ? trimmedQuery
        ? `No models match “${trimmedQuery}”${filter !== "all" ? ` in ${filter} models` : ""}.`
        : `No ${filter} models available.`
      : isFiltered
        ? `Showing ${visibleEntries.length} of ${MODEL_LIBRARY_ENTRIES.length} models.`
        : `${MODEL_LIBRARY_ENTRIES.length} curated models.`;

  return (
    <div
      className="modal-backdrop model-library-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Model Zoo"
        className="model-library-dialog"
        data-reduced-motion={isReducedMotion ? "true" : "false"}
        data-view={selectedEntry ? "detail" : "grid"}
      >
        <header className="model-library-header">
          {selectedEntry ? (
            <div className="model-zoo-header__detail-nav">
              <button
                ref={backButtonRef}
                type="button"
                className="model-zoo-back-btn"
                onClick={() => {
                  returningModelIdRef.current = selectedEntry.id;
                  setSelectedModelId(null);
                }}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                <span>Model Zoo</span>
              </button>
              <span className="model-zoo-header__sep" aria-hidden="true">
                /
              </span>
              <h2 id={titleId} className="model-zoo-header__detail-title">
                {selectedEntry.title}
              </h2>
            </div>
          ) : (
            <div className="model-zoo-header__brand">
              <h2 id={titleId}>
                <Boxes size={16} strokeWidth={1.65} aria-hidden="true" />
                <span>Model Zoo</span>
              </h2>
              <span className="model-zoo-header__count" aria-hidden="true">
                {countLabel}
              </span>
            </div>
          )}

          <div className="model-library-header__controls">
            {!selectedEntry && (
              <>
                <div className="model-zoo-search">
                  <Search
                    className="model-zoo-search__icon"
                    size={13}
                    aria-hidden="true"
                  />
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="model-zoo-search__input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search models, modalities, tasks…"
                    aria-label="Search Model Zoo"
                    aria-describedby={statusId}
                  />
                  {query.length > 0 && (
                    <button
                      type="button"
                      className="model-zoo-search__clear"
                      aria-label="Clear search"
                      onClick={() => {
                        setQuery("");
                        searchInputRef.current?.focus();
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <div
                  className="model-library-filters"
                  role="radiogroup"
                  aria-label="Filter models by execution route"
                  onKeyDown={onFilterKeyDown}
                >
                  {FILTER_LABELS.map((option) => {
                    const checked = filter === option.id;
                    const count = counts[option.id];
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        className="model-library-filter-btn"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        onClick={() => setFilter(option.id)}
                      >
                        <span>{option.label}</span>
                        <span className="model-library-filter-btn__count">
                          ({count})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <button
              ref={closeButtonRef}
              type="button"
              className="button button-quiet icon-button model-library-close-btn"
              aria-label="Close Model Zoo"
              title="Close Model Zoo (Esc)"
              onClick={onClose}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          className="model-library-body"
          role="region"
          aria-label={
            selectedEntry ? `${selectedEntry.title} details` : "Model Zoo catalog"
          }
          tabIndex={0}
        >
          {linkError && (
            <div className="model-library-error" role="alert">
              <span>{linkError}</span>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setLinkError(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {selectedEntry ? (
            <ModelZooDetail
              entry={selectedEntry}
              example={examples[selectedEntry.id] ?? null}
              isReducedMotion={isReducedMotion}
              onOpenLink={handleOpenLink}
              onSelectWorkbenchRoute={onSelectWorkbenchRoute}
              workbenchRouteUnavailableReason={workbenchRouteUnavailableReason}
            />
          ) : (
            <>
              <p
                id={statusId}
                className={
                  isFiltered
                    ? "model-zoo-status"
                    : "model-zoo-status model-zoo-status--sr-only"
                }
                role="status"
                aria-live="polite"
              >
                {statusText}
              </p>

              {visibleEntries.length === 0 ? (
                <div className="model-zoo-empty">
                  <p>{statusText}</p>
                  <button
                    type="button"
                    className="model-library-action-btn model-zoo-empty__reset"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                      searchInputRef.current?.focus();
                    }}
                  >
                    Reset search &amp; filter
                  </button>
                </div>
              ) : (
                <div className="model-library-grid">
                  {visibleEntries.map((entry) => (
                    <ModelZooCard
                      key={entry.id}
                      entry={entry}
                      example={examples[entry.id] ?? null}
                      onSelect={(id) => setSelectedModelId(id)}
                      onOpenLink={handleOpenLink}
                      selectButtonRef={(node) => {
                        cardSelectRefs.current[entry.id] = node;
                      }}
                    />
                  ))}
                </div>
              )}

              <details className="model-library-baselines">
                <summary>
                  <span>
                    Built-in deterministic baselines (Apache-2.0 · always offline)
                  </span>
                  <ChevronDown
                    className="model-library-details__chevron"
                    size={14}
                    aria-hidden="true"
                  />
                </summary>
                <div className="model-library-baselines__grid">
                  {MODEL_LIBRARY_NATIVE_BASELINES.map((baseline) => (
                    <div
                      key={baseline.id}
                      className="model-library-baseline-item"
                      data-baseline-id={baseline.id}
                    >
                      <div className="model-library-baseline-item__top">
                        <strong>{baseline.name}</strong>
                        <span className="model-library-badge model-library-badge--execution-local">
                          {baseline.executionBadge} · {baseline.license}
                        </span>
                      </div>
                      <p>{baseline.summary}</p>
                      <small>
                        {baseline.verificationBadge} · {baseline.inspectorLocation}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
