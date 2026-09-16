import { app } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type DialogHistoryKind = "import" | "export";

interface DialogHistory {
  import?: string;
  export?: string;
}

let writeQueue: Promise<void> = Promise.resolve();

const historyPath = () => path.join(app.getPath("userData"), "dialog-history.json");

async function readHistory(): Promise<DialogHistory> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      import: typeof record.import === "string" ? record.import : undefined,
      export: typeof record.export === "string" ? record.export : undefined,
    };
  } catch {
    return {};
  }
}

async function existingDirectory(candidate: string | undefined): Promise<string | undefined> {
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  try {
    const canonical = await fs.realpath(candidate);
    return (await fs.stat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberedDialogDirectory(
  kind: DialogHistoryKind,
): Promise<string | undefined> {
  const history = await readHistory();
  return existingDirectory(history[kind]);
}

export async function rememberDialogDirectory(
  kind: DialogHistoryKind,
  directory: string,
): Promise<void> {
  const canonical = await existingDirectory(directory);
  if (!canonical) return;
  const update = writeQueue.catch(() => undefined).then(async () => {
    const destination = historyPath();
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const history = await readHistory();
    history[kind] = canonical;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(history)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  writeQueue = update;
  await update;
}
