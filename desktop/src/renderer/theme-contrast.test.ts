import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCI_THEMES, type LociTheme } from "./preferences";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const workbenchCss = readFileSync(new URL("./ResearchWorkbench.css", import.meta.url), "utf8");
const workflowCss = readFileSync(new URL("./ResearchWorkflowPanel.css", import.meta.url), "utf8");
const summaryBackground = workbenchCss.match(/\.research-stat-item\s*\{[^}]*background:\s*var\((--[\w-]+)\)/)![1];
function tokens(block: string) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
function themeColors(theme: LociTheme) {
  const colors = {
    ...tokens(css.match(/:root\s*\{([^}]+)\}/)![1]),
    ...tokens(css.match(/:root,\s*:root[^{}]+\.canvas-region\s*\{([^}]+)\}/)![1]),
  };
  if (theme !== "graphite") Object.assign(colors, tokens(css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))![1]));
  return colors;
}
function rgb(value: string, colors: Record<string, string>): number[] {
  if (value.startsWith("#")) return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  if (value === "black") return [0, 0, 0];
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias) return rgb(colors[alias[1]], colors);
  const mix = value.match(/^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (.*)\)$/);
  if (mix) {
    const proportion = Number(mix[2]) / 100;
    const background = rgb(mix[3], colors);
    return rgb(mix[1], colors).map((value, channel) => value * proportion + background[channel] * (1 - proportion));
  }
  throw new Error(`Unsupported contrast test color: ${value}`);
}
function luminance(channels: number[]) {
  const linear = channels.map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: number[], b: number[]) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
describe("theme text contrast", () => {
  for (const theme of LOCI_THEMES) {
    it(`${theme} keeps readable text on its normal and hover surfaces`, () => {
      const colors = themeColors(theme);
      const contrastOf = (a: string, b: string) => contrast(rgb(colors[a], colors), rgb(colors[b], colors));
      const surfaces = ["--surface-1", "--surface-2", "--surface-3", "--surface-4", "--surface-hover"];
      const text = ["--ink", "--ink-secondary", "--ink-muted", "--accent", "--state-error", "--state-warning", "--state-processing"];
      expect(new Set(text.slice(0, 3).map((token) => colors[token])).size).toBe(3);
      for (const background of surfaces) {
        for (const foreground of text) {
          expect(contrastOf(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastOf("--focus", background), `focus on ${background}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrastOf("--border-control", "--surface-2"), "field border against its fill").toBeGreaterThanOrEqual(3);
      for (const background of ["--selection", "--action-background", "--action-hover", "--action-pressed"]) {
        expect(contrastOf("--action-foreground", background), `action text on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const foreground of ["--ink", "--ink-muted"]) {
        expect(contrastOf(foreground, summaryBackground), `quantitative summary ${foreground}`).toBeGreaterThanOrEqual(4.5);
      }
      const workflowHover = workflowCss.match(/button\.workflow-run:hover:not\(:disabled\)\s*\{([^}]+)\}/)?.[1] ?? "";
      expect(workflowHover).toContain("color: var(--action-foreground)");
      expect(workflowHover).toContain("background: var(--action-hover)");
    });
  }

  it("uses pure black for the Black base and image surround with neutral stepped surfaces", () => {
    const colors = themeColors("black");
    for (const background of ["--surface-1", "--canvas", "--image-stage-background"]) {
      expect(rgb(colors[background], colors)).toEqual([0, 0, 0]);
    }
    const surfaces = ["--surface-2", "--surface-3", "--surface-4", "--surface-hover", "--surface-pressed"]
      .map((token) => rgb(colors[token], colors));
    const steps = surfaces.map(([red, green, blue]) => {
      expect([green, blue]).toEqual([red, red]);
      return red;
    });
    expect(steps.every((value, index) => value > (steps[index - 1] ?? 0) && value < 64)).toBe(true);
    const graphite = themeColors("graphite");
    expect(rgb(graphite["--image-stage-background"], graphite)).toEqual([21, 21, 21]);
  });
});
