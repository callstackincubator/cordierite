/**
 * Design tokens — neutral surfaces and crisp borders, with a Callstack-purple accent.
 *
 * `brand` matches ../agent-device/examples/test-app/src/theme.ts's `const brand = '#8232FF'`.
 * It's used directly as a fill (buttons) in both schemes, always paired with white foreground
 * text/icons -- #8232FF against white is a ~5.6:1 contrast ratio, comfortably AA. As inline text
 * or an icon color sitting directly on the page background, though, #8232FF against black is only
 * ~3.7:1 -- short of the 4.5:1 normal-text AA threshold -- so dark mode's `tint`/`link`/
 * `tabIconSelected` use `brandOnDark`, a lightened variant (~5.3:1 against black) that reads as
 * the same purple while staying readable.
 */

import { Platform } from "react-native";

const brand = "#8232FF";
const brandOnDark = "#9a66ff";

export const Colors = {
  light: {
    text: "#000000",
    textSecondary: "#666666",
    textTertiary: "#888888",
    background: "#ffffff",
    backgroundElevated: "#fafafa",
    tint: brand,
    tintForeground: "#ffffff",
    icon: "#666666",
    tabIconDefault: "#888888",
    tabIconSelected: brand,
    border: "#eaeaea",
    borderSubtle: "#f0f0f0",
    card: "#fafafa",
    tabBar: "#ffffff",
    link: brand,
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
    tint: brand,
    tintForeground: "#ffffff",
    icon: "#888888",
    tabIconDefault: "#666666",
    tabIconSelected: brandOnDark,
    border: "#333333",
    borderSubtle: "#1f1f1f",
    card: "#111111",
    tabBar: "#000000",
    link: brandOnDark,
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
