import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Decision 0012: prepares the build context for `lk agent deploy`. LiveKit
// Cloud builds the directory it is given, so it receives only the agent's
// sources, the TypeScript projects, the root manifest and lockfile and the
// agent Dockerfile. An existing livekit.toml (written by `lk agent create`) is
// kept; everything else in the directory is replaced.
//
//   node scripts/stage-transcriber.ts ../yaparena-transcriber-deploy

const repository = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/stage-transcriber.ts <directory>");
  process.exit(2);
}
const out = path.resolve(target);
if (out === repository.replace(/\/$/, "") || out.startsWith(repository))
  throw new Error("stage the deploy context outside the repository");
const files: [string, string][] = [
  ["deploy/transcriber/Dockerfile", "Dockerfile"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["tsconfig.json", "tsconfig.json"],
  ["tsconfig.transcriber.json", "tsconfig.transcriber.json"],
  [
    "src/features/transcription/protocol.ts",
    "src/features/transcription/protocol.ts",
  ],
  ["src/features/transcription/agent", "src/features/transcription/agent"],
];
await mkdir(out, { recursive: true });
for (const entry of await readdir(out))
  if (entry !== "livekit.toml")
    await rm(path.join(out, entry), { recursive: true, force: true });
for (const [from, to] of files) {
  const source = path.join(repository, from);
  await stat(source);
  await mkdir(path.dirname(path.join(out, to)), { recursive: true });
  await cp(source, path.join(out, to), { recursive: true });
}
console.log(`staged the transcriber build context in ${out}`);
