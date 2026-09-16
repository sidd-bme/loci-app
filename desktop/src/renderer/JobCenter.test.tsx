// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobSummary } from "../shared/contracts";
import JobCenter, {
  describeJobState,
  groupJobSummaries,
} from "./JobCenter";

afterEach(cleanup);

function job(
  jobId: string,
  state: JobSummary["state"],
  overrides: Partial<JobSummary> = {},
): JobSummary {
  return {
    jobId,
    revision: 1,
    kind: "segment",
    title: `Job ${jobId}`,
    state,
    target: { kind: "local" },
    progress: null,
    publicMessage: "",
    cancellationRequested: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("Job Center snapshot grouping", () => {
  it("groups current and recent jobs without mutating the persisted snapshot order", () => {
    const jobs = [
      job("complete-old", "completed", { updatedAt: "2026-09-01T00:01:00.000Z" }),
      job("running-new", "running", { updatedAt: "2026-09-01T00:09:00.000Z" }),
      job("attention", "needs-attention", { updatedAt: "2026-09-01T00:02:00.000Z" }),
      job("held", "held", { updatedAt: "2026-09-01T00:08:00.000Z" }),
      job("failed-new", "failed", { updatedAt: "2026-09-01T00:10:00.000Z" }),
    ];
    const originalOrder = jobs.map(({ jobId }) => jobId);

    const grouped = groupJobSummaries(jobs);

    expect(grouped.current.map(({ jobId }) => jobId)).toEqual([
      "attention",
      "held",
      "running-new",
    ]);
    expect(grouped.recent.map(({ jobId }) => jobId)).toEqual([
      "failed-new",
      "complete-old",
    ]);
    expect(jobs.map(({ jobId }) => jobId)).toEqual(originalOrder);
  });

  it("bounds recent history while retaining every current snapshot", () => {
    const jobs = [
      job("running", "running"),
      ...Array.from({ length: 20 }, (_, index) => job(
        `completed-${index}`,
        "completed",
        { updatedAt: `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z` },
      )),
    ];
    const grouped = groupJobSummaries(jobs, 3);
    expect(grouped.current).toHaveLength(1);
    expect(grouped.recent.map(({ jobId }) => jobId)).toEqual([
      "completed-19",
      "completed-18",
      "completed-17",
    ]);
  });

  it("translates queue, hold, and failure states into plain language", () => {
    expect(describeJobState(job("local-q", "queued"))).toMatchObject({
      label: "Waiting to start",
      explanation: "Waiting for the current local job to finish.",
    });
    expect(describeJobState(job("vanda-q", "queued", {
      target: { kind: "remote", scheduler: "pbs", label: "Vanda" },
      publicMessage: "Q",
    }))).toMatchObject({
      label: "Waiting to start",
      explanation: "Waiting for Vanda to assign compute resources.",
    });
    expect(describeJobState(job("vanda-h", "held", {
      target: { kind: "remote", scheduler: "pbs", label: "Vanda" },
      publicMessage: "H",
    })).explanation).toContain("scheduler paused this job");
    expect(describeJobState(job("failed", "failed"))).toEqual({
      label: "Couldn’t finish",
      explanation: "The job stopped before producing a verified result.",
      tone: "danger",
    });
  });
});

describe("Job Center drawer", () => {
  it("renders nothing before the durable store has job snapshots", () => {
    const { container } = render(<JobCenter jobs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps a compact live summary and reveals grouped phase details on demand", () => {
    const jobs = [
      job("queued", "queued", {
        title: "Queued plate",
        target: { kind: "remote", scheduler: "pbs", label: "Vanda" },
        publicMessage: "Q",
        updatedAt: "2026-09-01T00:08:00.000Z",
      }),
      job("running", "running", {
        title: "Count plate",
        progress: 0.42,
        publicMessage: "Segmenting image 8 of 20.",
        updatedAt: "2026-09-01T00:09:00.000Z",
      }),
      job("failed", "failed", {
        title: "Earlier batch",
        publicMessage: "The worker stopped before publishing a result.",
        finishedAt: "2026-09-01T00:06:00.000Z",
        updatedAt: "2026-09-01T00:06:00.000Z",
      }),
    ];
    render(<JobCenter jobs={jobs} />);

    const status = screen.getByRole("status", { name: "Background job status" });
    expect(within(status).getByText("Count plate")).toBeVisible();
    // jsdom does not evaluate CSS @media queries; the trigger-state span is rendered
    // regardless of viewport width. Responsive hiding at ≤ 1120px is covered by packaged-app.qa.mjs.
    expect(within(status).getByText("Running")).toBeVisible();
    expect(within(status).getByRole("progressbar", { name: "42 percent" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );

    const trigger = within(status).getByRole("button", { name: /Open Job Center/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const drawer = screen.getByRole("region", { name: "Job Center" });
    expect(within(drawer).getByRole("heading", { name: "Current" })).toBeVisible();
    expect(within(drawer).getByRole("heading", { name: "Recent" })).toBeVisible();
    expect(within(drawer).getByText("Segmenting image 8 of 20.")).toBeVisible();
    expect(within(drawer).getByText("Waiting for Vanda to assign compute resources.")).toBeVisible();
    expect(within(drawer).getByText("Couldn’t finish")).toBeVisible();
    expect(within(drawer).getAllByText("Local")).toHaveLength(2);
    expect(within(drawer).getByText("Vanda")).toBeVisible();
    expect(within(drawer).getByRole("progressbar", { name: "42 percent" })).toBeVisible();
  });

  it("exposes cancel, retry, and open-result actions with stable job identifiers", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onOpenResult = vi.fn().mockResolvedValue(undefined);
    render(
      <JobCenter
        jobs={[
          job("active", "running", { title: "Active analysis", progress: 0.2 }),
          job("failed", "failed", { title: "Failed analysis" }),
          job("complete", "completed", { title: "Completed analysis" }),
        ]}
        onCancel={onCancel}
        onRetry={onRetry}
        onOpenResult={onOpenResult}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Job Center/ }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("active"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancelling…" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith("failed"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retrying…" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Open result" }));
    await waitFor(() => expect(onOpenResult).toHaveBeenCalledWith("complete"));
  });

  it("prevents duplicate actions and reports a safe retryable action error", async () => {
    let rejectRetry!: (error: unknown) => void;
    const retry = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRetry = reject;
    }));
    render(<JobCenter jobs={[job("failed", "failed")]} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: /Open Job Center/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const pending = await screen.findByRole("button", { name: "Retrying…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(retry).toHaveBeenCalledTimes(1);

    rejectRetry(new Error("Private failure at /Volumes/secret/source.tif"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not retry this job. Try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("/Volumes/secret");
  });

  it("offers retry only for explicitly recoverable durable jobs", () => {
    render(
      <JobCenter
        jobs={[
          job("batch", "needs-attention", { title: "Recoverable batch" }),
          job("single", "failed", { title: "Failed single image" }),
        ]}
        onRetry={vi.fn()}
        retryableJobIds={["batch"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Job Center/ }));

    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(within(screen.getByText("Failed single image").closest("li")!).queryByRole(
      "button",
      { name: "Retry" },
    )).not.toBeInTheDocument();
  });

  it("suppresses cancel after a durable cancellation request and returns focus on Escape", () => {
    render(<JobCenter jobs={[job("active", "running", {
      cancellationRequested: true,
      publicMessage: "Cancellation requested; waiting for the executor to acknowledge it.",
    })]} onCancel={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    fireEvent.click(trigger);
    expect(screen.getByText("Cancellation requested")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Job Center" })).not.toBeInTheDocument();
  });

  it("shows only the configured recent window and explains omitted history", () => {
    const jobs = Array.from({ length: 5 }, (_, index) => job(
      `complete-${index}`,
      "completed",
      {
        title: `Completed ${index}`,
        updatedAt: `2026-09-01T00:0${index}:00.000Z`,
      },
    ));
    render(<JobCenter jobs={jobs} recentJobLimit={2} />);
    fireEvent.click(screen.getByRole("button", { name: /Open Job Center/ }));

    const drawer = screen.getByRole("region", { name: "Job Center" });
    expect(within(drawer).getByText("Completed 4")).toBeVisible();
    expect(within(drawer).getByText("Completed 3")).toBeVisible();
    expect(within(drawer).queryByText("Completed 2")).not.toBeInTheDocument();
    expect(within(drawer).getByText("Showing the latest 2 of 5 recent jobs.")).toBeVisible();
  });
});

describe("Job Center trigger accessible name", () => {
  it("contains the title, Completed state, and 0 current jobs for a completed job", () => {
    render(<JobCenter jobs={[job("done", "completed", { title: "Inspect source" })]} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    const label = trigger.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Inspect source/);
    expect(label).toMatch(new RegExp(describeJobState(job("done", "completed")).label));
    expect(label).toMatch(/0 current jobs/);
  });

  it("contains the title, Running state, and 1 current job for a running job", () => {
    render(<JobCenter jobs={[job("active", "running", { title: "Count plate" })]} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    const label = trigger.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Count plate/);
    expect(label).toMatch(new RegExp(describeJobState(job("active", "running")).label));
    expect(label).toMatch(/1 current job\b/);
  });

  it("contains the title and exact state label for a failed job", () => {
    render(<JobCenter jobs={[job("fail", "failed", { title: "Count plate" })]} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    const label = trigger.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Count plate/);
    expect(label).toContain(describeJobState(job("fail", "failed")).label);
    expect(label).toMatch(/0 current jobs/);
  });

  it("contains the title and exact state label for a cancelled job", () => {
    render(<JobCenter jobs={[job("cancel", "cancelled", { title: "Batch run" })]} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    const label = trigger.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Batch run/);
    expect(label).toContain(describeJobState(job("cancel", "cancelled")).label);
    expect(label).toMatch(/0 current jobs/);
  });

  it("contains the title and Waiting-to-start state for a queued job", () => {
    render(
      <JobCenter
        jobs={[
          job("q", "queued", {
            title: "Queued plate",
            target: { kind: "remote", scheduler: "pbs", label: "Vanda" },
          }),
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    const label = trigger.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Queued plate/);
    expect(label).toContain(describeJobState(job("q", "queued")).label);
    expect(label).toMatch(/1 current job\b/);
  });

  it("shows Close and retains title and state when the drawer is open; reverts to Open on close", () => {
    render(<JobCenter jobs={[job("done", "completed", { title: "Inspect source" })]} />);
    const trigger = screen.getByRole("button", { name: /Open Job Center/ });
    fireEvent.click(trigger);
    const openLabel = trigger.getAttribute("aria-label") ?? "";
    expect(openLabel).toMatch(/^Close Job Center/);
    expect(openLabel).toMatch(/Inspect source/);
    expect(openLabel).toContain(describeJobState(job("done", "completed")).label);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-label") ?? "").toMatch(/^Open Job Center/);
  });

  it("uses singular 'job' and plural 'jobs' for current-job count", () => {
    render(
      <JobCenter
        jobs={[
          job("a", "running", { title: "Job A", updatedAt: "2026-09-01T00:02:00.000Z" }),
          job("b", "running", { title: "Job B", updatedAt: "2026-09-01T00:01:00.000Z" }),
        ]}
      />,
    );
    const label = screen.getByRole("button", { name: /Open Job Center/ }).getAttribute("aria-label") ?? "";
    expect(label).toMatch(/2 current jobs/);
  });
});
