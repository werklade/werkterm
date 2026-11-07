import { describe, expect, it } from "vitest";
import { passwordInputReducer } from "./passwordInput";

describe("current password input", () => {
  it("toggles visibility without changing the current input", () => {
    const state = passwordInputReducer({ value: "", visible: false }, { type: "change", value: "current input" });
    const shown = passwordInputReducer(state, { type: "toggle" });
    expect(shown).toEqual({ value: "current input", visible: true });
    expect(passwordInputReducer(shown, { type: "toggle" })).toEqual(state);
  });
  it("clears the input and hides it on reset, including repeated resets", () => {
    const reset = passwordInputReducer({ value: "current input", visible: true }, { type: "reset" });
    expect(reset).toEqual({ value: "", visible: false });
    expect(passwordInputReducer(reset, { type: "reset" })).toEqual(reset);
  });
});
