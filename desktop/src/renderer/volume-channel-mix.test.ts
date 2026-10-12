// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { ColorMixPreset } from "@kitware/vtk.js/Rendering/Core/VolumeProperty/Constants";
// @ts-expect-error vtk.js internal module without types
import ShaderProgram from "@kitware/vtk.js/Rendering/OpenGL/ShaderProgram";
// @ts-expect-error vtk.js internal module without types
import vtkVolumeFS from "@kitware/vtk.js/Rendering/OpenGL/glsl/vtkVolumeFS.glsl.js";
import {
  configureVolumeChannelColorMix,
  getVolumeShaderReplacements,
  mixVolumeChannelsCpu,
  VOLUME_CHANNEL_COMPOSITING_ALGORITHM,
  VOLUME_CUSTOM_COLOR_MIX_GLSL,
  type ChannelSample,
} from "./volume-channel-mix";

describe("volume-channel-mix: opacity-weighted-channels/v1 mathematical invariants", () => {
  const magenta: [number, number, number] = [1.0, 0.0, 1.0];
  const green: [number, number, number] = [0.0, 1.0, 0.0];
  const cyan: [number, number, number] = [0.0, 1.0, 1.0];
  const yellow: [number, number, number] = [1.0, 1.0, 0.0];

  it("exports the exact contract algorithm identifier", () => {
    expect(VOLUME_CHANNEL_COMPOSITING_ALGORITHM).toBe("opacity-weighted-channels/v1");
  });

  it("returns transparent black when all channels are transparent or zero opacity", () => {
    const channels: ChannelSample[] = [
      { opacity: 0.0, weight: 1.0, colorRgb: magenta },
      { opacity: 0.0, weight: 1.0, colorRgb: green },
    ];
    const result = mixVolumeChannelsCpu(channels);
    expect(result).toEqual({ rgb: [0, 0, 0], alpha: 0 });
  });

  it("retains pure hue for exclusive single-channel regions without contamination", () => {
    // Channel A has opacity 0.8, Channel B has opacity 0.0 (e.g. below window / zero voxel value)
    const channelAOnly: ChannelSample[] = [
      { opacity: 0.8, weight: 1.0, colorRgb: magenta },
      { opacity: 0.0, weight: 1.0, colorRgb: green },
    ];
    const resultA = mixVolumeChannelsCpu(channelAOnly);
    expect(resultA.rgb[0]).toBeCloseTo(1.0);
    expect(resultA.rgb[1]).toBeCloseTo(0.0);
    expect(resultA.rgb[2]).toBeCloseTo(1.0);
    expect(resultA.alpha).toBeCloseTo(0.8);

    // Channel B has opacity 0.6, Channel A has opacity 0.0
    const channelBOnly: ChannelSample[] = [
      { opacity: 0.0, weight: 1.0, colorRgb: magenta },
      { opacity: 0.6, weight: 1.0, colorRgb: green },
    ];
    const resultB = mixVolumeChannelsCpu(channelBOnly);
    expect(resultB.rgb[0]).toBeCloseTo(0.0);
    expect(resultB.rgb[1]).toBeCloseTo(1.0);
    expect(resultB.rgb[2]).toBeCloseTo(0.0);
    expect(resultB.alpha).toBeCloseTo(0.6);
  });

  it("excludes hidden channels (weight 0) even if their raw opacity is high", () => {
    const channels: ChannelSample[] = [
      { opacity: 0.9, weight: 0.0, colorRgb: magenta }, // hidden
      { opacity: 0.5, weight: 1.0, colorRgb: green },   // visible
    ];
    const result = mixVolumeChannelsCpu(channels);
    expect(result.rgb[0]).toBeCloseTo(0.0);
    expect(result.rgb[1]).toBeCloseTo(1.0);
    expect(result.rgb[2]).toBeCloseTo(0.0);
    expect(result.alpha).toBeCloseTo(0.5);
  });

  it("correctly mixes complementary channels in genuine overlap regions", () => {
    // Equal opacity complementary colors mix to neutral gray
    const overlap: ChannelSample[] = [
      { opacity: 0.5, weight: 1.0, colorRgb: magenta },
      { opacity: 0.5, weight: 1.0, colorRgb: green },
    ];
    const result = mixVolumeChannelsCpu(overlap);
    expect(result.rgb[0]).toBeCloseTo(0.5);
    expect(result.rgb[1]).toBeCloseTo(0.5);
    expect(result.rgb[2]).toBeCloseTo(0.5);
    expect(result.alpha).toBeCloseTo(1.0);
  });

  it("evaluates unequal contributions (e.g. 3:1 ratio) accurately", () => {
    // 3 parts magenta (opacity 0.75), 1 part green (opacity 0.25)
    const unequal: ChannelSample[] = [
      { opacity: 0.75, weight: 1.0, colorRgb: magenta },
      { opacity: 0.25, weight: 1.0, colorRgb: green },
    ];
    const result = mixVolumeChannelsCpu(unequal);
    // Expected straight RGB: (0.75 * [1, 0, 1] + 0.25 * [0, 1, 0]) / 1.0 = [0.75, 0.25, 0.75]
    expect(result.rgb[0]).toBeCloseTo(0.75);
    expect(result.rgb[1]).toBeCloseTo(0.25);
    expect(result.rgb[2]).toBeCloseTo(0.75);
    expect(result.alpha).toBeCloseTo(1.0);
  });

  it("clamps alpha to 1.0 when sum of opacities exceeds 1.0", () => {
    const saturated: ChannelSample[] = [
      { opacity: 0.8, weight: 1.0, colorRgb: magenta },
      { opacity: 0.8, weight: 1.0, colorRgb: green },
    ];
    const result = mixVolumeChannelsCpu(saturated);
    // S = 1.6 > 1.0 -> alpha clamped to 1.0
    expect(result.alpha).toBe(1.0);
    // Normalized color: (0.8 * [1, 0, 1] + 0.8 * [0, 1, 0]) / 1.6 = [0.5, 0.5, 0.5]
    expect(result.rgb[0]).toBeCloseTo(0.5);
    expect(result.rgb[1]).toBeCloseTo(0.5);
    expect(result.rgb[2]).toBeCloseTo(0.5);
  });

  it("is strictly permutation-invariant across channel ordering (2, 3, and 4 channels)", () => {
    const ch4: ChannelSample[] = [
      { opacity: 0.4, weight: 1.0, colorRgb: magenta },
      { opacity: 0.2, weight: 1.0, colorRgb: green },
      { opacity: 0.6, weight: 1.0, colorRgb: cyan },
      { opacity: 0.1, weight: 1.0, colorRgb: yellow },
    ];
    const base = mixVolumeChannelsCpu(ch4);

    // Permutation 1: reversed
    const reversed = mixVolumeChannelsCpu([...ch4].reverse());
    expect(reversed.rgb[0]).toBeCloseTo(base.rgb[0]);
    expect(reversed.rgb[1]).toBeCloseTo(base.rgb[1]);
    expect(reversed.rgb[2]).toBeCloseTo(base.rgb[2]);
    expect(reversed.alpha).toBeCloseTo(base.alpha);

    // Permutation 2: cyclic shift
    const shifted = mixVolumeChannelsCpu([ch4[1], ch4[2], ch4[3], ch4[0]]);
    expect(shifted.rgb[0]).toBeCloseTo(base.rgb[0]);
    expect(shifted.rgb[1]).toBeCloseTo(base.rgb[1]);
    expect(shifted.rgb[2]).toBeCloseTo(base.rgb[2]);
    expect(shifted.alpha).toBeCloseTo(base.alpha);
  });

  it("applies directional lighting only when shading is enabled", () => {
    const unshadedSample: ChannelSample = {
      opacity: 0.8,
      weight: 1.0,
      colorRgb: [1.0, 0.0, 0.0],
      litColorRgb: [0.5, 0.0, 0.0],
    };
    // With shading false, unshaded color is used
    const unshadedResult = mixVolumeChannelsCpu([unshadedSample], false);
    expect(unshadedResult.rgb[0]).toBeCloseTo(1.0);

    // With shading true, lit color is used
    const shadedResult = mixVolumeChannelsCpu([unshadedSample], true);
    expect(shadedResult.rgb[0]).toBeCloseTo(0.5);
  });
});

describe("volume-channel-mix: shader hook and vtk.js integration", () => {
  it("generates valid shader replacements targeting //VTK::CustomColorMix", () => {
    const replacements = getVolumeShaderReplacements();
    expect(replacements).toHaveLength(4);
    expect(replacements[0].shaderType).toBe("Fragment");
    expect(replacements[0].originalValue).toBe("//VTK::CustomColorMix");
    expect(replacements[0].replacementValue).toContain("totalWeight");
    expect(replacements[0].replacementValue).toContain("mixedColor");
    expect(replacements[0].replacementValue).toContain("return vec4(mixedColor / totalWeight, min(1.0, totalWeight));");
    expect(replacements[0].replacementValue).toContain("return vec4(0.0);");
  });

  it("successfully substitutes into pinned vtkVolumeFS.glsl upstream shader template", () => {
    const replacements = getVolumeShaderReplacements();
    let shader = vtkVolumeFS;
    for (const replacement of replacements) {
      expect(shader.split(replacement.originalValue)).toHaveLength(2);
      const result = ShaderProgram.substitute(shader, replacement.originalValue,
        replacement.replacementValue, replacement.replaceAll);
      expect(result.replace).toBe(true);
      shader = result.result;
    }
    expect(shader).toContain(VOLUME_CUSTOM_COLOR_MIX_GLSL);
    expect(shader).not.toContain("//VTK::CustomColorMix");
    expect(shader).not.toContain("sum /= vec4(totalWeight, totalWeight, totalWeight, 1.0)");
    expect(shader).toContain("sum += value * finalWeight");
    expect(shader).toContain("totalWeight += finalWeight");
    expect(shader).toContain("sum /= totalWeight");

  });

  it("configures mapper and property with ColorMixPreset.CUSTOM and shader replacements", () => {
    let modifiedCalled = false;
    const mockMapper = {
      viewSpecificProperties: {} as any,
      getViewSpecificProperties() {
        return this.viewSpecificProperties;
      },
      modified() {
        modifiedCalled = true;
      },
    };

    let setPresetValue: number | undefined;
    const mockProperty = {
      setColorMixPreset(preset: number) {
        setPresetValue = preset;
      },
    };

    configureVolumeChannelColorMix(mockMapper, mockProperty);

    expect(setPresetValue).toBe(ColorMixPreset.CUSTOM);
    expect(mockMapper.viewSpecificProperties.OpenGL?.ShaderReplacements).toEqual(
      getVolumeShaderReplacements(),
    );
    expect(modifiedCalled).toBe(true);
  });
});


describe("volume compositing fails closed", () => {
  it("rejects unsupported APIs before mutating the property", () => {
    const property = { setColorMixPreset: vi.fn() };
    expect(() => configureVolumeChannelColorMix({}, property)).toThrow(/required volume channel/);
    expect(property.setColorMixPreset).not.toHaveBeenCalled();
  });

  it("preserves unrelated hooks and supports repeated configuration", () => {
    const other = { shaderType: "Fragment", originalValue: "//other", replacementValue: "test" };
    const props = { OpenGL: { ShaderReplacements: [other] } };
    const mapper = { getViewSpecificProperties: () => props, modified: vi.fn() };
    const property = { setColorMixPreset: vi.fn() };
    configureVolumeChannelColorMix(mapper, property);
    configureVolumeChannelColorMix(mapper, property);
    expect(props.OpenGL.ShaderReplacements).toEqual([other, ...getVolumeShaderReplacements()]);
  });

  it("rejects a conflicting hook before changing renderer state", () => {
    const prior = [{ ...getVolumeShaderReplacements()[0], replacementValue: "wrong" }];
    const props = { OpenGL: { ShaderReplacements: prior } };
    const mapper = { getViewSpecificProperties: () => props, modified: vi.fn() };
    const property = { setColorMixPreset: vi.fn() };
    expect(() => configureVolumeChannelColorMix(mapper, property)).toThrow(/conflicts/);
    expect(props.OpenGL.ShaderReplacements).toBe(prior);
    expect(property.setColorMixPreset).not.toHaveBeenCalled();
  });
});
