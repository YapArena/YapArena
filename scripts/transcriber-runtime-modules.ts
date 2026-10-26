import { cp, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Decision 0012: the transcriber image keeps only the packages the agent
// loads at runtime and everything they depend on, at the versions the root
// lockfile installed. Run in the image's build stage after `npm ci`:
//
//   node scripts/transcriber-runtime-modules.ts <target directory>

/** The agent's direct runtime imports (compiled dist-transcriber/). */
export const agentPackages = [
  "@anthropic-ai/sdk",
  "@livekit/agents",
  "@livekit/agents-plugin-elevenlabs",
  "@livekit/rtc-node",
] as const;

/** `npm query` selecting those packages and their whole dependency tree. */
export function runtimeQuery(packages: readonly string[] = agentPackages) {
  const roots = `:is(${packages.map((name) => `#${name}`).join(", ")})`;
  return `${roots}, ${roots} *`;
}

/**
 * The directories to copy: each package's location once, without locations
 * nested inside another one (copying the parent brings them along).
 */
export function runtimeDirectories(nodes: readonly { location?: unknown }[]) {
  const locations = [
    ...new Set(
      nodes.flatMap((node) =>
        typeof node.location === "string" &&
        node.location.startsWith("node_modules/")
          ? [node.location]
          : [],
      ),
    ),
  ].sort();
  return locations.filter(
    (location) =>
      !locations.some(
        (parent) =>
          parent !== location && location.startsWith(`${parent}/node_modules/`),
      ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error(
      "usage: node scripts/transcriber-runtime-modules.ts <directory>",
    );
    process.exit(2);
  }
  const nodes = JSON.parse(
    execFileSync("npm", ["query", runtimeQuery()], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as { location?: unknown }[];
  const directories = runtimeDirectories(nodes);
  for (const name of agentPackages)
    if (!directories.includes(`node_modules/${name}`))
      throw new Error(`${name} is not installed`);
  for (const directory of directories) {
    const destination = path.join(target, directory);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(directory, destination, { recursive: true });
  }
  console.log(`copied ${directories.length} runtime packages to ${target}`);
}
