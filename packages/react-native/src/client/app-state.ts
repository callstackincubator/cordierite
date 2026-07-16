/**
 * Structural `AppState` seam (mirrors the slice of React Native's `AppState` the client needs).
 * Pure types only — no `react-native` import — so this file (and anything that only imports the
 * type) stays safely importable from plain Node/Vitest environments. The real implementation
 * backed by `react-native`'s `AppState` lives in `./real-app-state.ts`.
 */
export type AppStateStatus =
  | "active"
  | "background"
  | "inactive"
  | "unknown"
  | "extension";

export type AppStateLike = {
  readonly currentState: AppStateStatus;
  addEventListener(
    type: "change",
    listener: (state: AppStateStatus) => void
  ): { remove(): void };
};
