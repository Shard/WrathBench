/**
 * How a smoke speaks: its log line's prefix, its plain failure, and the
 * per-check verdicts the observation smokes collect. Each is the spelling the
 * smokes already printed, gathered here so it has one definition; the suite
 * (lib/suite.ts) and anyone tailing a smoke read these lines, so a change
 * here is a change to every smoke's output.
 *
 * The failure paths a smoke chooses between stay its own choice: `fail`
 * throws for the smokes whose top-level `try` prints the FAIL line and sets
 * the exit code, `failAndExit` prints and exits for the module probes, and
 * lib/fail.ts's `failOnce` is for the smokes with a teardown to await.
 */

/** `[tag] msg`, the module probes' and the raw-HTTP smokes' line. */
export function taggedLog(tag: string): (msg: string) => void {
  return (msg) => console.log(`[${tag}] ${msg}`);
}

/**
 * `[tag +  12.3s] msg`: seconds since `started` (the smoke's own clock, which
 * its PASS line reads too), right-aligned to `width` characters.
 */
export function stampedLog(tag: string, started: number, width = 5): (msg: string) => void {
  return (msg) => console.log(`[${tag} +${((Date.now() - started) / 1000).toFixed(1).padStart(width)}s] ${msg}`);
}

/**
 * Stop the smoke: the caller's `try` reports the FAIL line and sets the exit
 * code. A function declaration, so TypeScript narrows past a call to it.
 */
export function fail(m: string): never {
  throw new Error(m);
}

/** The module probes' failure: the FAIL line on stderr, then exit 1 at once. */
export function failAndExit(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
}

/** JSON that survives a bigint (guids, money). */
export const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";

export interface Checks {
  /** Every verdict so far, in order. */
  results: { verdict: Verdict; name: string; detail: string }[];
  report(verdict: Verdict, name: string, detail: string): void;
  /** Run one check; a throw is its FAIL, never the smoke's. */
  check(name: string, fn: () => Promise<[Verdict, string]> | [Verdict, string]): Promise<void>;
  /** Print the totals line and each FAIL again; true when any check failed. */
  totals(): boolean;
}

/** A smoke's list of independent checks, each verdict logged as it lands. */
export function checks(log: (msg: string) => void): Checks {
  const results: Checks["results"] = [];
  function report(verdict: Verdict, name: string, detail: string): void {
    results.push({ verdict, name, detail });
    log(`${verdict} ${name}: ${detail}`);
  }
  async function check(name: string, fn: () => Promise<[Verdict, string]> | [Verdict, string]): Promise<void> {
    try {
      const [verdict, detail] = await fn();
      report(verdict, name, detail);
    } catch (e) {
      report("FAIL", name, String(e instanceof Error ? e.message : e));
    }
  }
  function totals(): boolean {
    const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
    console.log(`totals: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("INFO")} info`);
    for (const r of results.filter((x) => x.verdict === "FAIL")) console.log(`  FAIL ${r.name}: ${r.detail}`);
    return count("FAIL") > 0;
  }
  return { results, report, check, totals };
}
