import { createServer, type Server } from 'node:http';
import { handleRequest, type RouterConfig } from './router.js';
import { createPortalDataSource } from './data-source.js';

/**
 * server/server — the loopback HTTP server for the portal.
 *
 * Binds node:http to the LOOPBACK interface (127.0.0.1) ONLY — never 0.0.0.0, never an
 * external host. The portal is a strictly local, read-only window; it is never an exposed
 * service. `startServer` returns a handle with `.close()` (always teardownable in tests)
 * and the actual bound port (pass `port: 0` for an ephemeral port to avoid collisions).
 *
 * Read-only by default: the only write is POST /approve, which shells the CLI, and which is
 * rejected 409 in view-only mode (`writeEnabled: false`).
 */

/** The loopback host — 127.0.0.1 ONLY. Never 0.0.0.0 / '::' / an external address. */
const LOOPBACK_HOST = '127.0.0.1';

export interface ServerOptions {
  projectRoot: string;
  /** Port to bind (0 = ephemeral OS-assigned port). */
  port: number;
  /** false in --no-write / view-only mode: POST /approve is rejected 409. */
  writeEnabled: boolean;
  /** Where the full reason for a request that failed inside the server goes (see RouterConfig). */
  onInternalError?: (line: string) => void;
}

export interface ServerHandle {
  /** The HTTP origin the server is reachable at, e.g. http://127.0.0.1:51234. */
  url: string;
  /** The actual bound port (resolved from the ephemeral assignment when port was 0). */
  port: number;
  /** Stop accepting connections and release the port. Always callable in tests. */
  close: () => Promise<void>;
}

/**
 * Start the loopback portal server. Resolves once the server is listening, with a handle
 * that exposes the bound URL/port and a `close()` for teardown. Binds 127.0.0.1 ONLY.
 */
export function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const config: RouterConfig = {
    projectRoot: opts.projectRoot,
    writeEnabled: opts.writeEnabled,
    dataSource: createPortalDataSource(opts.projectRoot, opts.writeEnabled),
    ...(opts.onInternalError !== undefined ? { onInternalError: opts.onInternalError } : {}),
  };
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, config);
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    server.on('error', reject);
    // LOOPBACK BIND: host is pinned to 127.0.0.1 so the server is never reachable off-host.
    server.listen(opts.port, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        url: `http://${LOOPBACK_HOST}:${port}`,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
