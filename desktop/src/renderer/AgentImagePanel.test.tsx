// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentImagePanel } from "./AgentImagePanel";
import type { ResearchDesktopApi } from "../shared/research-contracts";
afterEach(cleanup);
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Test image", metadata: {} };
const selection = { x: 1, y: 2, width: 32, height: 24, t: 0, c: 0, z: 0, level: 0, z_stop: 2 };
const channel = { channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", visible: true, opacity: 1 };
it("exports explicit visible display channels and suppresses obsolete receipt after source switch", async () => {
  let resolve!: (value: unknown) => void;
  const exportVisionHandoff = vi.fn(() => new Promise((done) => { resolve = done; }));
  const onError = vi.fn();
  const props = { api: { exportVisionHandoff } as unknown as ResearchDesktopApi, source, selection,
    channels: [channel, { ...channel, channel: 1, visible: false }], projection: "plane" as const,
    following: false, followBusy: false, onFollowing: vi.fn(), onError };
  const { rerender } = render(<AgentImagePanel {...props} />);
  fireEvent.click(screen.getByText("Export vision handoff"));
  expect(exportVisionHandoff).toHaveBeenCalledWith({ source_id: source.id,
    selection: { x: 1, y: 2, width: 32, height: 24, t: 0, c: 0, z: 0, level: 0 },
    channels: [channel], projection: "plane", max_size: 1536 }, source.sha256);
  rerender(<AgentImagePanel {...props} source={{ ...source, id: "c".repeat(32) }} />);
  resolve({ obsolete: true });
  await waitFor(() => expect(screen.getByText("Export vision handoff")).toBeEnabled());
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps oversize crop limits visible and follow control explicit", () => {
  const following = vi.fn();
  render(<AgentImagePanel api={{} as ResearchDesktopApi} source={source} selection={{ ...selection, width: 4096 }} channels={[channel]}
    projection="plane" following={false} followBusy={false} onFollowing={following} onError={vi.fn()} />);
  expect(screen.getByText("Export vision handoff")).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("2048");
  fireEvent.click(screen.getByLabelText("Follow assistant display"));
  expect(following).toHaveBeenCalledWith(true);
});
