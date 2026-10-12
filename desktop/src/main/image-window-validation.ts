import type { ResearchSource } from "../shared/research-contracts";
import type { ImageWindowInteraction, ImageWindowPresentation } from "../shared/image-window-api";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Invalid image display state.");
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= min && value <= max;
}
function color(value: unknown): value is string { return typeof value === "string" && /^#[a-f0-9]{6}$/iu.test(value); }
export function imageViewDimensions(source: ResearchSource) {
  let result = source.metadata.dimensions;
  if (!result && source.source_kind === "medical") {
    const { shape, geometry } = source.metadata;
    if (shape && ((shape.length === 3 && geometry?.axes === "ZYX") ||
        (shape.length === 2 && geometry?.axes === "YX"))) {
      result = { x: shape.at(-1)!, y: shape.at(-2)!, z: shape.length === 3 ? shape[0] : 1, t: 1, c: 1 };
    }
  }
  if (!result || ![result.x, result.y, result.z, result.t, result.c].every((value) => integer(value, 1, Number.MAX_SAFE_INTEGER)))
    throw new Error("This image has no valid explicit dimensions for a detached view.");
  return result;
}
function points(value: unknown, source: ResearchSource): Array<{ x: number; y: number }> {
  const { x, y } = imageViewDimensions(source);
  if (!Array.isArray(value) || value.length > 2048) throw new Error("The image draft exceeds its point limit.");
  return value.map((point) => {
    const p = record(point);
    if (!finite(p.x) || !finite(p.y) || p.x < 0 || p.y < 0 || p.x > x || p.y > y)
      throw new Error("Image draft coordinates must be within the source grid.");
    return { x: p.x, y: p.y };
  });
}
function camera(value: unknown): { x: number; y: number; scale: number } {
  const p = record(value);
  if (!finite(p.x) || !finite(p.y) || !finite(p.scale) || p.scale <= 0)
    throw new Error("Invalid image camera.");
  return { x: p.x, y: p.y, scale: p.scale };
}

function channels(value: unknown, source: ResearchSource): ImageWindowPresentation["channels"] {
  const d = imageViewDimensions(source);
  const channelCount = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "") ? 1 : d.c;
  if (!Array.isArray(value) || value.length < 1 || value.length > channelCount) throw new Error("Invalid image channels.");
  const indices = new Set<number>();
  for (const candidate of value) {
    const channel = record(candidate);
    if (!integer(channel.channel, 0, channelCount - 1) || indices.has(channel.channel) || !finite(channel.gamma) || channel.gamma <= 0 ||
      typeof channel.visible !== "boolean" || !color(channel.color) ||
      (channel.low !== undefined && !finite(channel.low)) || (channel.high !== undefined && !finite(channel.high)) ||
      (finite(channel.low) && finite(channel.high) && channel.high <= channel.low) ||
      (channel.opacity !== undefined && (!finite(channel.opacity) || channel.opacity < 0 || channel.opacity > 1)))
      throw new Error("Invalid channel display range, color or mapping.");
    indices.add(channel.channel);
  }
  return structuredClone(value) as ImageWindowPresentation["channels"];
}
function volumeDisplay(value: unknown): NonNullable<ImageWindowPresentation["volumeDisplay"]> {
  const p = record(value);
  if (!["blend", "normal_shading", "mip", "average", "minip"].includes(p.renderMode as string) ||
      !integer(p.quality, 10, 100)) throw new Error("Invalid volume display mode or quality.");
  return { renderMode: p.renderMode, quality: p.quality } as NonNullable<ImageWindowPresentation["volumeDisplay"]>;
}

export function validateImagePresentation(value: unknown, source: ResearchSource): ImageWindowPresentation {
  const p = record(value);
  if (Buffer.byteLength(JSON.stringify(p), "utf8") > 1024 * 1024)
    throw new Error("This view's annotations exceed the detached display limit. Use the main workspace.");
  const allowed = ["interpretation", "volumeDisplay", "mode", "selection", "channels", "projection", "tool", "draft", "annotations", "camera", "showScaleBar", "showNavigator"];
  if (Object.keys(p).some((key) => !allowed.includes(key))) throw new Error("Unsupported image presentation fields.");
  if (p.interpretation !== undefined && !["auto", "generic", "histology", "fluorescence", "volume", "medical"].includes(p.interpretation as string))
    throw new Error("Unknown image interpretation.");
  if (p.volumeDisplay !== undefined) volumeDisplay(p.volumeDisplay);
  const d = imageViewDimensions(source);
  const selection = record(p.selection);
  if (!integer(selection.x, 0, d.x - 1) || !integer(selection.y, 0, d.y - 1) ||
    !integer(selection.width, 1, d.x - selection.x) || !integer(selection.height, 1, d.y - selection.y) ||
    !integer(selection.t, 0, d.t - 1) || !integer(selection.z, 0, d.z - 1) ||
    !integer(selection.c, 0, d.c - 1) || selection.level !== 0 ||
    (selection.z_stop !== undefined && !integer(selection.z_stop, selection.z + 1, d.z)))
    throw new Error("Detached image selection must use valid level-zero source coordinates.");
  if (p.mode !== "plane" && p.mode !== "volume") throw new Error("Unknown image view mode.");
  if (!["plane", "max", "mean"].includes(p.projection as string)) throw new Error("Unknown projection.");
  if (!["navigate", "point", "line", "polygon", "freehand", "rectangle", "transect"].includes(p.tool as string)) throw new Error("Unknown annotation tool.");
  if (typeof p.showScaleBar !== "boolean" || typeof p.showNavigator !== "boolean") throw new Error("Invalid viewer preferences.");
  channels(p.channels, source);
  points(p.draft, source);
  if (p.camera !== null) camera(p.camera);
  if (!Array.isArray(p.annotations) || p.annotations.length > 4096) throw new Error("Too many annotations for a detached view.");
  for (const candidate of p.annotations) {
    const annotation = record(candidate);
    if (typeof annotation.id !== "string" || annotation.id.length > 128 ||
      !["point", "line", "polygon", "rectangle"].includes(annotation.kind as string) ||
      typeof annotation.label !== "string" || annotation.label.length > 512 || !color(annotation.color) ||
      !integer(annotation.t, 0, d.t - 1) || !integer(annotation.z, 0, d.z - 1)) throw new Error("Invalid display annotation.");
    points(annotation.points, source);
  }
  // Electron has already structured-cloned the IPC payload. Clone again for coordinator ownership.
  return structuredClone(p) as unknown as ImageWindowPresentation;
}

export function validateImageInteraction(value: unknown, source: ResearchSource): ImageWindowInteraction {
  const p = record(value);
  if (p.kind === "volume-display") return { kind: "volume-display", channels: channels(p.channels, source), ...volumeDisplay(p) };
  if (p.kind === "draft") {
    const plane = record(p.plane);
    const d = imageViewDimensions(source);
    if (!integer(plane.t, 0, d.t - 1) || !integer(plane.z, 0, d.z - 1)) throw new Error("Invalid annotation draft plane.");
    return { kind: "draft", points: points(p.points, source), plane: { t: plane.t, z: plane.z } };
  }
  if (p.kind === "camera") return { kind: "camera", camera: camera(p.camera) };
  if (p.kind === "error" && typeof p.message === "string" && p.message.length <= 1024) return { kind: "error", message: p.message };
  throw new Error("Unsupported image-window interaction.");
}
