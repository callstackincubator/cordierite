import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import "react-native-reanimated";
// Side-effect entry (ARCHITECTURE.md §11): installs the default deep-link bootstrap listener on
// import, so opening the host's bootstrap link (QR / `cordierite link --open`) is enough to start
// a session -- no manual `installCordieriteDeepLinkBootstrap()` call needed in this app.
import "@cordierite/react-native/auto";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

const PlaygroundLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: Colors.light.text,
    background: Colors.light.background,
    card: Colors.light.tabBar,
    text: Colors.light.text,
    border: Colors.light.border,
    notification: Colors.light.tint,
  },
};

const PlaygroundDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Colors.dark.text,
    background: Colors.dark.background,
    card: Colors.dark.tabBar,
    text: Colors.dark.text,
    border: Colors.dark.border,
    notification: Colors.dark.link,
  },
};

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === "dark" ? PlaygroundDarkTheme : PlaygroundLightTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}
