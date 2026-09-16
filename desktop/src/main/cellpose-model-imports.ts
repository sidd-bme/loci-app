import { app, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CellposeModelImportLocation,
  CellposeProfileId,
} from "../shared/contracts";
import { CELLPOSE_MODELS } from "./cellpose-models";

const MODEL_IMPORTS_DIRECTORY = "Model Imports";
const PRIVATE_DIRECTORY_MODE = 0o700;

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The managed model import location is not a safe directory.");
  }
  if (process.platform !== "win32") {
    await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
}

export async function ensureCellposeModelImportDirectory(
  profileId: CellposeProfileId,
): Promise<string> {
  try {
    const importsRoot = path.join(app.getPath("userData"), MODEL_IMPORTS_DIRECTORY);
    await ensurePrivateDirectory(importsRoot);
    const destination = path.join(importsRoot, CELLPOSE_MODELS[profileId].artifactId);
    await ensurePrivateDirectory(destination);
    return destination;
  } catch {
    // Filesystem errors may contain the user's absolute application-data path.
    // Keep that path on the trusted side of the IPC boundary.
    throw new Error("Loci could not prepare its managed model import folder.");
  }
}

export async function cellposeImportDialogDefaultDirectory(
  profileId: CellposeProfileId,
): Promise<string> {
  return ensureCellposeModelImportDirectory(profileId);
}

export async function openCellposeModelImportDirectory(
  profileId: CellposeProfileId,
): Promise<CellposeModelImportLocation> {
  try {
    const model = CELLPOSE_MODELS[profileId];
    const directory = await ensureCellposeModelImportDirectory(profileId);
    const failure = await shell.openPath(directory);
    if (failure) throw new Error("openPath failed");
    return {
      profileId,
      artifactId: model.artifactId,
      displayPath: `${MODEL_IMPORTS_DIRECTORY}/${model.artifactId}`,
    };
  } catch {
    throw new Error("Loci could not open its managed model import folder.");
  }
}
