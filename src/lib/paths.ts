function normalizePath(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("\\\\") && !path.startsWith("//?/")) return path;
  return path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "");
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const uncRoot = /^\/\/[^/]+\/[^/]+/.exec(normalized)?.[0];
  const root = uncRoot ?? (/^[A-Za-z]:\//.test(normalized) ? normalized.slice(0, 3) : normalized.startsWith("/") ? "/" : "");
  const trimmed = normalized.replace(/\/+$/, "");
  if (trimmed.length <= root.length) return root;
  const separator = trimmed.lastIndexOf("/");
  return separator < root.length ? root : trimmed.slice(0, separator);
}

export function childPath(path: string, name: string): string {
  return `${normalizePath(path).replace(/\/+$/, "")}/${name}`;
}
