import { Linking } from "react-native";

import {
  handleCordieriteDeepLinkUrl,
  type CordieriteAutoBootstrapClient,
} from "./deep-link-core";
import { logger } from "./logger";

let deepLinkInstalled = false;

/**
 * Subscribes to initial and runtime deep links. Safe to call once; later calls no-op.
 */
export function installCordieriteDeepLinkBootstrap(
  client: CordieriteAutoBootstrapClient
): void {
  if (deepLinkInstalled) {
    return;
  }
  deepLinkInstalled = true;

  try {
    void Linking.getInitialURL().then((initialUrl) => {
      handleCordieriteDeepLinkUrl(client, initialUrl);
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.getInitialURL failed", error);
  }

  try {
    Linking.addEventListener("url", ({ url }) => {
      handleCordieriteDeepLinkUrl(client, url);
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.addEventListener(url) failed", error);
  }
}

/** @internal */
export function __cordieriteResetInstallGuardForTests(): void {
  deepLinkInstalled = false;
}
