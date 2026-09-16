import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
function tokens(block: string) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => [match[1], match[2]]));
}
function luminance(hex: string) {
  const linear = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
describe("theme text contrast", () => {
  for (const theme of ["graphite", "midnight", "paper", "aurora", "ember", "lagoon", "fiji"]) {
    it(`${theme} keeps readable text on its normal and hover surfaces`, () => {
      const colors = tokens(css.match(/:root\s*\{([^}]+)\}/)![1]);
      if (theme !== "graphite") Object.assign(colors, tokens(css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))![1]));
      for (const foreground of ["--ink", "--ink-secondary", "--ink-muted", "--ink-faint"]) {
        for (const background of ["--graphite-900", "--graphite-850", "--graphite-800"]) {
          expect(contrast(colors[foreground], colors[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast("#10201c", colors["--mineral"])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
