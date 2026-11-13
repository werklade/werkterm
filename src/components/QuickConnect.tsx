import { useState } from "react";
import { parseQuickConnect } from "../lib/quickConnect";
import { useT } from "../i18n";

/** Quick connect field in the fixed workspace header. */
export function QuickConnect({ onConnect, onStatus, className = "" }: { onConnect: (target: string) => void; onStatus: (message: string) => void; className?: string }) {
  const t = useT();
  const error = t("quick.error");
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  return <form className={`quick-connect ${className}`} onSubmit={event => {
    event.preventDefault();
    const valid = parseQuickConnect(input) !== null;
    setInvalid(!valid);
    if (valid) { onConnect(input.trim()); setInput(""); } else onStatus(error);
  }}>
    <input data-quick-connect aria-label={t("quick.label")} placeholder={t("quick.placeholder")} value={input} aria-invalid={invalid} title={invalid ? error : "[user@]host[:port]"} onChange={event => { setInput(event.target.value); setInvalid(false); }} />
  </form>;
}
