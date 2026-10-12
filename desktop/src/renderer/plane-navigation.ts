/**
 * Pure policy and status helpers for adaptive, source-correct plane navigation.
 *
 * Implements deterministic hysteresis for preview max_edge quality tiers (1024, 512, 256),
 * tracks completed request decode/transfer latency, and formats honest in-viewport status.
 */

export type PreviewTier = 1024 | 512 | 256;

export const PREVIEW_TIERS: readonly PreviewTier[] = [1024, 512, 256] as const;

export interface PlaneNavigationPolicyConfig {
  slowThresholdMs: number;
  fastThresholdMs: number;
  consecutiveFastNeeded: number;
  cooldownMs: number;
  settleDelayMs: number;
}

export const DEFAULT_PLANE_POLICY_CONFIG: PlaneNavigationPolicyConfig = {
  slowThresholdMs: 80,
  fastThresholdMs: 30,
  consecutiveFastNeeded: 4,
  cooldownMs: 200,
  settleDelayMs: 150,
};

export interface PlaneNavigationState {
  currentTier: PreviewTier;
  consecutiveFastCount: number;
  lastDownshiftTime: number;
}

export function createPlaneNavigationState(initialTier: PreviewTier = 1024): PlaneNavigationState {
  return {
    currentTier: initialTier,
    consecutiveFastCount: 0,
    lastDownshiftTime: -Infinity,
  };
}

export function recordLatencySample(
  state: PlaneNavigationState,
  latencyMs: number,
  nowMs: number,
  config: PlaneNavigationPolicyConfig = DEFAULT_PLANE_POLICY_CONFIG,
): { state: PlaneNavigationState; tierChanged: boolean } {
  const { slowThresholdMs, fastThresholdMs, consecutiveFastNeeded, cooldownMs } = config;
  const currentTier = state.currentTier;

  if (latencyMs > slowThresholdMs) {
    let nextTier: PreviewTier = currentTier;
    if (currentTier === 1024) {
      nextTier = 512;
    } else if (currentTier === 512) {
      nextTier = 256;
    }
    const changed = nextTier !== currentTier;
    return {
      state: {
        currentTier: nextTier,
        consecutiveFastCount: 0,
        lastDownshiftTime: changed ? nowMs : state.lastDownshiftTime,
      },
      tierChanged: changed,
    };
  }

  if (latencyMs < fastThresholdMs) {
    const newFastCount = state.consecutiveFastCount + 1;
    const cooldownElapsed = (nowMs - state.lastDownshiftTime) >= cooldownMs;

    if (currentTier < 1024 && newFastCount >= consecutiveFastNeeded && cooldownElapsed) {
      let nextTier: PreviewTier = currentTier;
      if (currentTier === 256) {
        nextTier = 512;
      } else if (currentTier === 512) {
        nextTier = 1024;
      }
      return {
        state: {
          currentTier: nextTier,
          consecutiveFastCount: 0,
          lastDownshiftTime: state.lastDownshiftTime,
        },
        tierChanged: true,
      };
    }

    return {
      state: {
        ...state,
        consecutiveFastCount: newFastCount,
      },
      tierChanged: false,
    };
  }

  // Latency is within nominal range [fastThresholdMs, slowThresholdMs]
  return {
    state: {
      ...state,
      consecutiveFastCount: 0,
    },
    tierChanged: false,
  };
}

export interface PlaneStatusParams {
  displayedZ?: number | null;
  requestedZ: number;
  displayedT?: number | null;
  requestedT?: number;
  hasTDimension?: boolean;
  isStale: boolean;
  isPreview: boolean;
  isRefining: boolean;
  isLoading: boolean;
}

export function formatPlaneNavigationStatus(params: PlaneStatusParams): string | null {
  const {
    displayedZ,
    requestedZ,
    displayedT,
    requestedT,
    hasTDimension = false,
    isStale,
    isPreview,
    isRefining,
    isLoading,
  } = params;

  if (isStale && displayedZ !== null && displayedZ !== undefined) {
    // 1-based user facing plane numbers
    const dispZStr = `Z ${displayedZ + 1}`;
    const reqZStr = `Z ${requestedZ + 1}`;
    if (hasTDimension && requestedT !== undefined && displayedT !== null && displayedT !== undefined && requestedT !== displayedT) {
      return `Showing ${dispZStr}, T ${displayedT + 1} · loading ${reqZStr}, T ${requestedT + 1}`;
    }
    return `Showing ${dispZStr} · loading ${reqZStr}`;
  }

  if (isPreview && isRefining) {
    return "Preview · refining";
  }

  if (isRefining) {
    return "Refining…";
  }

  if (isLoading) {
    return "Preparing view…";
  }

  return null;
}
