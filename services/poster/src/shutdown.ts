/** Minimal logger shape, satisfied by both pino and Fastify's logger. */
export interface ShutdownLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(obj: object, msg: string): void;
}

export type ShutdownHook = (signal: NodeJS.Signals) => Promise<void> | void;

export interface ShutdownOptions {
  readonly logger: ShutdownLogger;
  readonly timeoutMs: number;
  readonly hook: ShutdownHook;
}

const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'] as const;

/**
 * Installs one-shot SIGTERM/SIGINT handlers that run `hook` and then exit.
 *
 * Both entrypoints need this and both need it to be strict: a container host
 * sends SIGTERM and then SIGKILLs after its own grace period, so the hook is
 * bounded by `timeoutMs`. A dispatch worker that is killed mid-adapter-call is
 * safe by design (D-012: the row stays `dispatching` and reconciliation decides
 * its fate), but an orderly stop still beats a lease timeout.
 */
export function installShutdownHandlers({ logger, timeoutMs, hook }: ShutdownOptions): void {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn(`received ${signal} while already shutting down; ignoring`);
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`shutdown did not finish within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    void Promise.race([Promise.resolve(hook(signal)), deadline])
      .then(() => {
        logger.info('shutdown complete');
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  };

  for (const signal of SIGNALS) {
    process.once(signal, handle);
  }
}
