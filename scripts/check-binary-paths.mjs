// Fails when a built binary still contains build-machine user paths
// (/home/..., /Users/..., /root/..., C:\Users\..., the current home directory or the
// project root), e.g. source paths embedded in panic messages.
// Usage: npm run check-paths [-- <file or directory> ...]
// Without arguments the release binary of the current platform is checked.
// Directories are scanned recursively (e.g. an extracted AppImage); symlinks given on the
// command line are followed, symlinks inside directories are not.
// Only uncompressed data can be checked: scan binaries, not .deb/.AppImage/.msi containers.
// Exit codes: 0 clean, 1 user paths found, 2 usage error or nothing to check.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const MAX_SHOWN = 20;
const MIN_NEEDLE = 4;

// ASCII and UTF-16LE variants. Unix homes are case-sensitive (so "/run/users/" in system
// libraries does not match); Windows paths match both slash directions and any case.
// "/root/" only counts at the start of a path, not inside one such as "/proc/1/root/".
const ascii = /\/home\/|\/Users\/|(?<![\w.-])\/root\/|[A-Za-z]:[\\/][Uu][Ss][Ee][Rr][Ss][\\/]/g;
const wide =
  /\/\0h\0o\0m\0e\0\/\0|\/\0U\0s\0e\0r\0s\0\/\0|(?<![\w.-]\0)\/\0r\0o\0o\0t\0\/\0|[A-Za-z]\0:\0[\\/]\0[Uu]\0[Ss]\0[Ee]\0[Rr]\0[Ss]\0[\\/]\0/g;

/** Literal build-machine paths to look for; on Windows with both separators and drive-letter cases. */
export function machineNeedles({ home, projectRoot, platform }) {
  const needles = new Set();
  for (const path of [home, projectRoot]) {
    if (!path || path.length < MIN_NEEDLE) continue;
    const forms = platform === "win32" ? [path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")] : [path];
    for (const form of forms) {
      needles.add(form);
      if (platform === "win32" && /^[A-Za-z]:/.test(form)) {
        needles.add(form[0].toLowerCase() + form.slice(1));
        needles.add(form[0].toUpperCase() + form.slice(1));
      }
    }
  }
  return [...needles];
}

export function findUserPaths(buffer, needles = []) {
  const text = buffer.toString("latin1");
  const hits = new Map();
  for (const [regex, step] of [[ascii, 1], [wide, 2]]) {
    regex.lastIndex = 0;
    for (let match; (match = regex.exec(text)); ) {
      hits.set(match.index, { offset: match.index, sample: sample(text, match.index, step) });
    }
  }
  for (const needle of needles) {
    if (needle.length < MIN_NEEDLE) continue;
    for (const [encoded, step] of [[Buffer.from(needle, "utf8"), 1], [Buffer.from(needle, "utf16le"), 2]]) {
      for (let at = buffer.indexOf(encoded); at !== -1; at = buffer.indexOf(encoded, at + 1)) {
        if (!hits.has(at)) hits.set(at, { offset: at, sample: sample(text, at, step) });
      }
    }
  }
  return [...hits.values()].sort((a, b) => a.offset - b.offset);
}

function sample(text, start, step) {
  let out = "";
  for (let i = start; i < text.length && out.length < 120; i += step) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) break;
    out += text[i];
  }
  return out;
}

/** Files to scan: top-level targets follow symlinks, entries inside directories do not. */
export function collectFiles(targets) {
  const files = [];
  const walk = (path, follow) => {
    const stat = follow ? statSync(path) : lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name), false);
    } else if (stat.isFile()) {
      files.push(path);
    }
  };
  for (const target of targets) walk(target, true);
  return files;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg.startsWith("--"))) {
    console.error("Usage: node scripts/check-binary-paths.mjs [file or directory ...]");
    process.exit(2);
  }
  const binary = process.platform === "win32" ? "werkterm.exe" : "werkterm";
  const targets = args.length ? args.map(arg => resolve(arg)) : [join(root, "src-tauri", "target", "release", binary)];
  for (const target of targets) {
    if (!existsSync(target)) {
      console.error(`check-paths: not found: ${target}`);
      process.exit(2);
    }
  }
  const files = collectFiles(targets);
  if (!files.length) {
    console.error(`check-paths: no files to check in ${targets.join(", ")}`);
    process.exit(2);
  }
  const needles = machineNeedles({ home: homedir(), projectRoot: root, platform: process.platform });
  let total = 0;
  for (const file of files) {
    const hits = findUserPaths(readFileSync(file), needles);
    if (!hits.length) continue;
    total += hits.length;
    console.error(`${file}: ${hits.length} user path(s)`);
    for (const hit of hits.slice(0, MAX_SHOWN)) console.error(`  @0x${hit.offset.toString(16)}  ${hit.sample}`);
    if (hits.length > MAX_SHOWN) console.error(`  ... ${hits.length - MAX_SHOWN} more`);
  }
  if (total) {
    console.error(`check-paths: ${total} user path(s) in ${files.length} file(s) - build with "npm run tauri build"`);
    process.exit(1);
  }
  console.log(`check-paths: 0 user paths in ${files.length} file(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
