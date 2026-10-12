import type { ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";

// Display only: this exact authored fixture has background 0 and values 100/150/200.
// Never derive a scientific recipe or a generic source range from this preset.
export const FIRST_STUDY_SOURCE_SHA256 = "d27353dd20413c27d1baac4b53b5eb6768b94691fd189385edbea737e7700ff4";

export function firstStudyDisplayChannels(
  project: ResearchSnapshot["project"], source: ResearchSource, defaults: ViewerChannel[],
): ViewerChannel[] | null {
  const example = project.first_study;
  if (example?.example_id !== "synthetic-shapes-v1" || example.source_id !== source.id ||
      example.source_sha256 !== source.sha256 || source.sha256 !== FIRST_STUDY_SOURCE_SHA256 ||
      defaults.length !== 1 || defaults[0].channel !== 0) return null;
  return defaults.map((channel) => ({ ...channel, low: 0, high: 200 }));
}
