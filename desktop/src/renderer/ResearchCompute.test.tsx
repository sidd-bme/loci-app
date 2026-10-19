// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchBatchTask, ResearchDesktopApi } from "../shared/research-contracts";
import ComputeSettings from "./ComputeSettings";
import { notifyComputeTargetsChanged } from "./compute-target-events";
import { activeComputeRun, computeState, ResearchComputeControl, ResearchComputeJobs, useResearchCompute, type ResearchComputeController } from "./ResearchCompute";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Synthetic field", size_bytes: 1024, metadata: {} };
const tasks: ResearchBatchTask[] = [{ operation: "run_recipe", source: { id: source.id, sha256: source.sha256 },
  request: { source_id: source.id, selection: { x: 0, y: 0, width: 12, height: 12, c: 0, t: 0, z: 0, level: 0 }, recipe: {} } }];
const profile = { alias: "vanda", revision: 1, runtime_ready: true, readiness_checked_at: "2026-10-17T00:00:00Z",
  resources: { cpus: 2, memory_mb: 4096, wall_minutes: 30, gpus: 0 } };
const run = { alias: "vanda", request_key: "d".repeat(32), state: "submitted", remote_state: "queued", automatic: true,
  cancel_requested: false, updated_at: "2026-10-17T00:00:00Z", task_ids: ["1".repeat(32)], source_ids: [source.id], status_detail: null, attachment: null };
function api(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return { execute, createStudy: vi.fn(), openStudy: vi.fn(), addSources: vi.fn(), getSnapshot: vi.fn(),
    cancelJob: vi.fn(), reviewResult: vi.fn(), exportResult: vi.fn() };
}
const base = { enabled: true, projectId: "e".repeat(32), scope: 0, suspended: false, onAttached: vi.fn().mockResolvedValue(undefined) };

it("keeps full redacted failure status collapsed until the native disclosure is opened", async () => {
  const fullStatus = "Job Id: 123.fixture\n    job_state = F\n    output = [redacted]\n" + "    scheduler diagnostic\n".repeat(150);
  const failed = { ...run, state: "failed", remote_state: "failed", status_detail: fullStatus };
  const execute = vi.fn(async (operation: string) => operation === "remote_profile_list" ? { profiles: [] } : { runs: [failed] });
  const bridge = api(execute);
  function Harness() {
    const compute = useResearchCompute({ ...base, api: bridge });
    return <ResearchComputeJobs compute={compute} onResult={vi.fn()} onError={vi.fn()} />;
  }
  render(<Harness />);
  expect(await screen.findByText("Failed", { exact: true })).toBeVisible();
  const summary = screen.getByText("Failure details", { exact: true });
  const details = summary.closest("details")!;
  const status = screen.getByLabelText("Full redacted failure status");
  expect(details).not.toHaveAttribute("open");
  expect(status).not.toBeVisible();
  expect(status.textContent).toBe(fullStatus);
  summary.focus();
  expect(summary).toHaveFocus();
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  expect(status).toBeVisible();
  expect(status.textContent).toBe(fullStatus);
  status.focus();
  expect(status).toHaveFocus();
  summary.focus();
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
  expect(status).not.toBeVisible();
  expect(screen.getByText("Failed", { exact: true })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
});

it("keeps active and preparing rows concise without failure disclosures", async () => {
  const execute = vi.fn(async (operation: string) => operation === "remote_profile_list" ? { profiles: [] } : { runs: [{ ...run, status_detail: "scheduler diagnostic" }] });
  const bridge = api(execute);
  function Harness() {
    const compute = useResearchCompute({ ...base, api: bridge });
    return <ResearchComputeJobs compute={{ ...compute, preparation: { alias: "vanda", taskCount: 2 } }} onResult={vi.fn()} onError={vi.fn()} />;
  }
  render(<Harness />);
  expect(await screen.findByText("Submitted", { exact: true })).toBeVisible();
  expect(screen.getByText("Preparing remote run", { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByText("Failure details", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText("scheduler diagnostic")).not.toBeInTheDocument();
});

it("refreshes the open study after saved resources and readiness change without losing selections or runs", async () => {
  let saved = { ...profile, id: "c".repeat(32), revision: 8, scheduler: "pbspro", runtime_ready: false };
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [run] };
    if (operation === "remote_analysis_plan") return { plan: { plan_sha256: "f".repeat(64) } };
    return { run };
  });
  const computeTargets = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    if (operation === "list") return { targets: [saved], study_profiles: [] };
    expect(request).toMatchObject({ id: saved.id, revision: saved.revision });
    if (operation === "resources") saved = { ...saved, revision: saved.revision + 1, resources: request.resources as typeof profile.resources };
    if (operation === "test") saved = { ...saved, revision: saved.revision + 1, runtime_ready: true, readiness_checked_at: "2026-10-19T01:00:00Z" };
    return { profile: saved };
  });
  const bridge = { ...api(execute), computeTargets };
  let compute!: ResearchComputeController;
  function Harness() {
    compute = useResearchCompute({ ...base, api: bridge });
    return <><ResearchComputeControl compute={compute} sources={[source]} learned busy={false} onSetup={vi.fn()} />
      <ComputeSettings api={bridge} /></>;
  }
  render(<Harness />);
  await screen.findByRole("option", { name: "vanda · 2 CPU" });
  fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "vanda" } });
  fireEvent.change(screen.getByLabelText("Remote model rights basis"), { target: { value: "written-commercial-clearance" } });
  fireEvent.click(screen.getByRole("button", { name: "Resources" }));
  fireEvent.change(screen.getByLabelText("Resource preset"), { target: { value: "gpu" } });
  fireEvent.click(screen.getByRole("button", { name: "Save resources" }));
  await screen.findByRole("option", { name: "vanda · 1 GPU" });
  expect(screen.getByText(/CUDA required/)).toBeVisible();
  expect(compute.alias).toBe("vanda");
  expect(compute.rights).toBe("written-commercial-clearance");
  expect(compute.runs).toEqual([run]);
  expect(compute.selected).toMatchObject({ revision: 9, runtime_ready: false });
  const learned: ResearchBatchTask[] = [{ ...tasks[0], operation: "cellpose_run" }];
  await act(async () => { await compute.target!.start(learned); });
  expect(computeTargets).toHaveBeenCalledWith("use", { id: saved.id, revision: 9 });
  expect(execute).toHaveBeenCalledWith("remote_analysis_start", expect.objectContaining({
    analysis: expect.objectContaining({ device: "cuda", rights_basis: "written-commercial-clearance", allow_cpu_fallback: false }),
  }));
  fireEvent.click(screen.getByRole("button", { name: "Check runtime" }));
  await waitFor(() => expect(compute.selected).toMatchObject({ revision: 10, runtime_ready: true, readiness_checked_at: "2026-10-19T01:00:00Z" }));
  await act(async () => { await compute.target!.start(learned); });
  expect(computeTargets).toHaveBeenCalledWith("use", { id: saved.id, revision: 10 });
  expect(compute.alias).toBe("vanda");
  expect(compute.rights).toBe("written-commercial-clearance");
  expect(compute.runs).toEqual([run]);
});

it("does not replace updated resources with an older in-flight target refresh", async () => {
  let finishOld!: (value: unknown) => void;
  const execute = vi.fn(async (operation: string) => operation === "remote_profile_list" ? { profiles: [] } : { runs: [] });
  const computeTargets = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue({ targets: [{ ...profile, id: "c".repeat(32), revision: 2, resources: { ...profile.resources, gpus: 1 } }] });
  const bridge = { ...api(execute), computeTargets };
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge }));
  await waitFor(() => expect(finishOld).toBeTypeOf("function"));
  act(() => notifyComputeTargetsChanged());
  await waitFor(() => expect(result.current.profiles[0]?.revision).toBe(2));
  await act(async () => { finishOld({ targets: [{ ...profile, id: "c".repeat(32) }] }); });
  expect(result.current.profiles[0]).toMatchObject({ revision: 2, resources: { gpus: 1 } });
});

it("shows preparation while the start request is blocked, then shows the saved submitted run", async () => {
  let finishStart!: (value: unknown) => void;
  let submitted = false;
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: submitted ? [run] : [] };
    if (operation === "remote_analysis_plan") return { plan: { plan_sha256: "f".repeat(64) } };
    if (operation === "remote_analysis_start") return new Promise(resolve => { finishStart = resolve; });
    throw new Error("Unexpected operation");
  });
  const bridge = api(execute);
  let compute!: ResearchComputeController;
  function Harness() {
    compute = useResearchCompute({ ...base, api: bridge });
    return <ResearchComputeJobs compute={compute} onResult={vi.fn()} onError={vi.fn()} />;
  }
  render(<Harness />);
  await waitFor(() => expect(compute.profiles).toHaveLength(1));
  act(() => compute.setAlias("vanda"));
  let pending!: Promise<void>;
  act(() => { pending = compute.target!.start(tasks); });
  await waitFor(() => expect(finishStart).toBeTypeOf("function"));
  expect(screen.getByRole("status")).toHaveTextContent("Preparing remote run");
  expect(screen.getByText("vanda · 1 analysis task")).toBeVisible();
  expect(screen.queryByText("Running")).not.toBeInTheDocument();
  // The worker is busy transferring; no extra status RPC is queued to poll it.
  expect(execute.mock.calls.filter(([operation]) => operation === "remote_run_list")).toHaveLength(1);
  await act(async () => { submitted = true; finishStart({ run }); await pending; });
  expect(screen.queryByText("Preparing remote run")).not.toBeInTheDocument();
  expect(screen.getByText("Submitted")).toBeVisible();
  expect(compute.runs).toEqual([run]);
});

it("binds an application target to the open study before planning and refuses a stale target", async () => {
  const order: string[] = [];
  const execute = vi.fn(async (operation: string) => {
    order.push(operation);
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [] };
    if (operation === "remote_analysis_plan") return { plan: { plan_sha256: "f".repeat(64) } };
    return { run };
  });
  let stale = false;
  const computeTargets = vi.fn(async (operation: string) => {
    order.push(operation);
    if (operation === "list") return { targets: [{ ...profile, id: "c".repeat(32), revision: 8 }] };
    if (stale) throw new Error("Compute target changed; reload Settings before continuing");
    return { profile };
  });
  const bridge = { ...api(execute), computeTargets };
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge }));
  await waitFor(() => expect(result.current.profiles).toHaveLength(1));
  act(() => result.current.setAlias("vanda"));
  order.length = 0;
  await act(async () => { await result.current.target!.start(tasks); });
  expect(order.indexOf("use")).toBeLessThan(order.indexOf("remote_analysis_plan"));
  expect(computeTargets).toHaveBeenCalledWith("use", { id: "c".repeat(32), revision: 8 });
  stale = true; execute.mockClear();
  await act(async () => { await expect(result.current.target!.start(tasks)).rejects.toThrow("Compute target changed"); });
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_start", expect.anything());
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_plan", expect.anything());
});

it("starts only after the explicit run action and pins the full native task", async () => {
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [] };
    if (operation === "remote_analysis_plan") return { plan: { plan_sha256: "f".repeat(64) } };
    return { run };
  });
  const bridge = api(execute);
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge }));
  await waitFor(() => expect(result.current.profiles).toHaveLength(1));
  act(() => result.current.setAlias("vanda"));
  render(<ResearchComputeControl compute={result.current} sources={[source]} learned={false} busy={false} onSetup={vi.fn()} />);
  expect(screen.getByText(/Run sends Synthetic field in full/)).toHaveTextContent("retrieves and attaches");
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_start", expect.anything());
  await act(async () => { await result.current.target!.start(tasks); });
  const call = execute.mock.calls.find(([operation]) => operation === "remote_analysis_start") as unknown as [string, Record<string, unknown>];
  expect(call[1]).toEqual({ analysis: { project_id: base.projectId, alias: "vanda", request_key: expect.stringMatching(/^[a-f0-9]{32}$/),
    tasks, device: "cpu", rights_basis: null, allow_cpu_fallback: false }, plan_sha256: "f".repeat(64),
    transfer_authorized: true, retrieval_authorized: true, attachment_authorized: true });
});

it("refuses classical work when a selected target changes to GPU resources and pins CUDA for learned work", async () => {
  let gpus = 0;
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [] };
    if (operation === "remote_run_list") return { runs: [] };
    if (operation === "remote_analysis_plan") return { plan: { plan_sha256: "f".repeat(64) } };
    return { run };
  });
  const computeTargets = vi.fn(async (operation: string) => operation === "list"
    ? { targets: [{ ...profile, id: "c".repeat(32), revision: gpus + 1, resources: { ...profile.resources, gpus } }] }
    : { profile });
  const bridge = { ...api(execute), computeTargets };
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge }));
  await waitFor(() => expect(result.current.profiles).toHaveLength(1));
  act(() => result.current.setAlias("vanda"));
  gpus = 1;
  await act(async () => { await result.current.refresh(); });
  render(<ResearchComputeControl compute={result.current} sources={[source]} learned={false} busy={false} onSetup={vi.fn()} />);
  expect(screen.getByRole("option", { name: "vanda · 1 GPU" })).toBeDisabled();
  execute.mockClear(); computeTargets.mockClear();
  await act(async () => { await expect(result.current.target!.start(tasks)).rejects.toThrow("Choose CPU resources for a classical analysis."); });
  expect(execute).not.toHaveBeenCalled();
  expect(computeTargets).not.toHaveBeenCalled();
  const learned: ResearchBatchTask[] = [{ ...tasks[0], operation: "cellpose_run" }];
  await act(async () => { await result.current.target!.start(learned); });
  expect(computeTargets).toHaveBeenCalledWith("use", { id: "c".repeat(32), revision: 2 });
  expect(execute).toHaveBeenCalledWith("remote_analysis_start", expect.objectContaining({
    analysis: expect.objectContaining({ tasks: learned, device: "cuda", allow_cpu_fallback: false, rights_basis: "noncommercial-research" }),
  }));
});

it("recovers saved jobs, distinguishes a lost connection and attaches once", async () => {
  vi.useFakeTimers();
  const advance = vi.fn().mockRejectedValueOnce(new Error("Connection unavailable"))
    .mockResolvedValueOnce({ run: { ...run, state: "finished" } })
    .mockResolvedValueOnce({ run: { ...run, state: "retrieved" } })
    .mockResolvedValue({ run: { ...run, state: "attached", attachment: { task_results: [{ local_result_id: "2".repeat(32) }] } } });
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [run] };
    if (operation === "remote_analysis_advance") return advance();
    throw new Error("Unexpected operation");
  });
  const onAttached = vi.fn().mockResolvedValue(undefined);
  const bridge = api(execute);
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge, onAttached }));
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.errors[run.request_key]).toBe("Connection unavailable");
  expect(result.current.runs[0].state).toBe("submitted");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.runs[0].state).toBe("finished");
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(result.current.runs[0].state).toBe("attached");
  expect(onAttached).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(advance).toHaveBeenCalledTimes(4);
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_start", expect.anything());
});

it("does not start a plan after its study has changed", async () => {
  let finish!: (value: unknown) => void;
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [] };
    if (operation === "remote_analysis_plan") return new Promise(resolve => { finish = resolve; });
    return {};
  });
  const bridge = api(execute);
  const { result, rerender } = renderHook(({ scope }) => useResearchCompute({ ...base, api: bridge, scope }), { initialProps: { scope: 0 } });
  await waitFor(() => expect(result.current.profiles).toHaveLength(1));
  act(() => result.current.setAlias("vanda"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.target!.start(tasks); });
  const rejected = expect(pending).rejects.toThrow("study changed");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  rerender({ scope: 1 });
  await act(async () => { finish({ plan: { plan_sha256: "f".repeat(64) } }); await rejected; });
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_start", expect.anything());
});

it("continues a saved cancellation through reconnection and stops only after confirmation", async () => {
  vi.useFakeTimers();
  const cancelling = { ...run, state: "cancel_requested", cancel_requested: true };
  const cancelled = { ...cancelling, state: "cancelled", remote_state: "failed" };
  expect(activeComputeRun(cancelling)).toBe(true);
  expect(computeState(cancelling)).toBe("Cancellation requested");
  expect(activeComputeRun({ ...cancelling, state: "failed" })).toBe(true);
  const advance = vi.fn().mockRejectedValueOnce(new Error("Connection unavailable"))
    .mockResolvedValue({ run: cancelled });
  const execute = vi.fn(async (operation: string) => {
    if (operation === "remote_profile_list") return { profiles: [profile] };
    if (operation === "remote_run_list") return { runs: [cancelling] };
    if (operation === "remote_analysis_advance") return advance();
    throw new Error("Unexpected operation");
  });
  const onAttached = vi.fn().mockResolvedValue(undefined);
  const bridge = api(execute);
  const { result } = renderHook(() => useResearchCompute({ ...base, api: bridge, onAttached }));
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.runs[0]).toEqual(cancelling);
  expect(result.current.errors[run.request_key]).toBe("Connection unavailable");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.runs[0]).toEqual(cancelled);
  expect(computeState(result.current.runs[0])).toBe("Cancelled");
  expect(activeComputeRun(result.current.runs[0])).toBe(false);
  expect(result.current.errors[run.request_key]).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(advance).toHaveBeenCalledTimes(2);
  expect(onAttached).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalledWith("remote_analysis_start", expect.anything());
});
