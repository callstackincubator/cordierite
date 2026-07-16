import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getCordieriteState,
  postEvent,
  addCordieriteListener,
  type CordieriteClientState,
  type CordieriteSessionChangeEvent,
  type CordieriteUnifiedErrorEvent,
} from "@cordierite/react-native";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Layout, Radius } from "@/constants/theme";
import { useThemeColor } from "@/hooks/use-theme-color";

const MAX_ERRORS = 5;

function connectionBadgeColor(
  state: CordieriteClientState,
  colors: { success: string; warning: string; danger: string; muted: string }
): string {
  switch (state) {
    case "active":
      return colors.success;
    case "connecting":
    case "reconnecting":
      return colors.warning;
    case "closed":
      return colors.danger;
    default:
      return colors.muted;
  }
}

export default function StatusScreen() {
  const insets = useSafeAreaInsets();
  const border = useThemeColor({}, "border");
  const cardBg = useThemeColor({}, "card");
  const elevated = useThemeColor({}, "backgroundElevated");
  const success = useThemeColor({}, "success");
  const warning = useThemeColor({}, "warning");
  const danger = useThemeColor({}, "danger");
  const textTertiary = useThemeColor({}, "textTertiary");
  const tint = useThemeColor({}, "tint");
  const background = useThemeColor({}, "background");

  const [connectionState, setConnectionState] = useState<CordieriteClientState>(
    getCordieriteState()
  );
  const [alias, setAlias] = useState<string | null>(null);
  const [lastSessionEvent, setLastSessionEvent] =
    useState<CordieriteSessionChangeEvent | null>(null);
  const [errors, setErrors] = useState<CordieriteUnifiedErrorEvent[]>([]);
  const [lastPingAt, setLastPingAt] = useState<number | null>(null);

  const dotColor = useMemo(
    () =>
      connectionBadgeColor(connectionState, {
        success,
        warning,
        danger,
        muted: textTertiary,
      }),
    [connectionState, success, warning, danger, textTertiary]
  );

  useEffect(() => {
    const stateSubscription = addCordieriteListener("stateChange", (event) => {
      setConnectionState(event.state);
    });
    const sessionSubscription = addCordieriteListener("sessionChange", (event) => {
      setLastSessionEvent(event);
      if (event.type === "lost") {
        setAlias(null);
      } else {
        setAlias(event.alias);
      }
    });
    const errorSubscription = addCordieriteListener("error", (event) => {
      setErrors((previous) => [event, ...previous].slice(0, MAX_ERRORS));
    });

    return () => {
      stateSubscription.remove();
      sessionSubscription.remove();
      errorSubscription.remove();
    };
  }, []);

  const cardStyle = [styles.card, { borderColor: border, backgroundColor: cardBg }];
  const monoSurfaceStyle = [
    styles.monoSurface,
    { borderColor: border, backgroundColor: elevated },
  ];

  const handlePing = async () => {
    const at = Date.now();
    await postEvent("playground_ping", { at });
    setLastPingAt(at);
  };

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
            Session
          </ThemedText>
          <ThemedText type="hero">Status</ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Connection</ThemedText>
          <View style={styles.row}>
            <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
            <ThemedText type="subtitle" style={styles.stateLabel}>
              {connectionState}
            </ThemedText>
          </View>
          <ThemedText type="caption" style={styles.cardHint}>
            Alias: {alias ?? "not claimed yet"}
          </ThemedText>
          {lastSessionEvent && (
            <ThemedText type="caption" style={styles.cardHint}>
              Last session event: {lastSessionEvent.type}
              {lastSessionEvent.reason ? ` (${lastSessionEvent.reason})` : ""}
            </ThemedText>
          )}
          <ThemedText type="caption" style={styles.cardHint}>
            Metro reload should suspend and resume this session automatically -- reload the app
            and watch this state go reconnecting → active without a new deep link.
          </ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Post an event</ThemedText>
          <Pressable
            onPress={handlePing}
            style={[styles.button, { backgroundColor: tint }]}>
            <ThemedText
              type="defaultSemiBold"
              style={{ color: background }}>
              Send playground_ping
            </ThemedText>
          </Pressable>
          <ThemedText type="caption" style={styles.cardHint}>
            {lastPingAt !== null
              ? `Last sent at ${new Date(lastPingAt).toLocaleTimeString()}. Watch it with: cordierite events --follow`
              : "Watch it arrive with: cordierite events --follow"}
          </ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Error feed</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {errors.length > 0
                ? errors
                    .map((error) => `[${error.phase}] ${error.message}`)
                    .join("\n")
                : "No errors."}
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
  button: {
    borderRadius: Radius.md,
    paddingVertical: 12,
    alignItems: "center",
  },
});
