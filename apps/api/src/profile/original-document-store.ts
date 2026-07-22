import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RetainedOriginal {
  path: string;
  created: boolean;
}

export interface OriginalDocumentStore {
  retain(fingerprint: string, bytes: Uint8Array): Promise<RetainedOriginal>;
  discardCreated(retained: RetainedOriginal): Promise<void>;
}

export function createLocalOriginalDocumentStore(rootDirectory: string): OriginalDocumentStore {
  const root = resolve(rootDirectory);

  return {
    async retain(fingerprint, bytes) {
      const snapshot = Uint8Array.from(bytes);
      const actualFingerprint = createHash("sha256").update(snapshot).digest("hex");
      if (actualFingerprint !== fingerprint) throw new Error("original document fingerprint mismatch");

      await mkdir(root, { recursive: true });
      const path = join(root, `${fingerprint}.pdf`);
      try {
        const existing = await readFile(path);
        if (!Buffer.from(existing).equals(Buffer.from(snapshot))) {
          throw new Error("retained original does not match its fingerprint");
        }
        return { path, created: false };
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const temporaryPath = join(root, `.${fingerprint}.${randomUUID()}.tmp`);
      const handle = await open(temporaryPath, "wx");
      try {
        await handle.writeFile(snapshot);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await rename(temporaryPath, path);
        return { path, created: true };
      } catch (error) {
        await rm(temporaryPath, { force: true });
        try {
          const existing = await readFile(path);
          if (Buffer.from(existing).equals(Buffer.from(snapshot))) return { path, created: false };
        } catch {
          // Preserve the original rename error when no valid concurrent writer won.
        }
        throw error;
      }
    },
    async discardCreated(retained) {
      if (retained.created) await rm(retained.path, { force: true });
    }
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
