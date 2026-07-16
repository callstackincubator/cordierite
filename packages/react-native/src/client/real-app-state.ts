import { AppState } from "react-native";

import type { AppStateLike } from "./app-state";

/** Production `AppStateLike` backed by react-native's real `AppState`. */
export const realAppState: AppStateLike = AppState;
