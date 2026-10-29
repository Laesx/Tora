// Sets the app version everywhere it is stored: package.json, tauri.conf.json (what the updater and the
// release workflow's tag check read), Cargo.toml and Tora's entry in Cargo.lock.
//
//   pnpm bump patch | minor | major | 1.2.3
//
// Only the version strings are rewritten; formatting and line endings are kept.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  // [path, regex whose group 1 is the text before the version and group 2 the version]
  ["package.json", /^(\s*"version":\s*")([^"]+)/m],
  ["src-tauri/tauri.conf.json", /^(\s*"version":\s*")([^"]+)/m],
  ["src-tauri/Cargo.toml", /^(\[package\][^[]*?^version\s*=\s*")([^"]+)/m],
  ["src-tauri/Cargo.lock", /^(name = "tora"\r?\nversion = ")([^"]+)/m],
];

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: pnpm bump <patch | minor | major | x.y.z>");
  process.exit(1);
}

const read = (path) => readFileSync(join(root, path), "utf8");
const current = read("src-tauri/tauri.conf.json").match(FILES[1][1])?.[2];
if (!current) {
  console.error("Could not read the current version from src-tauri/tauri.conf.json");
  process.exit(1);
}

function nextVersion(version, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = version.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      console.error(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
      process.exit(1);
  }
}

const next = nextVersion(current, arg);

// Check every file before writing any, so a miss never leaves the versions out of step.
const updates = FILES.map(([path, pattern]) => {
  const text = read(path);
  if (!pattern.test(text)) {
    console.error(`No version found in ${path}; nothing was changed`);
    process.exit(1);
  }
  return [path, text.replace(pattern, `$1${next}`)];
});
for (const [path, text] of updates) writeFileSync(join(root, path), text);

console.log(`Tora ${current} -> ${next}`);
for (const [path] of FILES) console.log(`  updated ${path}`);
console.log(`
Next: commit, then push the tag (the release workflow checks it matches):
  git commit -am "chore: release v${next}"
  git tag v${next}
  git push origin HEAD v${next}`);
