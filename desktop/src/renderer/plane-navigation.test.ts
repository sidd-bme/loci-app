import { describe, expect, it } from "vitest";
import {
  createPlaneNavigationState,
  DEFAULT_PLANE_POLICY_CONFIG,
  formatPlaneNavigationStatus,
  recordLatencySample,
} from "./plane-navigation";

describe("plane-navigation policy helper", () => {
  it("initializes at tier 1024", () => {
    const state = createPlaneNavigationState();
    expect(state.currentTier).toBe(1024);
    expect(state.consecutiveFastCount).toBe(0);
  });

  it("downshifts tier upon slow latency (>80ms)", () => {
    let state = createPlaneNavigationState(1024);

    // Slow sample 100ms at t=100
    const res1 = recordLatencySample(state, 100, 100);
    state = res1.state;
    expect(res1.tierChanged).toBe(true);
    expect(state.currentTier).toBe(512);
    expect(state.lastDownshiftTime).toBe(100);

    // Another slow sample at t=200
    const res2 = recordLatencySample(state, 120, 200);
    state = res2.state;
    expect(res2.tierChanged).toBe(true);
    expect(state.currentTier).toBe(256);
    expect(state.lastDownshiftTime).toBe(200);

    // Another slow sample at t=300 - already at lowest tier (256)
    const res3 = recordLatencySample(state, 90, 300);
    state = res3.state;
    expect(res3.tierChanged).toBe(false);
    expect(state.currentTier).toBe(256);
  });

  it("requires at least 4 consecutive fast samples and cooldown before upshifting", () => {
    let state = createPlaneNavigationState(256);
    state.lastDownshiftTime = 0;

    // Cooldown is 200ms. If fast samples arrive at t=50 (cooldown not elapsed):
    let res = recordLatencySample(state, 20, 50);
    state = res.state;
    expect(state.consecutiveFastCount).toBe(1);
    expect(state.currentTier).toBe(256);

    res = recordLatencySample(state, 15, 60);
    state = res.state;
    expect(state.consecutiveFastCount).toBe(2);

    res = recordLatencySample(state, 25, 70);
    state = res.state;
    expect(state.consecutiveFastCount).toBe(3);

    // 4th fast sample, but cooldown (t=80 - 0 = 80 < 200) not elapsed!
    res = recordLatencySample(state, 10, 80);
    state = res.state;
    expect(state.consecutiveFastCount).toBe(4);
    expect(res.tierChanged).toBe(false);
    expect(state.currentTier).toBe(256);

    // Now after cooldown elapsed (t=250 >= 200): 5th fast sample triggers upshift!
    res = recordLatencySample(state, 15, 250);
    state = res.state;
    expect(res.tierChanged).toBe(true);
    expect(state.currentTier).toBe(512);
    expect(state.consecutiveFastCount).toBe(0);

    // Now need 4 more fast samples to reach 1024
    for (let i = 0; i < 3; i++) {
      res = recordLatencySample(state, 20, 300 + i * 10);
      state = res.state;
      expect(state.currentTier).toBe(512);
    }
    // 4th fast sample at t=350
    res = recordLatencySample(state, 20, 350);
    state = res.state;
    expect(res.tierChanged).toBe(true);
    expect(state.currentTier).toBe(1024);

    // At 1024, fast samples keep it at 1024
    res = recordLatencySample(state, 10, 400);
    expect(res.state.currentTier).toBe(1024);
  });

  it("resets consecutive fast count on nominal or slow sample", () => {
    let state = createPlaneNavigationState(512);
    state = recordLatencySample(state, 20, 0).state;
    expect(state.consecutiveFastCount).toBe(1);
    state = recordLatencySample(state, 20, 10).state;
    expect(state.consecutiveFastCount).toBe(2);

    // Nominal sample (50ms is between 30ms and 80ms)
    state = recordLatencySample(state, 50, 20).state;
    expect(state.consecutiveFastCount).toBe(0);
    expect(state.currentTier).toBe(512);
  });

  it("formats honest in-viewport status strings", () => {
    // Stale display (showing Z 4 while loading Z 9) -> 1-based labels: Z 5 and Z 10
    expect(formatPlaneNavigationStatus({
      displayedZ: 4,
      requestedZ: 9,
      isStale: true,
      isPreview: false,
      isRefining: false,
      isLoading: true,
    })).toBe("Showing Z 5 · loading Z 10");

    // Stale with T dimension
    expect(formatPlaneNavigationStatus({
      displayedZ: 4,
      requestedZ: 9,
      displayedT: 0,
      requestedT: 1,
      hasTDimension: true,
      isStale: true,
      isPreview: false,
      isRefining: false,
      isLoading: true,
    })).toBe("Showing Z 5, T 1 · loading Z 10, T 2");

    // Preview refining
    expect(formatPlaneNavigationStatus({
      requestedZ: 4,
      isStale: false,
      isPreview: true,
      isRefining: true,
      isLoading: true,
    })).toBe("Preview · refining");

    // Settled refining
    expect(formatPlaneNavigationStatus({
      requestedZ: 4,
      isStale: false,
      isPreview: false,
      isRefining: true,
      isLoading: true,
    })).toBe("Refining…");

    // Preparing initial view
    expect(formatPlaneNavigationStatus({
      requestedZ: 0,
      isStale: false,
      isPreview: false,
      isRefining: false,
      isLoading: true,
    })).toBe("Preparing view…");

    // Settled and prepared
    expect(formatPlaneNavigationStatus({
      requestedZ: 0,
      isStale: false,
      isPreview: false,
      isRefining: false,
      isLoading: false,
    })).toBe(null);
  });
});
