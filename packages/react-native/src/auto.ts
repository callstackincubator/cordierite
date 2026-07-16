import { installCordieriteDeepLinkBootstrap } from "./index";

/**
 * `@cordierite/react-native/auto` — side-effect entry (ARCHITECTURE.md §11). Importing this module
 * installs the default deep-link bootstrap listener and starts native-lease recovery immediately
 * (the v1 root-import behavior, now opt-in): `import "@cordierite/react-native/auto";` once, near
 * your app's entry point.
 *
 * Re-exports everything the root (`.`) entry exports, so apps that want the auto-install behavior
 * do not also need to import from `.`.
 */
export * from "./index";

installCordieriteDeepLinkBootstrap();
