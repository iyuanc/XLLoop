import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

async function requireDirectory(directory, label) {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`${label} was not generated: ${directory}`);
  }
}

await requireDirectory(standalone, "Next.js standalone output");

const staticSource = path.join(root, ".next", "static");
const staticTarget = path.join(standalone, ".next", "static");
await requireDirectory(staticSource, "Next.js static output");
await mkdir(path.dirname(staticTarget), { recursive: true });
await cp(staticSource, staticTarget, { recursive: true, force: true });

const publicSource = path.join(root, "public");
const publicInfo = await stat(publicSource).catch(() => null);
if (publicInfo?.isDirectory()) {
  await cp(publicSource, path.join(standalone, "public"), {
    recursive: true,
    force: true,
  });
}

console.log("Prepared .next/standalone with static and public assets.");
