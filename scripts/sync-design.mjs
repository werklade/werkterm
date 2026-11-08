// Syncs shared Werklade tokens and icons without deleting Werkterm-only assets.
// Usage: npm run sync-design [-- [--check] <path to design repo>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const paths = args.filter(arg => arg !== "--check");
if (paths.length > 1 || paths.some(arg => arg.startsWith("--"))) {
  console.error("Usage: node scripts/sync-design.mjs [--check] [design repo path]");
  process.exit(1);
}
const candidates = paths.length ? [resolve(paths[0])] : [join(root, "..", "design"), join(root, "..", "werklade", "design")];
const protectedIcons = new Set(["apple.svg", "debian.svg", "windows.svg", "readme.md"]);

try {
  const source = candidates.find(dir => existsSync(join(dir, "tokens", "werklade.json")));
  if (!source) throw new Error(`werklade/design not found (looked in: ${candidates.join(", ")})`);
  const icons = join(source, "icons");
  const names = readdirSync(icons, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".svg") && !protectedIcons.has(entry.name.toLowerCase()))
    .map(entry => entry.name).sort();
  const files = [
    [join(source, "tokens", "werklade.json"), join("src", "brand", "werklade.tokens.json")],
    [join(source, "logo", "werkterm-logo.svg"), join("src", "brand", "werkterm-logo.svg")],
    ...[...names, "LICENSE-tabler-icons.txt"].map(name => [join(icons, name), join("src", "assets", "icons", name)]),
  ];
  // Validate all sources before copying so a missing license cannot cause a partial sync.
  for (const [from] of files) {
    if (!statSync(from).isFile()) throw new Error(`Not a file: ${from}`);
  }
  let differences = 0;
  for (const [from, relative] of files) {
    const destination = join(root, relative);
    if (check) {
      if (!existsSync(destination)) {
        console.error(`Missing: ${relative}`);
        differences++;
      } else if (!readFileSync(from).equals(readFileSync(destination))) {
        console.error(`Different: ${relative}`);
        differences++;
      }
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(from, destination);
      console.log(`Copied: ${relative}`);
    }
  }
  if (check) {
    if (!differences) console.log(`Design tokens and icons match (${files.length} files).`);
    process.exitCode = differences ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
