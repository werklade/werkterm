// Import the React-free core only: importing "../i18n" here would load the real "react"
// before test files replace it with vi.mock("react"), and hooks would then fail.
import { setLanguage } from "../i18n/core";

// Existing tests assert German texts; run every test file with German UI text.
setLanguage("de");
