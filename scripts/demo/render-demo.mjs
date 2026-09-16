#!/usr/bin/env node
/**
 * Render the Loci product demo from real, final-app captures.
 * It cannot record a desktop, manufacture scientific pixels, or synthesize UI.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const defaultManifest = join(import.meta.dirname, "demo-manifest.json");
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const defaultFont = "/System/Library/Fonts/Supplemental/Arial.ttf";
const usage = `Usage:
  node scripts/demo/render-demo.mjs --plan
  node scripts/demo/render-demo.mjs --captures /absolute/captures --output /absolute/new-output
    --receipt /absolute/capture-receipt.json [--manifest /absolute/demo-manifest.json]
`;

function fail(message) {
  process.stderr.write(`render-demo: ${message}\n`);
  throw new Error(message);
}
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error) fail(`${binary} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${binary} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function hash(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function isWithin(path, parent) {
  const relation = relative(parent, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
function args(argv) {
  const options = { manifest: defaultManifest, plan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--help" || value === "-h") { process.stdout.write(usage); process.exit(0); }
    if (value === "--plan") { options.plan = true; continue; }
    if (["--captures", "--output", "--receipt", "--manifest"].includes(value)) {
      const path = argv[++i];
      if (!path || !isAbsolute(path)) fail(`${value} requires an absolute path.`);
      options[value.slice(2)] = resolve(path);
      continue;
    }
    fail(`Unknown argument ${value}.`);
  }
  return options;
}
function validate(manifest) {
  const output = manifest?.output;
  if (manifest?.schema !== "loci.product-demo/v1") fail("Unsupported demo manifest schema.");
  if (output?.width !== 1920 || output?.height !== 1080 || output?.fps !== 30 ||
      output?.audio !== "none" || output?.transition_seconds !== 0.45)
    fail("Manifest must specify silent 1920x1080/30fps output and 0.45-second transitions.");
  if (!Array.isArray(manifest.segments) || manifest.segments.length < 3 || manifest.segments.length > 8)
    fail("Manifest requires three to eight segments.");
  const ids = new Set();
  for (const item of manifest.segments) {
    if (!/^[a-z0-9-]+$/.test(item.id ?? "") || ids.has(item.id)) fail("Segment identifiers must be unique lowercase identifiers.");
    ids.add(item.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]+\.(png|jpe?g|mp4|mov)$/i.test(item.file ?? "")) fail(`Unsafe file for ${item.id}.`);
    if (!["still", "clip"].includes(item.kind) || !Number.isFinite(item.duration_seconds) || item.duration_seconds < 3 || item.duration_seconds > 15)
      fail(`Invalid kind or duration for ${item.id}.`);
    if (typeof item.caption !== "string" || item.caption.length < 4 || item.caption.length > 80 || /[\r\n]/.test(item.caption))
      fail(`Invalid caption for ${item.id}.`);
  }
  return manifest;
}
function probe(file) {
  const result = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const stream = result.streams?.find((entry) => entry.codec_type === "video");
  if (!stream?.width || !stream?.height) fail(`${basename(file)} has no visual stream.`);
  if (Math.abs(stream.width / stream.height - 16 / 9) > 0.002) fail(`${basename(file)} must be 16:9; got ${stream.width}x${stream.height}.`);
  return { width: stream.width, height: stream.height, codec: stream.codec_name, duration: Number(result.format?.duration ?? 0) };
}
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validateCaptureReceipt(receipt, manifestPath, inputs) {
  if (receipt?.schema !== "loci.product-demo-capture/v1" || receipt.status !== "passed")
    fail("--receipt must be a passed Loci product-demo capture receipt.");
  if (receipt.manifest?.sha256 !== hash(manifestPath)) fail("Capture receipt does not bind this demo manifest.");
  if (!isSha256(receipt.public_visual_receipt?.sha256) || !isSha256(receipt.app?.application_artifact_sha256) ||
      !isSha256(receipt.app?.executable_sha256) || !isSha256(receipt.app?.worker_sha256))
    fail("Capture receipt lacks public-QA and packaged-app bindings.");
  if (!Array.isArray(receipt.clips) || !Array.isArray(receipt.readme_pngs) || receipt.readme_pngs.length < 5)
    fail("Capture receipt lacks the required clips or README captures.");
  for (const input of inputs) {
    const captured = receipt.clips.find((clip) => clip?.id === input.segment.id);
    if (!captured || captured.file !== input.segment.file || captured.sha256 !== input.sha256 ||
        Number(captured.duration_seconds) + 0.05 < input.segment.duration_seconds)
      fail(`Capture receipt does not bind ${input.segment.file}.`);
  }
  if (!Array.isArray(receipt.renderer_page_errors) || !Array.isArray(receipt.renderer_console_errors) || !Array.isArray(receipt.network_requests) ||
      receipt.renderer_page_errors.length || receipt.renderer_console_errors.length || receipt.network_requests.length)
    fail("Capture receipt records renderer errors or network activity.");
}
function escapeText(text) { return text.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll("%", "\\%"); }
function normalise(segment, source, destination) {
  const input = segment.kind === "still"
    ? ["-loop", "1", "-framerate", "30", "-t", String(segment.duration_seconds), "-i", source]
    : ["-i", source];
  const filter = [
    "scale=1728:972:flags=lanczos", "setsar=1",
    "pad=1920:1080:96:24:color=0x07111b"
  ].join(",");
  run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", ...input, "-t", String(segment.duration_seconds), "-vf", filter,
    "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", destination]);
}
function render(manifest, options) {
  if (!options.captures || !options.output) fail("--captures and --output are required to render.");
  if (!existsSync(options.captures) || !statSync(options.captures).isDirectory()) fail("Capture directory does not exist.");
  if (!existsSync(defaultFont)) fail(`Caption font is unavailable: ${defaultFont}`);
  if (existsSync(options.output)) fail("Output directory already exists; choose a new destination.");
  if (isWithin(options.output, repositoryRoot)) fail("Output directory must be outside the repository.");
  if (!options.receipt || !existsSync(options.receipt)) fail("A final product-demo capture receipt is required.");
  const inputs = manifest.segments.map((segment) => {
    const file = join(options.captures, segment.file);
    if (!existsSync(file) || !statSync(file).isFile()) fail(`Missing capture ${segment.file}.`);
    const info = probe(file);
    if (segment.kind === "clip" && info.duration + 0.05 < segment.duration_seconds) fail(`${segment.file} is shorter than required.`);
    return { segment, file, ...info, sha256: hash(file) };
  });
  const captureReceipt = JSON.parse(readFileSync(options.receipt, "utf8"));
  validateCaptureReceipt(captureReceipt, options.manifest, inputs);
  const work = mkdtempSync(join(tmpdir(), "loci-demo-"));
  try {
    const parts = inputs.map(({ segment, file }, index) => {
      const destination = join(work, `${String(index).padStart(2, "0")}-${segment.id}.mp4`);
      normalise(segment, file, destination);
      return destination;
    });
    const ffmpegInputs = parts.flatMap((file) => ["-i", file]);
    let prior = "[0:v]";
    let offset = manifest.segments[0].duration_seconds - manifest.output.transition_seconds;
    let filter = "";
    for (let index = 1; index < manifest.segments.length; index += 1) {
      const output = `[xfade${index}]`;
      filter += `${prior}[${index}:v]xfade=transition=fade:duration=${manifest.output.transition_seconds}:offset=${offset.toFixed(2)}${output};`;
      prior = output;
      offset += manifest.segments[index].duration_seconds - manifest.output.transition_seconds;
    }
    // Captions are applied after image crossfades. Adjacent windows meet at each
    // crossfade midpoint, so no two captions dissolve into one another.
    const midpoint = manifest.output.transition_seconds / 2;
    const starts = manifest.segments.map((_, index) => manifest.segments.slice(0, index)
      .reduce((total, item) => total + item.duration_seconds, 0) - index * manifest.output.transition_seconds);
    const totalDuration = starts.at(-1) + manifest.segments.at(-1).duration_seconds;
    for (let index = 0; index < manifest.segments.length; index += 1) {
      const start = index === 0 ? 0 : starts[index] + midpoint;
      const end = index === manifest.segments.length - 1 ? totalDuration : starts[index + 1] + midpoint;
      const output = index === manifest.segments.length - 1 ? "[video]" : `[caption${index}]`;
      const enabled = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
      filter += `${prior}drawbox=x=96:y=1004:w=1728:h=52:color=0x07111b@0.96:t=fill:${enabled},drawtext=fontfile=${defaultFont}:text='${escapeText(manifest.segments[index].caption)}':fontcolor=white:fontsize=32:x=128:y=1014:shadowcolor=black@0.45:shadowx=1:shadowy=1:${enabled}${output};`;
      prior = output;
    }
    run("mkdir", ["-p", options.output]);
    const video = join(options.output, "loci-product-demo-1080p.mp4");
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2", ...ffmpegInputs, "-filter_complex", filter.slice(0, -1), "-map", "[video]",
      "-r", "30", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-b:v", "3500k", "-maxrate", "4000k", "-bufsize", "8000k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
    const poster = join(options.output, "loci-product-demo-poster.png");
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.8", "-i", video, "-frames:v", "1", poster]);
    const receipt = {
      schema: "loci.product-demo-render-receipt/v1", rendered_at: new Date().toISOString(),
      manifest: { path: options.manifest, sha256: hash(options.manifest) },
      renderer: { path: resolve(import.meta.filename), sha256: hash(resolve(import.meta.filename)) },
      capture_receipt: { path: options.receipt, sha256: hash(options.receipt), public_visual_receipt_sha256: captureReceipt.public_visual_receipt.sha256,
        packaged_app: captureReceipt.app },
      inputs: inputs.map(({ segment, file, sha256, width, height, codec, duration }) => ({ id: segment.id, file, sha256, width, height, codec, input_duration_seconds: duration, used_duration_seconds: segment.duration_seconds, fixture_ref: segment.fixture_ref })),
      output: { video: { file: video, sha256: hash(video), ...probe(video) }, poster: { file: poster, sha256: hash(poster), ...probe(poster) }, audio: "none", transitions: `${manifest.segments.length - 1} crossfades of ${manifest.output.transition_seconds} seconds` }
    };
    writeFileSync(join(options.output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const options = args(process.argv.slice(2));
if (!existsSync(options.manifest)) fail(`Manifest does not exist: ${options.manifest}`);
const manifest = validate(JSON.parse(readFileSync(options.manifest, "utf8")));
if (options.plan) {
  const seconds = manifest.segments.reduce((total, item) => total + item.duration_seconds, 0) - (manifest.segments.length - 1) * manifest.output.transition_seconds;
  process.stdout.write(`${JSON.stringify({ schema: manifest.schema, title: manifest.title, segments: manifest.segments.length, projected_duration_seconds: Number(seconds.toFixed(2)), output: manifest.output }, null, 2)}\n`);
} else render(manifest, options);
