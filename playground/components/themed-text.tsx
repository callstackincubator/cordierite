import { StyleSheet, Text, type TextProps } from "react-native";

import { Fonts } from "@/constants/theme";
import { useThemeColor } from "@/hooks/use-theme-color";

export type ThemedTextProps = TextProps & {
  lightColor?: string;
  darkColor?: string;
  type?:
    | "default"
    | "title"
    | "hero"
    | "defaultSemiBold"
    | "subtitle"
    | "link"
    | "overline"
    | "mono"
    | "caption";
};

export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = "default",
  ...rest
}: ThemedTextProps) {
  const color = useThemeColor({ light: lightColor, dark: darkColor }, "text");
  const secondary = useThemeColor({}, "textSecondary");
  const linkColor = useThemeColor({}, "link");

  const typeStyle =
    type === "default"
      ? styles.default
      : type === "title"
        ? styles.title
        : type === "hero"
          ? styles.hero
          : type === "defaultSemiBold"
            ? styles.defaultSemiBold
            : type === "subtitle"
              ? styles.subtitle
              : type === "link"
                ? [styles.link, { color: linkColor }]
                : type === "overline"
                  ? [styles.overline, { color: secondary }]
                  : type === "mono"
                    ? [styles.mono, { color: secondary }]
                    : type === "caption"
                      ? [styles.caption, { color: secondary }]
                      : undefined;

  const sans = Fonts?.sans ?? "system-ui";
  const mono = Fonts?.mono ?? "monospace";

  return (
    <Text
      style={[{ color, fontFamily: type === "mono" ? mono : sans }, typeStyle, style]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  default: {
    fontSize: 15,
    lineHeight: 22,
  },
  defaultSemiBold: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
  },
  caption: {
    fontSize: 13,
    lineHeight: 19,
  },
  mono: {
    fontSize: 12,
    lineHeight: 18,
  },
  overline: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  hero: {
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: -1.2,
    lineHeight: 44,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 24,
    letterSpacing: -0.2,
  },
  link: {
    lineHeight: 22,
    fontSize: 15,
    fontWeight: "500",
  },
});
