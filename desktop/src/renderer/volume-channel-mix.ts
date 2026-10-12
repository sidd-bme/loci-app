import { ColorMixPreset } from "@kitware/vtk.js/Rendering/Core/VolumeProperty/Constants";

export const VOLUME_CHANNEL_COMPOSITING_ALGORITHM = "opacity-weighted-channels/v1" as const;
export const VOLUME_AVERAGE_PROJECTION_ALGORITHM = "sample-distance-weighted-mean/v1" as const;
export type VolumeChannelCompositing = typeof VOLUME_CHANNEL_COMPOSITING_ALGORITHM;

/**
 * GLSL snippet substituted for `//VTK::CustomColorMix` in vtkVolumeFS.glsl.
 *
 * Implements opacity-weighted-channels/v1:
 * For components i in [0..N-1] (up to 4 channels):
 *   q_i = opacity_i * componentWeight_i (including gradient opacity factor if active)
 *   c_i = transferRGB_i (with Phong lighting applied only if vtkNumberOfLights > 0, i.e., Normal Shading)
 * S = sum(q_i)
 * If S <= 0, return vec4(0.0) (transparent black).
 * Otherwise, straight RGB = sum(q_i * c_i) / S, alpha = min(1.0, S).
 *
 * Channel accumulation is order-invariant. Channels with zero opacity, hidden channels,
 * or scalar values at/below window low contribute 0 to the sum and cannot contaminate hue.
 */
export const VOLUME_CUSTOM_COLOR_MIX_GLSL = `
#if defined(EnabledGradientOpacity) || vtkNumberOfLights > 0
  mat4 normalMat = computeMat4Normal(posIS, tValue);
#endif

float totalWeight = 0.0;
vec3 mixedColor = vec3(0.0);

#if vtkNumberOfComponents > 0
  {
    const int c = 0;
    float op0 = getOpacityFromTexture(
        tValue[c], c, volume.transferFunctionsSampleHeight[c]);
    #ifdef EnabledGradientOpacity
      op0 *= computeGradientOpacityFactor(normalMat[c].a, c);
    #endif
    float q0 = op0 * volume.independentComponentMix[c];
    if (q0 > 0.0) {
      vec3 col0 = getColorFromTexture(
          tValue[c], c, volume.transferFunctionsSampleHeight[c]);
      #if vtkNumberOfLights > 0
        col0 = applyLighting(col0, normalMat[c]);
      #endif
      mixedColor += q0 * col0;
      totalWeight += q0;
    }
  }
#endif

#if vtkNumberOfComponents > 1
  {
    const int c = 1;
    float op1 = getOpacityFromTexture(
        tValue[c], c, volume.transferFunctionsSampleHeight[c]);
    #ifdef EnabledGradientOpacity
      op1 *= computeGradientOpacityFactor(normalMat[c].a, c);
    #endif
    float q1 = op1 * volume.independentComponentMix[c];
    if (q1 > 0.0) {
      vec3 col1 = getColorFromTexture(
          tValue[c], c, volume.transferFunctionsSampleHeight[c]);
      #if vtkNumberOfLights > 0
        col1 = applyLighting(col1, normalMat[c]);
      #endif
      mixedColor += q1 * col1;
      totalWeight += q1;
    }
  }
#endif

#if vtkNumberOfComponents > 2
  {
    const int c = 2;
    float op2 = getOpacityFromTexture(
        tValue[c], c, volume.transferFunctionsSampleHeight[c]);
    #ifdef EnabledGradientOpacity
      op2 *= computeGradientOpacityFactor(normalMat[c].a, c);
    #endif
    float q2 = op2 * volume.independentComponentMix[c];
    if (q2 > 0.0) {
      vec3 col2 = getColorFromTexture(
          tValue[c], c, volume.transferFunctionsSampleHeight[c]);
      #if vtkNumberOfLights > 0
        col2 = applyLighting(col2, normalMat[c]);
      #endif
      mixedColor += q2 * col2;
      totalWeight += q2;
    }
  }
#endif

#if vtkNumberOfComponents > 3
  {
    const int c = 3;
    float op3 = getOpacityFromTexture(
        tValue[c], c, volume.transferFunctionsSampleHeight[c]);
    #ifdef EnabledGradientOpacity
      op3 *= computeGradientOpacityFactor(normalMat[c].a, c);
    #endif
    float q3 = op3 * volume.independentComponentMix[c];
    if (q3 > 0.0) {
      vec3 col3 = getColorFromTexture(
          tValue[c], c, volume.transferFunctionsSampleHeight[c]);
      #if vtkNumberOfLights > 0
        col3 = applyLighting(col3, normalMat[c]);
      #endif
      mixedColor += q3 * col3;
      totalWeight += q3;
    }
  }
#endif

if (totalWeight <= 0.0) {
  return vec4(0.0);
}
return vec4(mixedColor / totalWeight, min(1.0, totalWeight));
`;

export interface VtkShaderReplacement {
  shaderType: "Fragment" | "Vertex" | "Geometry";
  originalValue: string;
  replaceFirst: boolean;
  replaceAll: boolean;
  replacementValue: string;
}

// Bounded corrections to the pinned vtk.js Average reducer. The upstream
// reducer divides only RGB (component 4 remains a sum), gives the final sample
// unequal numerator/denominator weights, and attenuates a one-sample mean.
// Additive projection is preserved. These exact anchors are checked against the
// installed upstream shader in source tests so dependency drift fails visibly.
const AVERAGE_REPLACEMENTS = [
  {
    originalValue: `if (raySteps <= 1.0) {
      gl_FragData[0] = getColorForValue(value * raySteps, posVC, posIS);
      return;
    }`,
    replacementValue: `if (raySteps <= 1.0) {
      #if vtkBlendMode == AVERAGE_INTENSITY_BLEND
        gl_FragData[0] = valueWithinScalarRange(value)
          ? getColorForValue(value, posVC, posIS) : vec4(0.0);
      #else
        gl_FragData[0] = getColorForValue(value * raySteps, posVC, posIS);
      #endif
      return;
    }`,
  },
  {
    originalValue: `if (valueWithinScalarRange(value)) {
      sum += value;
      #if vtkBlendMode == AVERAGE_INTENSITY_BLEND
        totalWeight += raySteps - stepsTraveled;
      #endif
    }`,
    replacementValue: `if (valueWithinScalarRange(value)) {
      #if vtkBlendMode == AVERAGE_INTENSITY_BLEND
        float finalWeight = max(0.0, raySteps - stepsTraveled);
        sum += value * finalWeight;
        totalWeight += finalWeight;
      #else
        sum += value;
      #endif
    }`,
  },
  {
    originalValue: "sum /= vec4(totalWeight, totalWeight, totalWeight, 1.0);",
    replacementValue: `if (totalWeight <= 0.0) {
        gl_FragData[0] = vec4(0.0);
        return;
      }
      sum /= totalWeight;`,
  },
];

export function getVolumeShaderReplacements(): VtkShaderReplacement[] {
  return [
    { originalValue: "//VTK::CustomColorMix", replacementValue: VOLUME_CUSTOM_COLOR_MIX_GLSL },
    ...AVERAGE_REPLACEMENTS,
  ].map((replacement) => ({
    ...replacement,
    shaderType: "Fragment",
    replaceFirst: false,
    replaceAll: false,
  }));
}

/**
 * Configure a vtkVolumeMapper and vtkVolumeProperty to use the approved
 * opacity-weighted-channels/v1 custom color mix via vtk.js's supported extension.
 */
export function configureVolumeChannelColorMix(mapper: any, property: any): void {
  if (typeof property?.setColorMixPreset !== "function" ||
      typeof mapper?.getViewSpecificProperties !== "function" ||
      typeof mapper?.modified !== "function") {
    throw new Error("This renderer does not support the required volume channel compositing.");
  }
  const viewProps = mapper.getViewSpecificProperties();
  if (!viewProps || typeof viewProps !== "object" ||
      (viewProps.OpenGL !== undefined && (!viewProps.OpenGL || typeof viewProps.OpenGL !== "object"))) {
    throw new Error("The volume shader configuration is invalid.");
  }
  const prior = viewProps.OpenGL?.ShaderReplacements ?? [];
  if (!Array.isArray(prior)) throw new Error("The volume shader replacements are invalid.");
  const replacements = getVolumeShaderReplacements();
  const ownedMarkers = new Set(replacements.map(entry => entry.originalValue));
  // Reconfiguration is idempotent; never discard another extension's hooks.
  for (const expected of replacements) {
    if (prior.some((entry: VtkShaderReplacement) => entry.originalValue === expected.originalValue &&
        (entry.replacementValue !== expected.replacementValue || entry.shaderType !== "Fragment" ||
         entry.replaceFirst || entry.replaceAll))) {
      throw new Error("Another shader extension conflicts with volume channel compositing.");
    }
  }
  viewProps.OpenGL = { ...viewProps.OpenGL, ShaderReplacements: [
    ...prior.filter((entry: VtkShaderReplacement) => !ownedMarkers.has(entry.originalValue)),
    ...replacements,
  ] };
  property.setColorMixPreset(ColorMixPreset.CUSTOM);
  mapper.modified();
}

export type ChannelSample = {
  opacity: number;
  weight: number;
  colorRgb: [number, number, number];
  litColorRgb?: [number, number, number];
};

export type MixedColorResult = {
  rgb: [number, number, number];
  alpha: number;
};

/**
 * Exact CPU reference implementation of the opacity-weighted-channels/v1 formula.
 * Used to qualify mathematical invariants and unit tests.
 */
export function mixVolumeChannelsCpu(
  channels: ChannelSample[],
  shadingEnabled = false,
): MixedColorResult {
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (const ch of channels) {
    const q = ch.opacity * ch.weight;
    if (q > 0) {
      const c = shadingEnabled && ch.litColorRgb ? ch.litColorRgb : ch.colorRgb;
      r += q * c[0];
      g += q * c[1];
      b += q * c[2];
      totalWeight += q;
    }
  }

  if (totalWeight <= 0) {
    return { rgb: [0, 0, 0], alpha: 0 };
  }

  return {
    rgb: [r / totalWeight, g / totalWeight, b / totalWeight],
    alpha: Math.min(1, totalWeight),
  };
}
