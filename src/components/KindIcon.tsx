import { Icon } from "./Icon";
import { kindIcon } from "../lib/kindIcon";
export function KindIcon({ kind, shell, jump = false }: { kind: string; shell?: string; jump?: boolean }) {
  return <span className="kind-icon"><Icon name={kindIcon(kind, shell)} />{kind === "ssh" && jump && <span className="jump-badge" title="Über Jump host"><Icon name="jump" /></span>}</span>;
}
