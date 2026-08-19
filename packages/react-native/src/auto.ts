import { installCordieriteDeepLinkBootstrap } from "./deep-link-install";
import { cordieriteClient, noopIfNativeUnavailable } from "./default-client";

/**
 * `@cordierite/react-native/auto` — side-effect entry (ARCHITECTURE.md §11). Importing this module
 * subscribes the default client to runtime deep links and starts native-lease recovery before the
 * initial URL is considered: `import "@cordierite/react-native/auto";` once, near your app's entry
 * point.
 *
 * To control *when* that happens — behind `__DEV__`, a QA-build toggle, or after other startup
 * work — `require("@cordierite/react-native/auto")` at that point instead; Metro resolves it
 * lazily, and importing twice installs once.
 *
 * Re-exports everything the root (`.`) entry exports, so apps that want the auto-install behavior
 * do not also need to import from `.`. The install itself is deliberately *not* re-exported:
 * bootstrap policy comes from native build config, so there is nothing for an app to configure.
 */
export * from "./index";

noopIfNativeUnavailable(
  () => installCordieriteDeepLinkBootstrap(cordieriteClient),
  () => {},
);
