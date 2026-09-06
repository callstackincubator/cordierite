import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { z } from "zod";
import {
  getRegisteredTools,
  useCordieriteTool,
  type CordieriteToolExecutionContext,
} from "@cordierite/react-native";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Layout, Radius } from "@/constants/theme";
import { useThemeColor } from "@/hooks/use-theme-color";

const CONNECT_COMMANDS = [
  "cordierite keygen",
  "# paste the printed sha256/... pin into app.json's cliPins, then:",
  "pnpm exec expo run:ios   # or: pnpm exec expo run:android",
  "cordierite link --open ios-sim   # or: --open android / --qr",
].join("\n");

/** Delays `ms` without leaking a dangling timer past the call: each tool invocation owns its own. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RegisteredTool = ReturnType<typeof getRegisteredTools>[number];

function formatToolLine(tool: RegisteredTool): string {
  const flags = [
    tool.annotations?.readOnlyHint && "readOnly",
    tool.annotations?.destructiveHint && "destructive",
    tool.annotations?.idempotentHint && "idempotent",
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${tool.name}${suffix}\n  ${tool.description}`;
}

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const border = useThemeColor({}, "border");
  const cardBg = useThemeColor({}, "card");
  const elevated = useThemeColor({}, "backgroundElevated");

  const [callCount, setCallCount] = useState(0);
  const [tools, setTools] = useState<RegisteredTool[]>([]);

  // Plain state, no ref: `useCordieriteTool` registers a stable wrapper that forwards to the
  // latest render's handler, so `call_count` below reads the current `callCount` on every call
  // without being re-registered on each increment.
  const bumpCallCount = () => {
    setCallCount((count) => count + 1);
  };

  useCordieriteTool({
    name: "sum",
    description: "Adds two numbers.",
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.object({
      total: z.number(),
    }),
    handler: (args) => {
      bumpCallCount();
      return { total: args.a + args.b };
    },
  });

  useCordieriteTool({
    name: "call_count",
    description: "Reports how many times the playground's counted tools have run.",
    annotations: { readOnlyHint: true },
    outputSchema: z.object({
      count: z.number(),
    }),
    // Closes directly over `callCount` state. Registered once on mount, yet every call sees the
    // value from the most recent render -- that is the freshness guarantee, demonstrated.
    handler: () => ({ count: callCount }),
  });

  useCordieriteTool({
    name: "reset_counter",
    description: "Resets the playground's call counter to zero.",
    annotations: { destructiveHint: true },
    outputSchema: z.object({
      count: z.number(),
    }),
    handler: () => {
      setCallCount(0);
      return { count: 0 };
    },
  });

  useCordieriteTool({
    name: "slow_task",
    description: "Takes ~1.5s and reports progress along the way.",
    outputSchema: z.object({
      done: z.boolean(),
    }),
    timeoutMs: 5_000,
    handler: async (_args, context: CordieriteToolExecutionContext) => {
      for (const [progress, message] of [
        [0.33, "warming up"],
        [0.66, "almost there"],
        [1, "done"],
      ] as const) {
        await delay(500);
        await context.reportProgress(progress, message);
      }
      bumpCallCount();
      return { done: true };
    },
  });

  useCordieriteTool({
    name: "throwing_tool",
    description: "Always throws, to exercise tool_execution_error.",
    handler: () => {
      throw new Error("throwing_tool always fails on purpose.");
    },
  });

  // Reads the client's own registry after the tool-registering effects above have run (React runs
  // effects in declaration order on mount), so this list is never a hand-maintained duplicate.
  useEffect(() => {
    setTools(getRegisteredTools());
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
          <ThemedText type="overline">Quick start</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {CONNECT_COMMANDS}
            </ThemedText>
          </View>
          <ThemedText type="caption" style={styles.cardHint}>
            Then drive tools from another terminal: cordierite ls / tools / invoke sum --input
            {" '{\"a\":1,\"b\":2}'"}.
          </ThemedText>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Registered tools</ThemedText>
          <View style={monoSurfaceStyle}>
            <ThemedText type="mono" selectable>
              {tools.length > 0
                ? tools.map(formatToolLine).join("\n\n")
                : "No tools registered yet."}
            </ThemedText>
          </View>
        </View>

        <View style={cardStyle}>
          <ThemedText type="overline">Call counter</ThemedText>
          <View style={styles.row}>
            <ThemedText type="subtitle">{callCount}</ThemedText>
          </View>
          <ThemedText type="caption" style={styles.cardHint}>
            Bumped by sum/slow_task; call_count reads it back (a handler closing over state, never
            re-registered); reset_counter (destructive) sets it to zero. Try denying destructive
            tools in the daemon config to see it get rejected instead.
          </ThemedText>
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
