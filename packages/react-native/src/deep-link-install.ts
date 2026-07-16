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
 * Subscribes to runtime deep links immediately, then attempts startup recovery before considering
 * the initial URL. Safe to call once; later calls no-op — except that a later call with *different*
 * options than the first installation logs a dev warning, since the first installation's options
 * silently remain in effect (the v1 defect: the run-once guard gave callers no way to discover a
 * conflicting reinstall).
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

  try {
    Linking.addEventListener("url", ({ url }) => {
      handleCordieriteDeepLinkUrl(client, url, normalized);
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.addEventListener(url) failed", error);
  }

  const warnRecoveryFailure = () => {
    // The client reports expected recovery transport failures through its unified error channel.
    // This is only the orchestration safety net; do not include the error because a third-party
    // client implementation could put lease credentials in its rejection message.
    logger.warn(
      "Cordierite: startup session recovery failed; falling back to the initial URL"
    );
  };

  let restorePromise: Promise<boolean>;
  try {
    restorePromise = client.restoreSession();
  } catch {
    warnRecoveryFailure();
    restorePromise = Promise.resolve(false);
  }

  let initialUrlPromise: Promise<string | null>;
  try {
    initialUrlPromise = Linking.getInitialURL().catch((error: unknown) => {
      logger.warn("Cordierite: Linking.getInitialURL failed", error);
      return null;
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.getInitialURL failed", error);
    initialUrlPromise = Promise.resolve(null);
  }

  (async () => {
    let restored = false;
    try {
      restored = await restorePromise;
    } catch {
      warnRecoveryFailure();
    }

    if (restored) {
      return;
    }

    const initialUrl = await initialUrlPromise;
    handleCordieriteDeepLinkUrl(client, initialUrl, normalized);
  })().catch(() => {
    logger.warn("Cordierite: startup bootstrap orchestration failed");
  });
}

/** @internal */
export function __cordieriteResetInstallGuardForTests(): void {
  installedOptions = null;
}
