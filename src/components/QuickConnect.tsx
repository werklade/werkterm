import { useState } from "react";
import { parseQuickConnect } from "../lib/quickConnect";

const error = "Ungültige Adresse. Erwartet: [user@]host[:port], IPv6 in […], Port 1–65535.";

/** Quick connect field in the fixed workspace header. */
export function QuickConnect({ onConnect, onStatus, className = "" }: { onConnect: (target: string) => void; onStatus: (message: string) => void; className?: string }) {
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  return <form className={`quick-connect ${className}`} onSubmit={event => {
    event.preventDefault();
    const valid = parseQuickConnect(input) !== null;
    setInvalid(!valid);
    if (valid) { onConnect(input.trim()); setInput(""); } else onStatus(error);
  }}>
    <input aria-label="Quick connect" placeholder="Quick connect..." value={input} aria-invalid={invalid} title={invalid ? error : "[user@]host[:port]"} onChange={event => { setInput(event.target.value); setInvalid(false); }} />
  </form>;
}
