import { t } from "../i18n";

/** Display name for the status bar: generic words are translated, proper language names stay as CodeMirror names them. */
export function languageDisplayName(name: string | null): string {
  if (name === null) return t("editor.language.plain");
  return name === "Properties files" ? t("editor.language.properties") : name;
}

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

/**
 * Language names for well-known configuration files that have no matching extension
 * (e.g. ".bashrc"). Checked after CodeMirror's own filename matching, before the shebang.
 */
export function languageFromKnownFile(fileName: string): string | null {
  const name = fileName.split(/[\/]/).pop()?.toLowerCase() ?? "";
  if (/^\.?(bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zshrc|zprofile|zshenv|zlogin|zlogout|kshrc|mkshrc|shrc|xprofile|xsessionrc)$/.test(name)) return "shell";
  if (/^(bashrc|profile|environment|crontab)$/.test(name) || /\.(bashrc|zshrc|profile)$/.test(name)) return "shell";
  if (/^\.env(\..+)?$/.test(name) || /\.env(\.example|\.sample|\.local)?$/.test(name)) return "properties files";
  if (/^\.(gitconfig|editorconfig|npmrc|wgetrc|curlrc)$/.test(name) || name === "gitconfig") return "properties files";
  return null;
}
