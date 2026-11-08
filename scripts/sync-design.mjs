// Copies the Werklade design tokens from the werklade/design checkout into src/brand/.
// Usage: npm run sync-design [-- <path to design repo>]
// Default search: ../design (after the move into the werklade folder), then ../werklade/design.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = process.argv[2] ? [resolve(process.argv[2])] : [join(root, "..", "design"), join(root, "..", "werklade", "design")];
const source = candidates.map(dir => join(dir, "tokens", "werklade.json")).find(existsSync);
if (!source) {
  console.error(`werklade/design not found (looked in: ${candidates.join(", ")})`);
  process.exit(1);
}
copyFileSync(source, join(root, "src", "brand", "werklade.tokens.json"));
console.log(`Copied ${source} -> src/brand/werklade.tokens.json. Run npm test to compare with the built-in designs.`);
