import { Linking } from "react-native";

import { getCordieriteNativeBuildConfig } from "./CordieriteModule";
import {
  handleCordieriteDeepLinkUrl,
  type CordieriteAutoBootstrapClient,
} from "./deep-link-core";
import { logger } from "./logger";

let installed = false;

/**
 * Whether a bootstrap payload's address must be private/loopback, read from the same native
 * `allowPrivateLanOnly` build config (`CordieriteAllowPrivateLanOnly` in Info.plist / the Android
 * manifest) that native `connect()` enforces — never a second, JS-side copy of the policy. JS can
 * only ever *narrow* what native allows, so a JS knob that disagreed with native would be a no-op
 * at best (native rejects the address anyway) and a misleading one at worst.
 *
 * Fail-closed on any read failure: an unresolvable native module means no `connect()` can succeed
 * regardless, so the strict default costs nothing and never widens trust by accident.
 */
const requirePrivateIp = (): boolean => {
  try {
    return getCordieriteNativeBuildConfig().allowPrivateLanOnly;
  } catch (error) {
    logger.debug(
      "Cordierite: could not read allowPrivateLanOnly; requiring a private address",
      error,
    );
    return true;
  }
};

/**
 * Subscribes to runtime deep links immediately, then attempts startup recovery before considering
 * the initial URL. Idempotent: later calls no-op.
 *
 * @internal Reached by app code only through the `./auto` entry, which passes the default client.
 */
export function installCordieriteDeepLinkBootstrap(
  client: CordieriteAutoBootstrapClient,
): void {
  if (installed) {
    return;
  }
  installed = true;

  try {
    Linking.addEventListener("url", ({ url }) => {
      handleCordieriteDeepLinkUrl(client, url, {
        requirePrivateIp: requirePrivateIp(),
      });
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.addEventListener(url) failed", error);
  }

  const warnRecoveryFailure = () => {
    // The client reports expected recovery transport failures through its unified error channel.
    // This is only the orchestration safety net; do not include the error because a third-party
    // client implementation could put lease credentials in its rejection message.
    logger.warn(
      "Cordierite: startup session recovery failed; falling back to the initial URL",
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
    handleCordieriteDeepLinkUrl(client, initialUrl, {
      requirePrivateIp: requirePrivateIp(),
    });
  })().catch(() => {
    logger.warn("Cordierite: startup bootstrap orchestration failed");
  });
}

/** @internal */
export function __cordieriteResetInstallGuardForTests(): void {
  installed = false;
}
