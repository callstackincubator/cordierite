import type {
  CordieriteToolRegistration,
} from "./Cordierite.types";
import { cordieriteNativeModule } from "./CordieriteModule";
import { parseBootstrapPayload, parseBootstrapUrl } from "./bootstrap";
import { createCordieriteClient } from "./createCordieriteClient";
import {
  addCordieriteErrorListener,
  type CordieriteBootstrapErrorEvent,
} from "./deep-link-core";
import { installCordieriteDeepLinkBootstrap } from "./deep-link-install";

export * from "./Cordierite.types";
export { parseBootstrapPayload, parseBootstrapUrl };
export {
  createCordieriteClient,
  type CreateCordieriteClientOptions,
} from "./createCordieriteClient";
export { cordieriteNativeModule };
export { addCordieriteErrorListener, type CordieriteBootstrapErrorEvent };

/**
 * Default Cordierite client (native TurboModule). Prefer importing the package and registering
 * tools; use this instance only for advanced flows (manual `connect`, custom listeners, testing).
 */
export const cordieriteClient = createCordieriteClient(cordieriteNativeModule);

installCordieriteDeepLinkBootstrap(cordieriteClient);

/**
 * Register a Cordierite tool on the default client. Same as `cordieriteClient.registerTool` —
 * prefer this for typical app code so you do not need to touch the singleton.
 */
export function registerTool<
  TInputSchema extends import("@cordierite/shared").StandardSchemaV1 | undefined,
  TOutputSchema extends import("@cordierite/shared").StandardSchemaV1 | undefined
>(registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>) {
  return cordieriteClient.registerTool(registration);
}
