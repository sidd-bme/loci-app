import {
  MODEL_LIBRARY_OFFICIAL_LINKS,
  requireModelLibraryLinkId,
  resolveModelLibraryLinkUrl,
  type ModelLibraryLinkId,
} from "../shared/model-library";

export {
  MODEL_LIBRARY_OFFICIAL_LINKS,
  requireModelLibraryLinkId,
  resolveModelLibraryLinkUrl,
  type ModelLibraryLinkId,
};

/**
 * Open an official curated model source or DOI in the external browser using
 * an exact fixed-ID key lookup. Raw URLs from the renderer are always rejected.
 */
export async function openModelLibraryLink(
  linkIdValue: unknown,
  openExternal: (url: string) => Promise<void> | void,
): Promise<string> {
  const url = resolveModelLibraryLinkUrl(linkIdValue);
  await openExternal(url);
  return url;
}
