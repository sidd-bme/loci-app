import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let rafSequence = 0;

function nearestRank(values, fraction) {
  assert.ok(values.length > 0, "Performance statistics require at least one observation.");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}

export function summarizeFrameIntervals(intervals, label, interactionDurationMs) {
  assert.ok(intervals.length > 0, `${label} did not produce an animation-frame interval.`);
  assert.ok(intervals.every((value) => Number.isFinite(value) && value >= 0),
    `${label} produced an invalid animation-frame interval.`);
  let elapsedMs = 0;
  const indexedIntervals = intervals.map((durationMs, intervalIndex) => {
    const startRelativeMs = elapsedMs;
    elapsedMs += durationMs;
    return {
      interval_index: intervalIndex,
      start_relative_ms: startRelativeMs,
      end_relative_ms: elapsedMs,
      duration_ms: durationMs,
    };
  });
  return {
    label,
    sample_count: intervals.length,
    sample_duration_ms: elapsedMs,
    interaction_duration_ms: interactionDurationMs,
    p50_ms: nearestRank(intervals, 0.5),
    p95_ms: nearestRank(intervals, 0.95),
    p99_ms: nearestRank(intervals, 0.99),
    max_ms: Math.max(...intervals),
    largest_frame_intervals: indexedIntervals
      .sort((left, right) => right.duration_ms - left.duration_ms || left.interval_index - right.interval_index)
      .slice(0, 5),
    relative_time_origin: "first measured requestAnimationFrame callback",
  };
}

/** Measure renderer frame intervals while `interaction` drives the UI through Playwright. */
export async function measureRafDuring(page, label, interaction, { settleFrames = 2 } = {}) {
  const id = `loci-raf-${process.pid}-${++rafSequence}`;
  await page.evaluate(({ id: samplerId, samplerLabel }) => {
    window.__lociQaRafSamplers ??= {};
    const state = { active: true, intervals: [], label: samplerLabel, previous: null };
    window.__lociQaRafSamplers[samplerId] = state;
    const tick = (timestamp) => {
      const current = window.__lociQaRafSamplers?.[samplerId];
      if (!current?.active) return;
      if (current.previous !== null) current.intervals.push(timestamp - current.previous);
      current.previous = timestamp;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { id, samplerLabel: label });

  const started = performance.now();
  let interactionFailure;
  let cleanupFailure;
  let intervals;
  let interactionDurationMs;
  try {
    await interaction();
  } catch (error) {
    interactionFailure = error;
  } finally {
    interactionDurationMs = performance.now() - started;
    try {
      intervals = await page.evaluate(async ({ id: samplerId, settle }) => {
        for (let index = 0; index < settle; index += 1)
          await new Promise((resolve) => requestAnimationFrame(resolve));
        const state = window.__lociQaRafSamplers?.[samplerId];
        if (!state) throw new Error(`Missing animation-frame sampler ${samplerId}.`);
        state.active = false;
        delete window.__lociQaRafSamplers[samplerId];
        return state.intervals;
      }, { id, settle: settleFrames });
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (interactionFailure) throw interactionFailure;
  if (cleanupFailure) throw cleanupFailure;
  return summarizeFrameIntervals(intervals, label, interactionDurationMs);
}

async function processTable() {
  const output = (await run("ps", ["-ww", "-ax", "-o", "pid=,ppid=,rss=,command="])).stdout;
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rss_kb: Number(match[3]), command: match[4] }] : [];
  });
}

function descendants(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const found = [];
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    for (const child of byParent.get(parent) ?? []) {
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

function summarizeRss(samples, intervalMs) {
  assert.ok(samples.length > 0, "Process-tree RSS sampling produced no observations.");
  const field = (name) => samples.map((sample) => sample[name]);
  const summary = (name) => ({
    p50_kb: nearestRank(field(name), 0.5),
    p95_kb: nearestRank(field(name), 0.95),
    peak_kb: Math.max(...field(name)),
  });
  return {
    sampling_interval_ms: intervalMs,
    sample_count: samples.length,
    sample_duration_ms: samples.at(-1).elapsed_ms - samples[0].elapsed_ms,
    launch_process_tree: summary("process_tree_rss_kb"),
    descendants: summary("descendant_rss_kb"),
    matching_workers_aggregate: summary("matching_worker_rss_kb"),
    samples,
  };
}

/** Periodically sample only the launch process and its recursive descendants. */
export async function startProcessTreeRssSampler(rootPid, {
  intervalMs = 200,
  workerCommandIncludes = "-m loci_engine.worker",
} = {}) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "A valid launch process PID is required.");
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs >= 50, "RSS sampling interval must be at least 50 ms.");
  const started = performance.now();
  const samples = [];
  let inFlight = null;
  let firstError = null;

  const takeSample = async () => {
    const rows = await processTable();
    const root = rows.find((row) => row.pid === rootPid);
    if (!root) throw new Error(`Launch process ${rootPid} is absent during RSS sampling.`);
    const children = descendants(rows, rootPid);
    const workers = children.filter((row) => row.command.includes(workerCommandIncludes));
    samples.push({
      elapsed_ms: performance.now() - started,
      process_count: children.length + 1,
      process_tree_rss_kb: root.rss_kb + children.reduce((total, row) => total + row.rss_kb, 0),
      descendant_rss_kb: children.reduce((total, row) => total + row.rss_kb, 0),
      matching_worker_rss_kb: workers.reduce((total, row) => total + row.rss_kb, 0),
      matching_worker_count: workers.length,
      matching_worker_pids: workers.map((row) => row.pid),
    });
  };
  const schedule = () => {
    if (inFlight) return;
    inFlight = takeSample().catch((error) => { firstError ??= error; }).finally(() => { inFlight = null; });
  };
  await takeSample();
  const timer = setInterval(schedule, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      if (inFlight) await inFlight;
      await takeSample().catch((error) => { firstError ??= error; });
      if (firstError) throw firstError;
      return summarizeRss(samples, intervalMs);
    },
  };
}
