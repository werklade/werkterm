import { Icon } from "./Icon";
import { kindIcon } from "../lib/kindIcon";
export function KindIcon({ kind, shell, profile }: { kind: string; shell?: string; profile?: string }) {
  return <span className="kind-icon"><Icon name={kindIcon(kind, shell, profile)} /></span>;
}
