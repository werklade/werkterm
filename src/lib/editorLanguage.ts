/** Resolve interpreters from a shebang; filename matching takes precedence in the view. */
export function languageFromShebang(text: string): string | null {
  const line = text.split(/\r?\n/, 1)[0];
  if (!line.startsWith("#!")) return null;
  const words = line.slice(2).trim().split(/\s+/);
  let executable = words.shift()?.split("/").pop() ?? "";
  if (executable === "env") executable = words.find(word => !word.startsWith("-") && !word.includes("=")) ?? "";
  if (/^(bash|sh|zsh|ksh|dash)$/.test(executable)) return "shell";
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) return "python";
  if (/^(node|nodejs|deno)$/.test(executable)) return "javascript";
  if (/^perl(?:\d+)?$/.test(executable)) return "perl";
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(executable)) return "ruby";
  if (executable === "php") return "php";
  return null;
}
