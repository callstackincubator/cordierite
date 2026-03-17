/**
 * Design tokens — Vercel-inspired neutral surfaces, crisp borders, and a single accent.
 */

import { Platform } from "react-native";

const accentLight = "#0070f3";
const accentDark = "#3291ff";

export const Colors = {
  light: {
    text: "#000000",
    textSecondary: "#666666",
    textTertiary: "#888888",
    background: "#ffffff",
    backgroundElevated: "#fafafa",
    tint: accentLight,
    icon: "#666666",
    tabIconDefault: "#888888",
    tabIconSelected: "#000000",
    border: "#eaeaea",
    borderSubtle: "#f0f0f0",
    card: "#fafafa",
    tabBar: "#ffffff",
    link: accentLight,
    success: "#17c964",
    warning: "#f5a623",
    danger: "#ee0000",
  },
  dark: {
    text: "#ededed",
    textSecondary: "#888888",
    textTertiary: "#666666",
    background: "#000000",
    backgroundElevated: "#0a0a0a",
    tint: "#ffffff",
    icon: "#888888",
    tabIconDefault: "#666666",
    tabIconSelected: "#ededed",
    border: "#333333",
    borderSubtle: "#1f1f1f",
    card: "#111111",
    tabBar: "#000000",
    link: accentDark,
    success: "#17c964",
    warning: "#f5a623",
    danger: "#ff6363",
  },
};

export const Fonts = Platform.select({
  ios: {
    sans: "system-ui",
    serif: "ui-serif",
    rounded: "ui-rounded",
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});

export const Radius = {
  sm: 6,
  md: 10,
  lg: 14,
};

export const Layout = {
  pagePadding: 20,
  maxContentWidth: 560,
};
