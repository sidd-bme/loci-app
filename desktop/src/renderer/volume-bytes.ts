// The packaged Chromium runtime can decode directly into a byte array.
// Older test and development runtimes expose the string-based decoder.
const byteArrays = Uint8Array as Uint8ArrayConstructor & {
  fromBase64?: (encoded: string) => Uint8Array<ArrayBuffer>;
};

export function decodeVolumeBytes(encoded: string, expectedBytes: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (byteArrays.fromBase64) {
    bytes = byteArrays.fromBase64(encoded);
  } else {
    const binary = atob(encoded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.byteLength !== expectedBytes) throw new Error("Decoded volume byte length differs from its grid.");
  return bytes;
}

export async function volumeByteDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}


export const VOLUME_SCALAR_ENCODINGS = {
  uint8: [1, (buffer: ArrayBuffer) => new Uint8Array(buffer)],
  int8: [1, (buffer: ArrayBuffer) => new Int8Array(buffer)],
  uint16: [2, (buffer: ArrayBuffer) => new Uint16Array(buffer)],
  int16: [2, (buffer: ArrayBuffer) => new Int16Array(buffer)],
  uint32: [4, (buffer: ArrayBuffer) => new Uint32Array(buffer)],
  int32: [4, (buffer: ArrayBuffer) => new Int32Array(buffer)],
  float32: [4, (buffer: ArrayBuffer) => new Float32Array(buffer)],
} as const;
