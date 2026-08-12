import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type AvatarMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface AvatarStore {
  save(bytes: Uint8Array, mimeType: AvatarMimeType): Promise<{ fileId: string }>;
}

export function createLocalAvatarStore(rootDirectory: string): AvatarStore {
  const root = resolve(rootDirectory);
  return {
    async save(bytes, mimeType) {
      const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
      const fileId = `avatar-${randomUUID()}.${extension}`;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, fileId), Buffer.from(bytes), { flag: "wx", mode: 0o600 });
      return { fileId };
    }
  };
}
