// Wrapper around the Tauri CLI ("npm run tauri ...").
// For "tauri build" (also "android build"/"ios build") it adds rustc --remap-path-prefix
// flags so release binaries do not embed the build machine's home directory, Cargo/rustup
// homes or the project path (rustc puts source paths into panic and location messages).
// Cargo's own "trim-paths" profile option would do this, but it is not stable in the
// toolchain we use (checked with cargo 1.99.1). All other commands are passed through as-is.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

const SEP = "\x1f";

/** Source prefixes to remap, least specific first: rustc applies the last matching flag. */
export function remapPrefixes({ platform, home, cargoHome, rustupHome, projectRoot }) {
  const { join } = platform === "win32" ? win32 : posix;
  return [
    [home, "~"],
    [cargoHome || (home && join(home, ".cargo")), "cargo"],
    [rustupHome || (home && join(home, ".rustup")), "rustup"],
    [projectRoot, "werkterm"],
  ].filter(([from]) => from);
}

/** Adds spelling variants rustc may see: symlink-resolved paths and both drive-letter cases on Windows. */
export function pathVariants(path, platform, realpath = p => p) {
  const variants = new Set([path]);
  try {
    variants.add(realpath(path));
  } catch {
    // Missing directories (e.g. no rustup home) need no extra variant.
  }
  if (platform === "win32") {
    for (const p of [...variants]) {
      if (/^[A-Za-z]:/.test(p)) {
        variants.add(p[0].toLowerCase() + p.slice(1));
        variants.add(p[0].toUpperCase() + p.slice(1));
      }
    }
  }
  return [...variants].filter(Boolean);
}

/** Existing user flags: CARGO_ENCODED_RUSTFLAGS wins over RUSTFLAGS, as in Cargo. */
export function existingRustflags(env) {
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) return env.CARGO_ENCODED_RUSTFLAGS.split(SEP).filter(Boolean);
  if (env.RUSTFLAGS !== undefined) return env.RUSTFLAGS.split(/\s+/).filter(Boolean);
  return [];
}

/** Value for CARGO_ENCODED_RUSTFLAGS (unit-separated, so paths with spaces survive). */
export function encodedRustflags({ env, platform, home, projectRoot, realpath }) {
  const flags = existingRustflags(env);
  const prefixes = remapPrefixes({ platform, home, cargoHome: env.CARGO_HOME, rustupHome: env.RUSTUP_HOME, projectRoot });
  for (const [from, to] of prefixes) {
    for (const variant of pathVariants(from, platform, realpath)) flags.push(`--remap-path-prefix=${variant}=${to}`);
  }
  return flags.join(SEP);
}

/** True when the CLI arguments run a build: first non-option argument, also "android build"/"ios build". */
export function isBuild(args) {
  const words = args.filter(arg => !arg.startsWith("-"));
  if (words[0] === "build") return true;
  return (words[0] === "android" || words[0] === "ios") && words[1] === "build";
}

/**
 * Cargo config files that define rustflags. CARGO_ENCODED_RUSTFLAGS makes Cargo ignore
 * build.rustflags and target.*.rustflags from these files.
 */
export function configsWithRustflags({ startDir, cargoHome }) {
  const candidates = [];
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    candidates.push(join(dir, ".cargo", "config.toml"), join(dir, ".cargo", "config"));
    if (dirname(dir) === dir) break;
  }
  if (cargoHome) candidates.push(join(cargoHome, "config.toml"), join(cargoHome, "config"));
  const seen = new Set();
  return candidates.filter(file => {
    if (seen.has(file) || !existsSync(file)) return false;
    seen.add(file);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .some(line => /^\s*(?:[\w."'-]+\.)?rustflags\s*=/.test(line.replace(/#.*/, "")));
    } catch {
      return false;
    }
  });
}

function exitCodeForSignal(signal) {
  return 128 + (constants.signals[signal] ?? 0);
}

function main() {
  const args = process.argv.slice(2);
  const env = { ...process.env };
  if (isBuild(args)) {
    const projectRoot = resolve(import.meta.dirname, "..");
    const home = homedir();
    for (const file of configsWithRustflags({ startDir: join(projectRoot, "src-tauri"), cargoHome: env.CARGO_HOME || join(home, ".cargo") })) {
      console.error(`WARNING: ${file} sets rustflags; they are ignored for this build because CARGO_ENCODED_RUSTFLAGS is used (scripts/tauri.mjs). Move them to RUSTFLAGS to keep them.`);
    }
    env.CARGO_ENCODED_RUSTFLAGS = encodedRustflags({ env, platform: process.platform, home, projectRoot, realpath: realpathSync });
    delete env.RUSTFLAGS;
  }
  const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => {
    console.error(`tauri: could not start the Tauri CLI: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? exitCodeForSignal(signal) : 1)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
