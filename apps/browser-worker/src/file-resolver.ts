import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const OPAQUE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function createUploadDirectoryResolver(uploadDirectory: string) {
  const root = resolve(uploadDirectory);
  return async (fileId: string): Promise<string | undefined> => {
    if (!OPAQUE_FILE_ID.test(fileId) || fileId.includes("..")) return undefined;
    const candidate = resolve(root, fileId);
    if (candidate === root || !candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) {
      return undefined;
    }
    try {
      return (await stat(candidate)).isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  };
}
