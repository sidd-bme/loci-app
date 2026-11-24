import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import {
  isVolumeOpeningPreviewRequestId,
  type VolumeOpeningPreviewEvent,
  type VolumeOpeningPreviewPayload,
} from "../shared/volume-opening-preview";

export type VolumeOpeningDesktopApi = ResearchDesktopApi & {
  openVolumeImage?(previewRequestId?: string): ReturnType<NonNullable<ResearchDesktopApi["openVolumeImage"]>>;
  onVolumeOpeningPreview?(listener: (event: VolumeOpeningPreviewEvent) => void): () => void;
};

export type VolumeOpeningTarget = {
  documentEpoch: number;
  projectId: string | undefined;
  sourceId: string;
  sourceSha256: string;
  navigation: number;
};

type OpeningPreview = {
  api: VolumeOpeningDesktopApi;
  preview: VolumeOpeningPreviewPayload;
  target: VolumeOpeningTarget | null;
};

export function useVolumeOpeningPreview(api: VolumeOpeningDesktopApi) {
  const [visible, setVisible] = useState<OpeningPreview | null>(null);
  const subscribed = useRef(false);
  const opening = useRef<{ id: string; inventory?: string; dismissed: boolean } | null>(null);

  useEffect(() => {
    setVisible(null);
    if (!api.onVolumeOpeningPreview) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.onVolumeOpeningPreview((event) => {
        const request = opening.current;
        if (!active || !request || request.dismissed || event?.request_id !== request.id) return;
        if (event.preview === null) {
          request.dismissed = true;
          setVisible(null);
        } else if (event.preview?.schema_version === "loci.volume-opening-preview/v1" &&
            event.preview.opening_id === request.id && !request.inventory &&
            typeof event.preview.source_inventory_sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(event.preview.source_inventory_sha256)) {
          request.inventory = event.preview.source_inventory_sha256;
          setVisible({ api, preview: event.preview, target: null });
        }
      });
      subscribed.current = true;
    } catch {
      // Opening the verified source can proceed without the preview listener.
    }
    return () => {
      active = false;
      subscribed.current = false;
      opening.current = null;
      unsubscribe?.();
    };
  }, [api]);

  const begin = () => {
    if (!subscribed.current) return;
    let id;
    try { id = globalThis.crypto?.randomUUID?.(); } catch { return; }
    if (!isVolumeOpeningPreviewRequestId(id)) return;
    opening.current = { id, dismissed: false };
    return id;
  };
  const hide = useCallback((id: string) => {
    if (opening.current?.id === id) opening.current.dismissed = true;
    setVisible((current) => current?.preview.opening_id === id ? null : current);
  }, []);
  const clearVerifiedHandoff = useCallback(() => {
    setVisible((current) => current?.target ? null : current);
  }, []);
  const finish = (id: string | undefined, verifiedInventory?: string, target?: VolumeOpeningTarget) => {
    const request = opening.current;
    if (!id || request?.id !== id) return;
    // Seal the request before adopting the registered source. No later IPC
    // event can replace the pixels retained for this one handoff.
    opening.current = null;
    setVisible((current) => {
      if (current?.preview.opening_id !== id) return current;
      if (!request.dismissed && target && request.inventory && request.inventory === verifiedInventory) {
        return { ...current, target };
      }
      return null;
    });
    return request.inventory;
  };

  return { visible: visible?.api === api ? visible : null, begin, hide, finish, clearVerifiedHandoff };
}
