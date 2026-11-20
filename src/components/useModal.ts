import { useEffect, useRef } from "react";

/** Native modal dialogs provide keyboard focus containment and restore focus. */
export function useModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement;
    element.showModal();
    // React's autoFocus prop does not render the autofocus attribute (it calls focus() while the dialog is still closed,
    // so showModal() ends up focusing the first control). data-autofocus marks the intended initial focus explicitly.
    element.querySelector<HTMLElement>("[autofocus],[data-autofocus]")?.focus();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return dialog;
}
