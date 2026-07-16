import { Linking } from "react-native";

import {
  handleCordieriteDeepLinkUrl,
  type CordieriteAutoBootstrapClient,
} from "./deep-link-core";
import { logger } from "./logger";

export type InstallCordieriteDeepLinkBootstrapOptions = {
  /** Reject bootstrap payloads whose address is not a private/loopback range. Default `true`. */
  requirePrivateIp?: boolean;
};

const normalizeOptions = (
  options: InstallCordieriteDeepLinkBootstrapOptions
): Required<InstallCordieriteDeepLinkBootstrapOptions> => ({
  requirePrivateIp: options.requirePrivateIp ?? true,
});

const optionsEqual = (
  a: Required<InstallCordieriteDeepLinkBootstrapOptions>,
  b: Required<InstallCordieriteDeepLinkBootstrapOptions>
): boolean => a.requirePrivateIp === b.requirePrivateIp;

let installedOptions: Required<InstallCordieriteDeepLinkBootstrapOptions> | null =
  null;

/**
 * Subscribes to initial and runtime deep links. Safe to call once; later calls no-op — except that
 * a later call with *different* options than the first installation logs a dev warning, since the
 * first installation's options silently remain in effect (the v1 defect: the run-once guard gave
 * callers no way to discover a conflicting reinstall).
 */
export function installCordieriteDeepLinkBootstrap(
  client: CordieriteAutoBootstrapClient,
  options: InstallCordieriteDeepLinkBootstrapOptions = {}
): void {
  const normalized = normalizeOptions(options);

  if (installedOptions) {
    if (!optionsEqual(installedOptions, normalized)) {
      logger.devWarn(
        "installCordieriteDeepLinkBootstrap was already installed with different options; " +
          "the options from the first call remain in effect."
      );
    }
    return;
  }
  installedOptions = normalized;

  Linking.getInitialURL()
    .then((initialUrl) => {
      handleCordieriteDeepLinkUrl(client, initialUrl, normalized);
    })
    .catch((error: unknown) => {
      logger.warn("Cordierite: Linking.getInitialURL failed", error);
    });

  try {
    Linking.addEventListener("url", ({ url }) => {
      handleCordieriteDeepLinkUrl(client, url, normalized);
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.addEventListener(url) failed", error);
  }
}

/** @internal */
export function __cordieriteResetInstallGuardForTests(): void {
  installedOptions = null;
}
