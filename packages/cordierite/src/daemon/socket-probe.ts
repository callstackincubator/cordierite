/**
 * "Is anything listening on the control socket?" — the cheapest liveness signal the state dir
 * offers, and the one that answers fastest when a daemon is up.
 *
 * It lives in its own module rather than in `rpc/client.ts` (its first caller) because
 * `daemon/log-rotation.ts` needs it too, and `rpc/client.ts` already imports *that*. Keeping the
 * probe here means neither has to import the other.
 */

import { connect } from "node:net";

/**
 * Resolves `true` when a connection to `socketPath` is accepted. A refusal, a missing socket file,
 * or any other error resolves `false` — this never rejects, so callers can use it as a plain
 * predicate. Note it proves a listener exists *right now*; it cannot prove one will not appear a
 * moment later.
 */
export const isSocketConnectable = (socketPath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = connect(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
};
