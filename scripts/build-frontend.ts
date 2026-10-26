import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform, type Plugin } from "esbuild";

const repository = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(repository, "frontend");
const publicDirectory = path.join(repository, "public");
// These modules import shared src/ code (src/platform/html.ts) but keep their
// own /assets/<name>.js URL. Only src/ imports are inlined: sibling frontend
// imports such as ./arena-chart.js stay separate requests, exactly as the
// per-file transform emits them.
const inPlaceBundles = ["a4", "a4-inline", "outline-state", "outline-panel"];
// Classic (non-module) page scripts that use frontend/lib/ or another frontend
// module keep their URL and script scope as IIFE bundles with their own copy of
// the shared code. The session store in that code is shared through
// window.yapSession, so every copy on a page reaches the same instance (see
// frontend/lib/session.ts).
const classicBundles = [
  "session-coordination",
  "account",
  "account-balance",
  "matching",
];
const keepSiblingImports: Plugin = {
  name: "keep-sibling-imports",
  setup(context) {
    context.onResolve({ filter: /^\.\/[^/]+\.js$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// Bundle entries emit only their bundle; nothing loads a per-file copy. The
// media page and the live preview both use livekit-client, so they share ESM
// chunks under /assets/chunks/. Chunk names carry a content hash, so the server
// can cache them as immutable without a ?v= revision.
const splitBundles = {
  "media-entry": "media.bundle",
  "hero-live": "hero-live.bundle",
};
const scriptBundles = {
  "replay-entry": "replay.bundle",
  homepage: "homepage.bundle",
};
const bundleEntries = [
  ...Object.keys(splitBundles),
  ...Object.keys(scriptBundles),
];
const chunkDirectory = path.join(publicDirectory, "chunks");

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? files(name) : [name];
    }),
  );
  return nested.flat().sort();
}

async function checkSources(): Promise<string[]> {
  const sources = await files(frontend);
  const unsupportedSource = /\.(?:[cm]?js|jsx|tsx|[cm]ts)$/i;
  const unchecked = sources.filter((name) => unsupportedSource.test(name));
  // Source archives and Docker contexts omit .git. CI and local checkouts also
  // enforce that served JavaScript is never tracked as authored source.
  if (existsSync(path.join(repository, ".git"))) {
    const tracked = execFileSync(
      "git",
      ["ls-files", "-z", "--", "public", "frontend"],
      { cwd: repository, encoding: "utf8" },
    ).split("\0");
    unchecked.push(
      ...tracked.filter(
        (name) =>
          unsupportedSource.test(name) ||
          (name.startsWith("public/") && /\.[cm]?tsx?$/i.test(name)),
      ),
    );
  }
  if (unchecked.length) {
    throw new Error(
      `Handwritten frontend code must be strict TypeScript in frontend/; public JavaScript must remain untracked build output:\n${[...new Set(unchecked)].join("\n")}`,
    );
  }
  return sources.filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
  );
}

async function buildFrontend(): Promise<void> {
  const sources = await checkSources();
  await Promise.all(
    sources.map(async (source) => {
      const name = path.relative(frontend, source).replace(/\.ts$/, "");
      if (
        inPlaceBundles.includes(name) ||
        classicBundles.includes(name) ||
        bundleEntries.includes(name)
      )
        return;
      // Omitting format preserves classic-script scope and existing ESM imports.
      // Type-only modules erase to nothing and need no browser asset.
      const output = await transform(await readFile(source, "utf8"), {
        loader: "ts",
        sourcefile: path.relative(repository, source),
      });
      if (!output.code.trim()) return;
      const destination = path.join(publicDirectory, `${name}.js`);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, output.code);
    }),
  );
  const [split] = await Promise.all([
    build({
      absWorkingDir: repository,
      entryPoints: Object.entries(splitBundles).map(([entry, output]) => ({
        in: `frontend/${entry}.ts`,
        out: output,
      })),
      bundle: true,
      minify: true,
      format: "esm",
      splitting: true,
      chunkNames: "chunks/[name]-[hash]",
      outdir: "public",
      metafile: true,
    }),
    ...Object.entries(scriptBundles).map(([entry, output]) =>
      build({
        absWorkingDir: repository,
        entryPoints: [`frontend/${entry}.ts`],
        bundle: true,
        minify: true,
        format: "iife",
        outfile: `public/${output}.js`,
      }),
    ),
  ]);
  // Remove chunks from earlier builds so public/ holds only what the entries import.
  const current = new Set(
    Object.keys(split.metafile.outputs).map((name) =>
      path.join(repository, name),
    ),
  );
  if (existsSync(chunkDirectory))
    await Promise.all(
      (await files(chunkDirectory))
        .filter((name) => !current.has(name))
        .map((name) => rm(name)),
    );
  await Promise.all([
    ...inPlaceBundles.map((entry) =>
      build({
        absWorkingDir: repository,
        entryPoints: [`frontend/${entry}.ts`],
        bundle: true,
        format: "esm",
        outfile: `public/${entry}.js`,
        plugins: [keepSiblingImports],
      }),
    ),
    ...classicBundles.map((entry) =>
      build({
        absWorkingDir: repository,
        entryPoints: [`frontend/${entry}.ts`],
        bundle: true,
        format: "iife",
        outfile: `public/${entry}.js`,
      }),
    ),
  ]);
}

if (process.argv.includes("--check-sources")) {
  await checkSources();
} else {
  await buildFrontend();
  if (process.argv.includes("--watch") || process.argv.includes("--dev")) {
    let building = false;
    let requested = false;
    const rebuild = async () => {
      requested = true;
      if (building) return;
      building = true;
      while (requested) {
        requested = false;
        try {
          await buildFrontend();
        } catch (error) {
          console.error(error);
        }
      }
      building = false;
    };
    const watchers: FSWatcher[] = [
      watch(frontend, { recursive: true }, () => void rebuild()),
      watch(
        path.join(repository, "src/features/discovery"),
        { recursive: true },
        () => void rebuild(),
      ),
      watch(
        path.join(repository, "src/platform/html.ts"),
        () => void rebuild(),
      ),
    ];
    const server = process.argv.includes("--dev")
      ? spawn(
          process.execPath,
          ["--env-file-if-exists=.env.runtime", "--watch", "src/server.ts"],
          { cwd: repository, stdio: "inherit" },
        )
      : undefined;
    const close = () => {
      for (const watcher of watchers) watcher.close();
    };
    server?.on("exit", (code) => {
      close();
      process.exitCode = code ?? 1;
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        close();
        server?.kill(signal);
      });
    }
  }
}
