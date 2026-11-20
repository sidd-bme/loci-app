export type ImageFormat = "ome-tiff" | "ome-zarr";
export type ImageConversionRequest = { source_id: string; source_sha256: string; format: ImageFormat };
export type ImageConversionReceipt = {
  format: ImageFormat; artifact: string; axes: "TCZYX"; shape: number[]; dtype: string;
  bytes: number; pixel_sha256: string; output_sha256: string;
};

const HASH = /^[0-9a-f]{64}$/;
export function checkedImageConversion(value: unknown): ImageConversionRequest {
  const r = value as Partial<ImageConversionRequest> | null;
  if (!r || Object.keys(r).sort().join(",") !== "format,source_id,source_sha256" ||
    typeof r.source_id !== "string" || !/^[0-9a-f]{32}$/.test(r.source_id) ||
    typeof r.source_sha256 !== "string" || !HASH.test(r.source_sha256) ||
    (r.format !== "ome-tiff" && r.format !== "ome-zarr"))
    throw new Error("Choose a supported output and the current study image.");
  return { source_id: r.source_id, source_sha256: r.source_sha256, format: r.format };
}

export function checkedImageConversionReceipt(value: unknown, format: ImageFormat): ImageConversionReceipt {
  const r = value as Partial<ImageConversionReceipt> | null;
  const artifact = format === "ome-tiff" ? "image.ome.tif" : "image.ome.zarr";
  if (!r || r.format !== format || r.artifact !== artifact || r.axes !== "TCZYX" ||
    !Array.isArray(r.shape) || r.shape.length !== 5 || !r.shape.every(n => Number.isSafeInteger(n) && n > 0) ||
    typeof r.dtype !== "string" || !/^(u?int(8|16|32|64)|float(16|32|64))$/.test(r.dtype) ||
    typeof r.bytes !== "number" || !Number.isSafeInteger(r.bytes) || r.bytes <= 0 ||
    typeof r.pixel_sha256 !== "string" || !HASH.test(r.pixel_sha256) ||
    typeof r.output_sha256 !== "string" || !HASH.test(r.output_sha256))
    throw new Error("The converted image could not be verified.");
  return { format, artifact, axes: r.axes, shape: r.shape, dtype: r.dtype, bytes: r.bytes,
    pixel_sha256: r.pixel_sha256, output_sha256: r.output_sha256 };
}
