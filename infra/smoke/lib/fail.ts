/**
 * One failure path for a smoke: the FAIL line is printed once, the cleanup
 * runs once and is awaited, and only then does the process exit 1, however
 * the failure arrives — a `fail()` in the main chain, a plain throw there, or
 * a `fail()` or throw from an event callback.
 *
 * The shape it replaces called `fail()` again from `main().catch`. That second
 * call printed a stray `FAIL: Error: unreachable`, and its own `throw` inside
 * the catch handler was an unhandled rejection, which ends a Bun process at
 * once: the first call's `DELETE /session` and character delete never
 * finished, and the account stayed `account_in_use` until freed by hand.
 */

/** What `fail()` throws to stop the smoke's main chain; never reported twice. */
export class SmokeFailure extends Error {
  override name = "SmokeFailure";
}

export interface FailOnceOptions {
  /** The FAIL line's prefix, read when the failure arrives (so it can name the current step). */
  prefix: () => string;
  /** Teardown: the session delete, the throwaway characters. Run once; its own errors are swallowed. */
  cleanup: () => Promise<unknown>;
  /** Backstop: exit anyway when the cleanup has not finished by then. Size it above the cleanup's worst case. */
  cleanupMs: number;
  exit?: (code: number) => never;
}

export interface FailOnce {
  /**
   * Report a named failure, start the teardown, and throw to stop the caller.
   * Smokes call it through their own `function fail(msg): never`: TypeScript
   * narrows after a `never` call only through a declared function.
   */
  fail(msg: string): never;
  /** The `main().catch` handler (and the process hooks'): never throws, resolves only by exiting. */
  failed(e: unknown): Promise<never>;
}

export function failOnce(opts: FailOnceOptions): FailOnce {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let finishing: Promise<never> | undefined;

  function failed(e: unknown): Promise<never> {
    // A SmokeFailure reaching here was thrown by fail(), which started the
    // teardown already: the main chain's rejection and a callback's throw
    // both land on the same promise.
    if (finishing) return finishing;
    const msg = e instanceof SmokeFailure ? e.message : String((e as Error)?.stack ?? e);
    console.error(`${opts.prefix()}: ${msg}`);
    finishing = (async () => {
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        backstop = setTimeout(() => resolve("timeout"), opts.cleanupMs);
      });
      const done = Promise.resolve()
        .then(opts.cleanup)
        .then(
          () => "done" as const,
          () => "done" as const,
        );
      if ((await Promise.race([done, timedOut])) === "timeout") console.error(`${opts.prefix()}: cleanup still running after ${opts.cleanupMs}ms; exiting without it`);
      clearTimeout(backstop);
      return exit(1);
    })();
    return finishing;
  }

  process.on("unhandledRejection", (e) => void failed(e));
  process.on("uncaughtException", (e) => void failed(e));

  return {
    fail(msg: string): never {
      void failed(new SmokeFailure(msg));
      throw new SmokeFailure(msg);
    },
    failed,
  };
}
