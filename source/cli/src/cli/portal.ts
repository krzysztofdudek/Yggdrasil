import { Command, InvalidArgumentError } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { projectRootFromGraph } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import { extractPortalData } from '../portal/extract.js';
import { emitStatic } from '../portal/serializer.js';
import { startServer } from '../portal/server/server.js';

/**
 * Options for `yg portal`.
 *
 * `--no-write` is a Commander negatable flag: it sets `options.write = false`
 * (default `true`), the view-only / org-board mode where the single Approve
 * write action is disabled. `--static` emits a self-contained page instead of
 * serving; `--out` chooses the static output path; `--port` chooses the loopback
 * server port; `--open` opens the page.
 */
export interface PortalOptions {
  static?: boolean;
  out?: string;
  port?: number;
  open?: boolean;
  write: boolean;
}

/**
 * Register the `yg portal` command — the read-only local web portal (Heartwood).
 *
 * Phase 1 wires `--static`: extract the portal data contract from the committed graph
 * (read-only, committed-only config) and emit ONE self-contained offline HTML file. The
 * loopback server (plain `yg portal`) is wired in a later phase; until then a non-static
 * invocation surfaces a structured what/why/next message inline.
 */
export function registerPortalCommand(program: Command): void {
  program
    .command('portal')
    .description('Open a read-only local web portal onto the graph and its verification state')
    .option('--static', 'Emit a self-contained static page instead of serving')
    .option('--out <path>', 'Output path for the static page (with --static)')
    .option('--port <n>', 'Port for the local loopback server', (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0 || n > 65535) {
        throw new InvalidArgumentError('--port must be an integer between 0 and 65535.');
      }
      return n;
    })
    .option('--open', 'Open the page in the default browser')
    .option('--no-write', 'View-only mode — disable the Approve write action')
    .action(async (options: PortalOptions) => {
      try {
        await runPortal(options);
      } catch (error) {
        abortOnUnexpectedError(error, 'opening the portal');
      }
    });
}

/**
 * Action body. Starts with `loadGraphOrAbort` so the missing-`.yggdrasil/` case is handled
 * canonically. With `--static`, extract + emit a self-contained page and print the path.
 * Without it, start the loopback read-only server (127.0.0.1 only) and keep it running.
 */
async function runPortal(options: PortalOptions): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd());
  initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
  const projectRoot = projectRootFromGraph(graph.rootPath);

  if (options.static) {
    const data = await extractPortalData(projectRoot, { writeEnabled: options.write });
    const outPath = path.resolve(projectRoot, options.out ?? 'yg-portal.html');
    await emitStatic(data, outPath);
    // outPath (path.resolve) is OS-native; normalize only the displayed path —
    // emitStatic/openInBrowser keep the native form for filesystem access.
    process.stdout.write(`Portal page written to ${toPosixPath(outPath)}\n`);
    if (options.open) {
      await openInBrowser(outPath);
    }
    return;
  }

  await servePortal(projectRoot, options);
}

/**
 * Start the loopback server and keep the process alive until interrupted. Binds 127.0.0.1
 * only (never exposed). Prints the local URL and, best-effort, opens it (never in a test).
 * The server is read-only by default; `--no-write` disables the single Approve action.
 */
async function servePortal(projectRoot: string, options: PortalOptions): Promise<void> {
  const handle = await startServer({
    projectRoot,
    port: options.port ?? DEFAULT_PORT,
    writeEnabled: options.write,
  });

  const mode = options.write ? '' : ' (view-only — Approve disabled)';
  process.stdout.write(`Portal running at ${handle.url}${mode}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  // Graceful shutdown on interrupt so the port is released cleanly.
  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (options.open) {
    await openInBrowser(handle.url);
  }
}

/** Default loopback port for the portal server when --port is not given. */
const DEFAULT_PORT = 4317;

/**
 * Open a path in the platform's default browser. Best-effort and non-blocking: the child
 * is detached and unref'd so the CLI returns immediately, and a failure to launch never
 * aborts the command (the page is already written and its path was printed). A launch
 * failure is recorded via debugWrite so it is not silently swallowed.
 */
async function openInBrowser(filePath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', (error) => {
      debugWrite(`[portal] openInBrowser spawn error: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.unref();
  } catch (error) {
    debugWrite(`[portal] openInBrowser failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
