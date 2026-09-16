import { AlertTriangle, Ban, Check, CircleDashed, Images } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type { ReviewItem } from "./review-state";

const ROW_HEIGHT = 238;
const OVERSCAN_ROWS = 2;

function columnsForWidth(width: number): number {
  if (width >= 1_160) return 4;
  if (width >= 820) return 3;
  return 2;
}

function statusLabel(item: ReviewItem): string {
  if (!item.result) return "Not processed";
  if (item.reviewStatus === "reviewed") return "Reviewed";
  if (item.reviewStatus === "excluded") return "Excluded";
  if (item.result.quality.status === "invalid") return "Not usable";
  if (item.result.quality.status === "warning") return "Check result";
  return "Unreviewed";
}

function StatusIcon({ item }: { item: ReviewItem }): React.JSX.Element {
  if (item.reviewStatus === "reviewed") return <Check size={12} aria-hidden="true" />;
  if (item.reviewStatus === "excluded") return <Ban size={12} aria-hidden="true" />;
  if (item.result?.quality.status === "invalid" || item.result?.quality.status === "warning" || item.countOutlier) {
    return <AlertTriangle size={12} aria-hidden="true" />;
  }
  return <CircleDashed size={12} aria-hidden="true" />;
}

export interface ReviewContactSheetProps {
  items: ReviewItem[];
  activeSourceId: string | null;
  onSelect: (sourceId: string) => void;
  onOpen: (sourceId: string) => void;
}

/** Fixed-row virtualized review grid with roving keyboard focus. */
export default function ReviewContactSheet({
  items,
  activeSourceId,
  onSelect,
  onOpen,
}: ReviewContactSheetProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 900, height: 700, top: 0 });
  const columns = columnsForWidth(viewport.width);
  const rowCount = Math.ceil(items.length / columns);
  const visible = useMemo(() => {
    const firstRow = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(
      rowCount,
      Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN_ROWS,
    );
    return {
      firstRow,
      lastRow,
      items: items.slice(firstRow * columns, lastRow * columns),
    };
  }, [columns, items, rowCount, viewport.height, viewport.top]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const update = () => setViewport((current) => ({
      width: element.clientWidth,
      height: element.clientHeight,
      top: current.top,
    }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const focusIndex = (index: number) => {
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    const item = items[bounded];
    if (!item) return;
    onSelect(item.source.sourceId);
    const targetTop = Math.floor(bounded / columns) * ROW_HEIGHT;
    viewportRef.current?.scrollTo({
      top: Math.max(0, targetTop - ROW_HEIGHT),
      behavior: "smooth",
    });
    window.requestAnimationFrame(() => {
      viewportRef.current
        ?.querySelector<HTMLButtonElement>(`[data-review-source="${CSS.escape(item.source.sourceId)}"]`)
        ?.focus();
    });
  };

  if (!items.length) {
    return (
      <div className="review-empty" role="status">
        <Images size={24} aria-hidden="true" />
        <strong>No results match this review filter</strong>
        <span>Change the filter or process pending images.</span>
      </div>
    );
  }

  return (
    <div
      className="review-contact-sheet"
      ref={viewportRef}
      onScroll={(event) => setViewport((current) => ({
        ...current,
        top: event.currentTarget.scrollTop,
      }))}
      aria-label="Analysis review results"
    >
      <div style={{ height: visible.firstRow * ROW_HEIGHT }} aria-hidden="true" />
      <div className="review-card-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {visible.items.map((item) => {
          const index = items.indexOf(item);
          const selected = item.source.sourceId === activeSourceId;
          const image = item.result?.overlayDataUrl ?? item.source.previewDataUrl;
          const status = statusLabel(item);
          return (
            <button
              type="button"
              className={`review-card ${selected ? "is-selected" : ""} review-${item.reviewStatus} quality-${item.result?.quality.status ?? "pending"}`}
              key={item.source.sourceId}
              data-review-source={item.source.sourceId}
              aria-label={`${item.source.name}, ${status}${item.result ? `, ${item.result.metrics.count.toLocaleString()} cells` : ""}`}
              aria-pressed={selected}
              tabIndex={selected || (!activeSourceId && index === 0) ? 0 : -1}
              onClick={() => onSelect(item.source.sourceId)}
              onDoubleClick={() => onOpen(item.source.sourceId)}
              onKeyDown={(event) => {
                let next: number | null = null;
                if (event.key === "ArrowRight") next = index + 1;
                if (event.key === "ArrowLeft") next = index - 1;
                if (event.key === "ArrowDown") next = index + columns;
                if (event.key === "ArrowUp") next = index - columns;
                if (next !== null) {
                  event.preventDefault();
                  focusIndex(next);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onOpen(item.source.sourceId);
                }
              }}
            >
              <span className="review-card-image">
                {image ? <img src={image} alt="" draggable={false} /> : <Images size={26} aria-hidden="true" />}
                {item.countOutlier && (
                  <span className="review-outlier-badge" title="Count differs from its acquisition group">
                    Count outlier
                  </span>
                )}
              </span>
              <span className="review-card-copy">
                <strong title={item.source.name}>{item.source.name}</strong>
                <span className="review-card-path" title={item.source.relativePath}>{item.source.relativePath}</span>
                <span className="review-card-metrics">
                  <span className={`review-card-status status-${item.reviewStatus}`}>
                    <StatusIcon item={item} />
                    {status}
                  </span>
                  <span className="review-card-count">
                    {item.result ? item.result.metrics.count.toLocaleString() : "—"}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ height: Math.max(0, rowCount - visible.lastRow) * ROW_HEIGHT }} aria-hidden="true" />
    </div>
  );
}
