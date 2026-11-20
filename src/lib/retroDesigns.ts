import type { TerminalTheme } from "./terminalThemes";
// Retro designs (issue #25), dark only. Defined in the app, not in the werklade/design tokens:
// they are Werkterm specific (accent colours differ from the brand, Tux look and actions belong to them).
// Colours as approved in the preview; derived tokens (hover fill, monitor, editor ...) are added in designs.ts.
export interface RetroDesignDef { name: string; ui: Record<string, string>; terminal: TerminalTheme }
export const retroDesignDefs: RetroDesignDef[] = [
  {
    // Earthy level: dark soil, moss green, sand. Accent moss green (orange stays with the brand).
    name: "Retro Lemminge",
    ui: {
      "bg-content": "#17120d", "bg-app": "#211a12", "bg-panel": "#2a2117", "bg-panel-alt": "#31271b", "bg-toolbar": "#2f2519", "bg-menubar": "#1a140e", "bg-input": "#120e0a",
      "bg-hover": "#3a2e20", "bg-active": "#4a3a27", "bg-tab": "#2a2117", "bg-tab-active": "#3b4a1f",
      "fg-primary": "#eadfc4", "fg-secondary": "#c9ba95", "fg-muted": "#9a8b6a", "fg-inverse": "#17120d",
      "accent": "#8fbf3a", "accent-hover": "#a5d150", "border": "#3a2e20", "border-strong": "#5a4830", "focus-ring": "#c8e85a",
      "danger": "#ff7a6b", "warning": "#f0c040", "success": "#7ccf4a", "on-accent": "#17120d", "selection": "#3b4a1f",
    },
    terminal: {
      background: "#17120d", foreground: "#e3d8b8", cursor: "#c8e85a", selectionBackground: "#44532a",
      black: "#92826a", red: "#ff7b6b", green: "#8fd14f", yellow: "#e8c547", blue: "#6fa8ff", magenta: "#d98bd9", cyan: "#5fd0c0", white: "#d8ccb0",
      brightBlack: "#b0a07f", brightRed: "#ff9a8c", brightGreen: "#b0e66e", brightYellow: "#ffe070", brightBlue: "#98c2ff", brightMagenta: "#f0a8f0", brightCyan: "#8be8da", brightWhite: "#fff6df",
    },
  },
  {
    // Almost black ground, red/magenta girders, cyan ladders, warm orange/yellow accent.
    name: "Retro Gerüst",
    ui: {
      "bg-content": "#05050a", "bg-app": "#0c0c18", "bg-panel": "#12121f", "bg-panel-alt": "#1a1a2e", "bg-toolbar": "#181829", "bg-menubar": "#08080f", "bg-input": "#03030a",
      "bg-hover": "#24243a", "bg-active": "#3a1a3a", "bg-tab": "#12121f", "bg-tab-active": "#2a1030",
      "fg-primary": "#f4efe6", "fg-secondary": "#c9c6d6", "fg-muted": "#8f8ca6", "fg-inverse": "#05050a",
      "accent": "#ff9f1c", "accent-hover": "#ffb84d", "border": "#2c2c44", "border-strong": "#8c1d4a", "focus-ring": "#19e6ff",
      "danger": "#ff5252", "warning": "#ffd23f", "success": "#39e07a", "on-accent": "#05050a", "selection": "#4a1840",
    },
    terminal: {
      background: "#05050a", foreground: "#f0ebe0", cursor: "#19e6ff", selectionBackground: "#4a1840",
      black: "#8c8ca8", red: "#ff4d6d", green: "#3be07a", yellow: "#ffd23f", blue: "#5b8cff", magenta: "#ff4fd8", cyan: "#19e6ff", white: "#d6d3e0",
      brightBlack: "#adadc8", brightRed: "#ff7a90", brightGreen: "#6dffa0", brightYellow: "#ffe680", brightBlue: "#86aaff", brightMagenta: "#ff85e6", brightCyan: "#7af2ff", brightWhite: "#ffffff",
    },
  },
  {
    // Night sky (keeps text readable), brick brown, pipe green, coin gold accent.
    name: "Retro Hüpfer",
    ui: {
      "bg-content": "#0e1c45", "bg-app": "#3a2216", "bg-panel": "#4a2c1d", "bg-panel-alt": "#52301f", "bg-toolbar": "#5a3623", "bg-menubar": "#2a170f", "bg-input": "#0a1433",
      "bg-hover": "#6a4029", "bg-active": "#7a4a2c", "bg-tab": "#4a2c1d", "bg-tab-active": "#1f7a2e",
      "fg-primary": "#fff4e0", "fg-secondary": "#e8d0b0", "fg-muted": "#c0a080", "fg-inverse": "#1b1206",
      "accent": "#fcc419", "accent-hover": "#ffd84d", "border": "#6a4029", "border-strong": "#8a5a38", "focus-ring": "#5cc8ff",
      "danger": "#ff6b6b", "warning": "#ffb020", "success": "#4cd964", "on-accent": "#1b1206", "selection": "#1f6a2a",
    },
    terminal: {
      background: "#0e1c45", foreground: "#f4f1e6", cursor: "#fcc419", selectionBackground: "#2a4aa0",
      black: "#8aa0d0", red: "#ff6b6b", green: "#4cd964", yellow: "#fcc419", blue: "#6fb4ff", magenta: "#e87cff", cyan: "#4fe3e3", white: "#e8eefc",
      brightBlack: "#aab8e0", brightRed: "#ff9090", brightGreen: "#85f08f", brightYellow: "#ffe066", brightBlue: "#9dcfff", brightMagenta: "#f2a8ff", brightCyan: "#8ff2f2", brightWhite: "#ffffff",
    },
  },
];
