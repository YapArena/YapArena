// Fails when tracked files break the evidence policy in CONTRIBUTING.md:
// no images, videos or .raw files under docs/, no file over 1 MiB outside
// public/, and no generated build output. Files that predate the policy are
// listed in the baseline file.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const maximumBytes = 1024 * 1024;
const mediaExtension =
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|heic|heif|svg|mp4|webm|mov|mkv|avi|m4v|ogv|raw)$/i;
const largeFileDirectories = ["public/"];
// Build output, which `npm run build` generates and .gitignore lists.
const generatedOutput = /^(dist|dist-transcriber|coverage)\/|^public\/.*\.js$/;

export interface TrackedFile {
  path: string;
  size: number;
}

export function findViolations(
  files: readonly TrackedFile[],
  baseline: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (baseline.has(file.path)) continue;
    if (generatedOutput.test(file.path)) {
      violations.push(`${file.path}: generated build output`);
    } else if (
      file.path.startsWith("docs/") &&
      mediaExtension.test(file.path)
    ) {
      violations.push(`${file.path}: image, video or .raw file under docs/`);
    } else if (
      file.size > maximumBytes &&
      !largeFileDirectories.some((directory) => file.path.startsWith(directory))
    ) {
      violations.push(`${file.path}: ${file.size} bytes exceeds 1 MiB`);
    }
  }
  return violations;
}

export function readBaseline(file: string): Set<string> {
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

function trackedFiles(root: string): TrackedFile[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((name) => name !== "")
    .flatMap((name) => {
      try {
        return [{ path: name, size: statSync(path.join(root, name)).size }];
      } catch {
        // Deleted in the working tree but not yet staged.
        return [];
      }
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseline = readBaseline(
    fileURLToPath(new URL("repository-files-baseline.txt", import.meta.url)),
  );
  const violations = findViolations(trackedFiles(process.cwd()), baseline);
  if (violations.length > 0) {
    console.error(
      "Repository file policy failed (see CONTRIBUTING.md#evidence-and-status-records):",
    );
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
  }
}
