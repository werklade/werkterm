import { useEffect, useRef } from "react";

/** Native modal dialogs provide keyboard focus containment and restore focus. */
export function useModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>("[autofocus]")?.focus();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return dialog;
}
