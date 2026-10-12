import { describe, expect, it, vi } from "vitest";
import { dispatchWorkbenchCommand, subscribeWorkbenchCommands } from "./workbench-commands";

describe("workbench commands", () => {
  it("reports unavailable ownership rather than pretending to deliver a command", () => {
    expect(dispatchWorkbenchCommand("open-study")).toBe(false);
  });

  it("delivers only typed local commands and cleans up subscriptions", () => {
    const listener = vi.fn();
    const stop = subscribeWorkbenchCommands(listener);
    try {
      for (const command of ["open-images", "open-folder", "open-study", "save-study"] as const)
        expect(dispatchWorkbenchCommand(command)).toBe(true);
      expect(listener.mock.calls.map(([command]) => command)).toEqual([
        "open-images", "open-folder", "open-study", "save-study",
      ]);
    } finally { stop(); }
    expect(dispatchWorkbenchCommand("save-study")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
