// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import ComputeSettings from "./ComputeSettings";

afterEach(cleanup);
const target = { id: "a".repeat(32), alias: "fixture", revision: 4, scheduler: "pbspro", runtime_ready: true,
  readiness_checked_at: "2026-10-17T00:00:00Z", resources: { cpus: 2, memory_mb: 4096, wall_minutes: 30, gpus: 0 } };
function renderSettings(service: NonNullable<ResearchDesktopApi["computeTargets"]>) {
  return render(<ComputeSettings api={{ computeTargets: service } as ResearchDesktopApi} />);
}

it("saves an existing study target for reuse without connecting or transferring", async () => {
  let saved = false;
  const service = vi.fn(async (operation: string) => {
    if (operation === "list") return { targets: saved ? [target] : [], study_profiles: [target], study_binding: "study-a" };
    if (operation === "remember") { saved = true; return { profile: target }; }
    throw new Error("Unexpected connection or transfer");
  });
  renderSettings(service);
  fireEvent.click(await screen.findByRole("button", { name: "Save for all studies" }));
  await screen.findByText("fixture is now available in every study.");
  expect(service).toHaveBeenCalledWith("remember", { study_binding: "study-a", id: target.id, revision: 4, expected_revision: 0 });
  expect(within(screen.getByRole("list", { name: "Saved compute targets" })).getByText("fixture")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save for all studies" })).not.toBeInTheDocument();
});

it("refreshes a rejected study row without retrying the same alias in the next study", async () => {
  let current = "study-a";
  let saved = false;
  const service = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    const profile = current === "study-a" ? target : { ...target, resources: { ...target.resources, cpus: 6 } };
    if (operation === "list") return { targets: saved ? [profile] : [], study_profiles: [profile], study_binding: current };
    if (operation === "remember" && request.study_binding === current) { saved = true; return { profile: target }; }
    throw new Error("The study changed. Refresh Settings and select the target again.");
  });
  renderSettings(service);
  const firstButton = await screen.findByRole("button", { name: "Save for all studies" });
  expect(screen.getByText("PBSPRO · 2 CPU · 4 GiB · 30 min")).toBeVisible();
  current = "study-b";
  fireEvent.click(firstButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("The study changed");
  const nextButton = await screen.findByRole("button", { name: "Save for all studies" });
  expect(firstButton).not.toBeInTheDocument();
  expect(nextButton).toBeEnabled();
  expect(screen.getByText("PBSPRO · 6 CPU · 4 GiB · 30 min")).toBeVisible();
  expect(saved).toBe(false);
  fireEvent.click(nextButton);
  await screen.findByText("fixture is now available in every study.");
  expect(service.mock.calls.filter(([op]) => op === "remember").map(([, request]) => request)).toEqual([
    { study_binding: "study-a", id: target.id, revision: 4, expected_revision: 0 },
    { study_binding: "study-b", id: target.id, revision: 4, expected_revision: 0 },
  ]);
});

it("ignores an older pending list after a focus refresh returns another study", async () => {
  let finishFirst!: (response: unknown) => void;
  const service = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValue({ targets: [], study_profiles: [target], study_binding: "study-b" });
  renderSettings(service);
  fireEvent.focus(window);
  const button = await screen.findByRole("button", { name: "Save for all studies" });
  await act(async () => { finishFirst({ targets: [], study_profiles: [target], study_binding: "study-a" }); });
  fireEvent.click(button);
  await screen.findByText("fixture is now available in every study.");
  expect(service).toHaveBeenCalledWith("remember", { study_binding: "study-b", id: target.id, revision: 4, expected_revision: 0 });
});

it("refreshes the bound study row after a notification without moving window focus", async () => {
  const studyEvents = new EventTarget();
  const onStudyChanged = (callback: () => void) => {
    studyEvents.addEventListener("change", callback);
    return () => studyEvents.removeEventListener("change", callback);
  };
  const computeTargets = vi.fn().mockResolvedValueOnce({ targets: [], study_profiles: [target], study_binding: "study-a" });
  render(<ComputeSettings api={{ computeTargets }} onStudyChanged={onStudyChanged} />);
  const old = await screen.findByRole("button", { name: "Save for all studies" });
  const replacement = { ...target, resources: { ...target.resources, cpus: 6 } };
  let finish!: (value: unknown) => void;
  computeTargets.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => { studyEvents.dispatchEvent(new Event("change")); });
  expect(old).toBeDisabled();
  await act(async () => finish({ targets: [], study_profiles: [replacement], study_binding: "study-b" }));
  expect(old).not.toBeInTheDocument();
  expect(screen.getByText("PBSPRO · 6 CPU · 4 GiB · 30 min")).toBeVisible();
});

it("refreshes a reopened pane when an earlier save finishes", async () => {
  let saved = false, finish!: () => void;
  const service = vi.fn(async (operation: string) => {
    if (operation === "list") return { targets: saved ? [target] : [], study_profiles: [target], study_binding: "study-a" };
    if (operation !== "remember") throw new Error("Unexpected operation");
    await new Promise<void>(resolve => { finish = resolve; });
    saved = true;
    return { profile: target };
  });
  const first = renderSettings(service);
  fireEvent.click(await screen.findByRole("button", { name: "Save for all studies" }));
  first.unmount();
  renderSettings(service);
  await screen.findByRole("button", { name: "Save for all studies" });
  await act(async () => finish());
  expect(within(screen.getByRole("list", { name: "Saved compute targets" })).getByText("fixture")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save for all studies" })).not.toBeInTheDocument();
  expect(service.mock.calls.filter(([operation]) => operation === "remember")).toHaveLength(1);
});

it("imports an SSH identity then saves only the explicit setup fields", async () => {
  const draft = { id: "b".repeat(32), revision: 2, alias: "fixture", host_key_sha256: "SHA256:fixture" };
  const service = vi.fn(async (operation: string) => {
    if (operation === "list") return { targets: [], study_profiles: [] };
    if (operation === "import_ssh") return { draft };
    if (operation === "save") return { profile: target };
    throw new Error("Unexpected connection or transfer");
  });
  renderSettings(service);
  const addTarget = screen.getByRole("button", { name: "Add target" });
  await waitFor(() => expect(addTarget).toBeEnabled());
  fireEvent.click(addTarget);
  fireEvent.change(screen.getByLabelText("SSH alias", { exact: true }), { target: { value: "fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Import alias" }));
  await screen.findByLabelText("Loci runtime executable", { exact: true });
  for (const [label, value] of [["Loci runtime executable", "/opt/loci/python"], ["Input workspace", "/work/inputs"], ["Result workspace", "/work/results"]])
    fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  fireEvent.change(screen.getByLabelText("Resource preset"), { target: { value: "gpu" } });
  fireEvent.click(screen.getByRole("button", { name: "Save target" }));
  await screen.findByText("Target saved. Check its runtime before the first run.");
  expect(service).toHaveBeenCalledWith("save", { draft_id: draft.id, draft_revision: 2, expected_revision: 0,
    runtime_python: "/opt/loci/python", remote_project_root: "/work/inputs", remote_output_root: "/work/results",
    scheduler: "pbspro", scheduler_bin_dir: null, queue: null, account: null,
    resources: { cpus: 4, memory_mb: 16384, wall_minutes: 30, gpus: 1 } });
  expect(service.mock.calls.every(([operation]) => ["list", "import_ssh", "save"].includes(operation))).toBe(true);
});

it("retains a rejected stale resource edit and reports failure without claiming it was saved", async () => {
  const service = vi.fn(async (operation: string) => {
    if (operation === "list") return { targets: [target], study_profiles: [] };
    throw new Error("Compute target changed; reload Settings before continuing");
  });
  renderSettings(service);
  fireEvent.click(await screen.findByRole("button", { name: "Resources" }));
  fireEvent.change(screen.getByLabelText("CPU cores"), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "Save resources" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Compute target changed");
  expect(screen.getByLabelText("CPU cores")).toHaveValue(8);
  expect(screen.queryByText("Resources saved for future runs.")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save resources" })).toBeEnabled());
});
