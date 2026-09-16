// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import { ResearchRemotePanel } from "./ResearchRemotePanel";

afterEach(cleanup);

const source = {
  id: "a".repeat(32),
  name: "Exact image",
  sha256: "b".repeat(64),
  size_bytes: 1234,
  metadata: { format: "OME-TIFF" },
} as ResearchSource & { size_bytes: number };
const selection: ResearchSelection = { x: 1, y: 2, width: 10, height: 12, t: 0, c: 0, z: 0, level: 0 };
const recipe: ResearchRecipe = {
  steps: [],
  segmentation: { method: "components", threshold: 50 },
  measurement_channels: [0],
  gates: [],
  working_bytes: 1024,
};
const profile = {
  alias: "vanda",
  revision: 1,
  scheduler: "pbspro",
  allow_direct_compute: false,
  remote_input_root_count: 1,
  runtime_ready: true,
  resources: { cpus: 2, memory_mb: 4096, wall_minutes: 30, gpus: 0 },
  connection: { host_key_sha256: "SHA256:x", runtime_version: "Python fixture" },
};

function api(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function renderPanel(execute: ResearchDesktopApi["execute"], onResults = vi.fn()) {
  render(<ResearchRemotePanel api={api(execute)} sources={[source]} selection={selection} recipe={recipe} onResults={onResults} />);
  return onResults;
}

describe("ResearchRemotePanel", () => {
  it("saves an exact direct profile only with the standalone compute declaration", async () => {
    const execute = vi.fn((operation: string) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [] });
      return Promise.resolve({ profile: { ...profile, scheduler: "direct", allow_direct_compute: true } });
    });
    renderPanel(execute);
    await screen.findByText("Saved remote state loaded.");
    fireEvent.change(screen.getByLabelText("Known host lookup"), { target: { value: "vanda.example" } });
    fireEvent.change(screen.getByLabelText("Known hosts file"), { target: { value: "/Users/me/.ssh/known_hosts" } });
    fireEvent.change(screen.getByLabelText("Host key fingerprint"), { target: { value: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } });
    fireEvent.change(screen.getByLabelText("Remote runtime Python"), { target: { value: "/opt/loci/bin/python" } });
    fireEvent.change(screen.getByLabelText("Remote project root"), { target: { value: "/home/me/loci-projects" } });
    fireEvent.change(screen.getByLabelText("Remote output root"), { target: { value: "/scratch/me/loci-output" } });
    fireEvent.change(screen.getByLabelText("Permitted remote input roots"), { target: { value: "/data/lab/images\n/data/lab/archive" } });
    fireEvent.change(screen.getByLabelText("Remote scheduler"), { target: { value: "direct" } });
    fireEvent.click(screen.getByLabelText("Approve standalone direct compute host"));
    fireEvent.click(screen.getByText("Save exact profile"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("remote_profile_save", expect.objectContaining({
      scheduler: "direct", allow_direct_compute: true, scheduler_bin_dir: null, queue: null,
      remote_input_roots: ["/data/lab/images", "/data/lab/archive"], expected_revision: 0,
    })));
  });

  it("stages current selection and recipe with exact authority and remote mapping", async () => {
    const run = { request_key: "c".repeat(32), request_sha256: "d".repeat(64), alias: "vanda", state: "staged", remote_state: "reserved", remote_job_id: null, status_detail: null, outputs: null, attachment: null, remote_cleanup: null };
    const execute = vi.fn((operation: string) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [profile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [] });
      return Promise.resolve({ run });
    });
    renderPanel(execute);
    await screen.findByText("Saved remote state loaded.");
    fireEvent.change(screen.getByLabelText("Remote request key"), { target: { value: run.request_key } });
    fireEvent.click(screen.getByLabelText("Use remote copy for Exact image"));
    fireEvent.change(screen.getByLabelText("Remote relative path for Exact image"), { target: { value: "cohort/image.ome.tif" } });
    fireEvent.click(screen.getByLabelText("Approve exact source scope"));
    fireEvent.click(screen.getByText("Stage exact request"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("remote_stage", {
      alias: "vanda",
      request_key: run.request_key,
      sources: [{ source_id: source.id, remote_input: { root_index: 0, relative_path: "cohort/image.ome.tif", source_sha256: source.sha256, size_bytes: 1234 } }],
      tasks: [{ task_id: `${run.request_key.slice(0, 24)}00000001`, source_id: source.id, selection, recipe }],
      transfer_authority: { approved: true, scope: "remote-run-recipe", destination_alias: "vanda", source_ids: [source.id] },
    }));
  });

  it("stages an exact v2 Cellpose CUDA task only against a GPU profile", async () => {
    const run = { request_key: "7".repeat(32), request_sha256: "8".repeat(64), alias: "vanda", state: "staged", remote_state: "reserved", remote_job_id: null, status_detail: null, outputs: null, attachment: null, remote_cleanup: null };
    const gpuProfile = { ...profile, resources: { ...profile.resources, gpus: 1 } };
    const execute = vi.fn((operation: string) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [gpuProfile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [] });
      return Promise.resolve({ run });
    });
    renderPanel(execute);
    await screen.findByText("Saved remote state loaded.");
    fireEvent.change(screen.getByLabelText("Remote request key"), { target: { value: run.request_key } });
    fireEvent.change(screen.getByLabelText("Remote task type"), { target: { value: "cellpose" } });
    fireEvent.click(screen.getByLabelText("Approve exact source scope"));
    fireEvent.click(screen.getByText("Stage exact request"));

    await waitFor(() => expect(execute).toHaveBeenCalledWith("remote_stage", expect.objectContaining({
      request_key: run.request_key,
      tasks: [{
        task_id: `${run.request_key.slice(0, 24)}00000001`,
        source_id: source.id,
        operation: "run_cellpose",
        selection,
        cellpose: expect.objectContaining({
          profile_id: "cellpose-sam-v2",
          package_version: "4.2.1.1",
          artifact_id: "cpsam_v2",
          model_sha256: "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667",
          model_size_bytes: 1_233_586_851,
          requested_device: "cuda",
          allow_cpu_fallback: false,
          rights_basis: "noncommercial-research",
          measurement_channels: [0],
          gates: [],
          working_bytes: 1024,
          settings: expect.objectContaining({ device: "cuda", max_edge_px: 1000, batch_size: 8 }),
        }),
      }],
    })));
  });

  it("attaches results and removes only the exact attached run identity", async () => {
    const attached = { request_key: "e".repeat(32), request_sha256: "f".repeat(64), alias: "vanda", state: "attached", remote_state: "finished", remote_job_id: "123.server", status_detail: null, outputs: [], attachment: { schema: "receipt" }, remote_cleanup: null };
    const retrieved = { ...attached, state: "retrieved", attachment: null };
    const execute = vi.fn((operation: string) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [profile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [retrieved] });
      if (operation === "remote_attach") return Promise.resolve({ run: attached, attachment: attached.attachment });
      if (operation === "remote_remove_owned") return Promise.resolve({ run: { ...attached, state: "cleaned", remote_cleanup: { state: "cleaned" } } });
      return Promise.resolve({});
    });
    const onResults = renderPanel(execute);
    await screen.findByText("Saved remote state loaded.");
    fireEvent.click(screen.getByText("Attach unreviewed results"));
    await waitFor(() => expect(onResults).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("Approve owned remote cleanup"));
    fireEvent.click(screen.getByText("Remove identity-bound owned data"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("remote_remove_owned", {
      alias: "vanda", request_key: attached.request_key, request_sha256: attached.request_sha256, cleanup_authorized: true,
    }));
  });

  it("shows saved resources and exact attached runtime without inferring a device", async () => {
    const localResultId = "1".repeat(32);
    const attached = {
      request_key: "e".repeat(32), request_sha256: "f".repeat(64), alias: "vanda",
      state: "cleaned", remote_state: "finished", remote_job_id: "1354725.stdct-mgmt-02",
      status_detail: "job_state = F\nExit_status = 0", resources: {
        cpus: 1, memory_mb: 4096, wall_minutes: 5, gpus: 0,
      }, outputs: [{ relative_path: "results.zip", sha256: "2".repeat(64), size_bytes: 806293 }],
      attachment: { schema: "loci.remote-results-attachment/v1", task_results: [{
        local_result_id: localResultId,
      }] }, remote_cleanup: { state: "cleaned" },
    };
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [profile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [attached] });
      if (operation === "result") {
        expect(request).toEqual({ result_id: localResultId, offset: 0, limit: 1 });
        return Promise.resolve({ provenance: { runtime: {
          backend: "numpy-scipy-cpu", requested_device: "auto", resolved_device: "cpu",
          fallback_reason: null,
        } } });
      }
      return Promise.resolve({});
    });
    renderPanel(execute);

    expect(await screen.findByText("Saved requested resources: 2 CPU · 4096 MiB · 0 GPU · 30 min")).toBeVisible();
    expect(screen.getByText("Run requested resources: 1 CPU · 4096 MiB · 0 GPU · 5 min")).toBeVisible();
    const runtime = await screen.findByLabelText("Attached result runtime");
    expect(runtime).toHaveTextContent("Requested deviceauto");
    expect(runtime).toHaveTextContent("Resolved devicecpu");
    expect(runtime).toHaveTextContent("Fallbacknone");
  });

  it("shows unknown when an attached result has no runtime provenance", async () => {
    const attached = {
      request_key: "3".repeat(32), request_sha256: "4".repeat(64), alias: "vanda",
      state: "attached", remote_state: "finished", remote_job_id: "123.server",
      status_detail: null, resources: { cpus: 1, memory_mb: 2048, wall_minutes: 5, gpus: 0 },
      outputs: [], attachment: { task_results: [{ local_result_id: "5".repeat(32) }] },
      remote_cleanup: null,
    };
    const execute = vi.fn((operation: string) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [profile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [attached] });
      if (operation === "result") return Promise.resolve({ provenance: {} });
      return Promise.resolve({});
    });
    renderPanel(execute);

    expect(await screen.findByText("Attached result runtime: unknown")).toBeVisible();
    expect(screen.queryByText("Resolved devicecpu")).not.toBeInTheDocument();
  });

  it("shows the nested Cellpose inference runtime instead of its CPU measurement engine", async () => {
    const first = "6".repeat(32);
    const second = "7".repeat(32);
    const attached = {
      request_key: "8".repeat(32), request_sha256: "9".repeat(64), alias: "vanda",
      state: "attached", remote_state: "finished", remote_job_id: "456.server",
      status_detail: null, resources: { cpus: 1, memory_mb: 8192, wall_minutes: 5, gpus: 1 },
      outputs: [], attachment: { task_results: [
        { local_result_id: first }, { local_result_id: second },
      ] }, remote_cleanup: null,
    };
    let resolveFirst: (value: unknown) => void = () => undefined;
    let resolveSecond: (value: unknown) => void = () => undefined;
    const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
    const secondResult = new Promise((resolve) => { resolveSecond = resolve; });
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "remote_profile_list") return Promise.resolve({ profiles: [profile] });
      if (operation === "remote_run_list") return Promise.resolve({ runs: [attached] });
      if (operation === "result") return request.result_id === first ? firstResult : secondResult;
      return Promise.resolve({});
    });
    renderPanel(execute);

    const selector = await screen.findByLabelText("Attached runtime result");
    expect(selector).toHaveValue(first);
    fireEvent.change(selector, { target: { value: second } });
    await waitFor(() => expect(execute).toHaveBeenCalledWith(
      "result", { result_id: second, offset: 0, limit: 1 },
    ));
    resolveSecond({ provenance: { runtime: {
      cellpose: {
        package: { name: "cellpose", version: "4.2.1.1" },
        requested_device: "cuda", resolved_device: "cuda", fallback_reason: null,
      },
      torch_version: "2.10.0+cu128",
      engine: {
        backend: "numpy-scipy-cpu", requested_device: "auto", resolved_device: "cpu",
        fallback_reason: null,
      },
    } } });
    const runtime = await screen.findByLabelText("Attached result runtime");
    expect(runtime).toHaveTextContent("Backendcellpose 4.2.1.1 · PyTorch 2.10.0+cu128");
    expect(runtime).toHaveTextContent("Requested devicecuda");
    expect(runtime).toHaveTextContent("Resolved devicecuda");
    expect(runtime).toHaveTextContent("Fallbacknone");
    expect(runtime).not.toHaveTextContent("numpy-scipy-cpu");
    resolveFirst({ provenance: { runtime: {
      requested_device: "cpu", resolved_device: "cpu", fallback_reason: null,
    } } });
    await waitFor(() => expect(runtime).toHaveTextContent("Resolved devicecuda"));
  });
});
