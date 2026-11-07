import { useReducer } from "react";

interface PasswordInputState { value: string; visible: boolean }
type Action = { type: "change"; value: string } | { type: "toggle" } | { type: "reset" };
export function passwordInputReducer(state: PasswordInputState, action: Action): PasswordInputState {
  switch (action.type) {
    case "change": return { ...state, value: action.value };
    case "toggle": return { ...state, visible: !state.visible };
    case "reset": return { value: "", visible: false };
  }
}

/** Only holds the current input; persisted secrets are never fetched. */
export function usePasswordInput() {
  const [state, dispatch] = useReducer(passwordInputReducer, { value: "", visible: false });
  return {
    ...state,
    change: (value: string) => dispatch({ type: "change", value }),
    toggle: () => dispatch({ type: "toggle" }),
    reset: () => dispatch({ type: "reset" }),
  };
}
