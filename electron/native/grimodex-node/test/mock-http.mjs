import { once } from "node:events";
import { createServer } from "node:http";

// A failed close retains its owner; never stack another mock on unknown cleanup.
let closeFailure;

export async function closeMockServer(server) {
  try {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      // Stop admission before destroying this mock's unfinished HTTP connections.
      server.closeAllConnections();
    });
  } catch (error) {
    closeFailure ??= { server, error };
    throw error;
  }
}

/** Start only an owned loopback mock; reject and drain failed/pending startup. */
export async function startMockServer(
  handler,
  { port = 0, signal } = {},
) {
  if (closeFailure) throw closeFailure.error;
  signal?.throwIfAborted();
  const server = createServer(handler);
  const startup = new AbortController();
  const abort = () => startup.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => startup.abort(), 5000);
  try {
    server.listen({ port, host: "127.0.0.1", signal: startup.signal });
    await once(server, "listening", { signal: startup.signal });
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    await closeMockServer(server);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
