export type ConnectionKind = "ssh" | "telnet" | "serial" | "local" | "wsl" | "editor" | "diff" | "folderDiff";
export function kindIcon(kind: string, shell = ""): "ssh" | "telnet" | "serial" | "powershell" | "windows" | "tux" | "edit" | "terminal" {
  if (kind === "ssh" || kind === "telnet" || kind === "serial") return kind;
  if (kind === "editor" || kind === "diff" || kind === "folderDiff") return "edit";
  if (kind === "wsl") return "tux";
  if (kind === "local") {
    if (/powershell|pwsh/i.test(shell)) return "powershell";
    if (/(^|[/\\])cmd(?:\.exe)?$/i.test(shell)) return "windows";
    if (/bash/i.test(shell)) return "tux";
  }
  return "terminal";
}
