import { Icon } from "./Icon";
import { kindIcon } from "../lib/kindIcon";
export function KindIcon({ kind, shell }: { kind: string; shell?: string }) {
  return <span className="kind-icon"><Icon name={kindIcon(kind, shell)} /></span>;
}
