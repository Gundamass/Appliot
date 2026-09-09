import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(repositoryRoot, "apps/synthetic-ats/public");
const target = resolve(
  repositoryRoot,
  process.env.SYNTHETIC_ATS_ASSET_TARGET ?? "apps/api/dist/synthetic-ats-public"
);

assertInsideRepository(source, "synthetic ATS source");
assertInsideRepository(target, "synthetic ATS bundle target");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

function assertInsideRepository(path, label) {
  const pathFromRoot = relative(repositoryRoot, path);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} path escaped repository root`);
  }
}
