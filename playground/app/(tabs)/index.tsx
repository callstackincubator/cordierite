import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { z } from "zod";
import {
  cordieriteClient,
  registerTool,
  type CordieriteCloseEvent,
  type CordieriteConnectionState,
  type CordieriteErrorEvent,
  type CordieriteMessageEvent,
} from "react-native-cordierite";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Layout, Radius } from "@/constants/theme";
import { useThemeColor } from "@/hooks/use-theme-color";

function connectionBadgeColor(
  state: CordieriteConnectionState,
  colors: {
    success: string;
    warning: string;
    danger: string;
    muted: string;
  },
): string {
  switch (state) {
    case "active":
      return colors.success;
    case "connecting":
      return colors.warning;
    case "error":
      return colors.danger;
    default:
      return colors.muted;
  }
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const border = useThemeColor({}, "border");
  const cardBg = useThemeColor({}, "card");
  const elevated = useThemeColor({}, "backgroundElevated");
  const success = useThemeColor({}, "success");
  const warning = useThemeColor({}, "warning");
  const danger = useThemeColor({}, "danger");
  const textTertiary = useThemeColor({}, "textTertiary");

  const [connectionState, setConnectionState] = useState<CordieriteConnectionState>(
    cordieriteClient.getState(),
  );
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastClose, setLastClose] = useState<string | null>(null);

  const dotColor = useMemo(
    () =>
      connectionBadgeColor(connectionState, {
        success,
        warning,
        danger,
        muted: textTertiary,
      }),
    [connectionState, success, warning, danger, textTertiary],
  );

  useEffect(() => {
    const echoRegistration = registerTool(
      {
        name: "echo",
        description: "Echoes arguments back from the Expo app.",
        input_schema: z.object({
          value: z.unknown(),
        }),
        output_schema: z.object({
          echoed: z.unknown(),
        }),
      },
      (args) => ({
        echoed: args.value,
      }),
    );
    const sumRegistration = registerTool(
      {
        name: "sum",
        description: "Adds two numeric values in the Expo app.",
        input_schema: z.object({
          a: z.number(),
          b: z.number(),
        }),
        output_schema: z.object({
          total: z.number(),
        }),
      },
      async (args) => ({
        total: args.a + args.b,
      }),
    );

    return () => {
      echoRegistration.remove();
      sumRegistration.remove();
    };
  }, []);

  useEffect(() => {
    const stateSubscription = cordieriteClient.addListener("stateChange", (event) => {
      setConnectionState(event.state);
    });
    const messageSubscription = cordieriteClient.addListener("message", (event: CordieriteMessageEvent) => {
      setLastMessage(JSON.stringify(event.message, null, 2));
    });
    const errorSubscription = cordieriteClient.addListener("error", (event: CordieriteErrorEvent) => {
      setLastError(`${event.code}: ${event.message}`);
    });
    const closeSubscription = cordieriteClient.addListener("close", (event: CordieriteCloseEvent) => {
      setLastClose(
        event.code === undefined
          ? "closed"
          : `code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`,
      );
    });

    return () => {
      stateSubscription.remove();
      messageSubscription.remove();
      errorSubscription.remove();
      closeSubscription.remove();
    };
  }, []);

  const cardStyle = [styles.card, { borderColor: border, backgroundColor: cardBg }];
  const monoSurfaceStyle = [
    styles.monoSurface,
    { borderColor: border, backgroundColor: elevated },
  ];

  return (
    <ThemedView style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          {
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + 28,
          },
        ]}
        showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <ThemedText type="overline" style={styles.heroEyebrow}>
            Expo app
          </ThemedText>
          <ThemedText type="hero">Cordierite</ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Session</ThemedText>
          <View style={styles.row}>
            <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
            <ThemedText type="subtitle" style={styles.stateLabel}>
              {connectionState}
            </ThemedText>
          </View>
          <ThemedText type="caption" style={styles.cardHint}>
            Open the app via a bootstrap deep link to connect.
          </ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Last message</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {lastMessage ?? "No session-bound message received yet."}
            </ThemedText>
          </View>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Last error</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {lastError ?? "No errors."}
            </ThemedText>
          </View>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Last close</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {lastClose ?? "Socket has not closed yet."}
            </ThemedText>
          </View>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    paddingHorizontal: Layout.pagePadding,
    gap: 14,
    maxWidth: Layout.maxContentWidth,
    width: "100%",
    alignSelf: "center",
  },
  hero: {
    marginBottom: 8,
    gap: 10,
  },
  heroEyebrow: {
    marginBottom: -4,
  },
  heroSub: {
    marginTop: 4,
    maxWidth: 480,
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stateLabel: {
    textTransform: "capitalize",
  },
  cardHint: {
    marginTop: -4,
  },
  monoSurface: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginTop: -4,
  },
});
