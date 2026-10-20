/**
 * The on-demand regression suite's logic (`bun wb smoke suite`,
 * infra/smoke/suite.ts): which smokes are in it, on which accounts, which of
 * them may run at the same time, and the one line per smoke it reports.
 *
 * Why it exists: the deploy window verifies a release with the launch gate
 * alone (infra/smoke/preflight.ts). The game-surface smokes that used to sit in
 * `preflight.deploySmokes` (kill-credit, quest-accept-status, module-quest) are
 * regression tests, not liveness checks, so they run here, by hand, whenever the
 * operator wants a suite, with the fleet live.
 *
 * Running it must never pause or hold the fleet, which is a rule about
 * accounts: a smoke's login reclaims any session on its account. So no member
 * may log in on an account the fleet can be using: RUNNER*, SHAKEOUT* (the
 * pool), PROBE (a reference run's), PARTY1-5 (a deadmines campaign's party), or
 * SMOKE (the launch gate's, which the supervisor smokes on every boot and
 * server identity change). That leaves SMOKE2..SMOKE4, which the chart's
 * `worldserver.accounts` permits and the config refuses to schedule.
 *
 * Operator tooling. Nothing in runner/ or sdk/ imports this.
 */

export interface SuiteMember {
  /** The smoke's file under infra/smoke, without `.ts`. */
  name: string;
  /** What it logs in as: MODULE_ACCOUNT. */
  account: string;
  /** Further accounts it logs in on, as the env variable that names each (e.g. swim's observer). */
  also?: Readonly<Record<string, string>>;
}

/**
 * The members. Each account is the one its persistent character lives on, or
 * one with no character of that name yet, so a first run creates it (names are
 * realm-global; each of these derives its name from the account or owns it).
 */
export const SUITE_MEMBERS: readonly SuiteMember[] = [
  // Combat, kill credit, the kill objective completing, loot (`Smokekc` lives on SMOKE2).
  { name: "kill-credit", account: "SMOKE2" },
  // Questgiver status, quest query, accept, turn-in, the chain offer, vendor, char create and delete (`Qasmoked`).
  { name: "quest-accept-status", account: "SMOKE3" },
  // The kill quest's turn-in, reward, XP and level-up from a fixture (`Mqsmokee`).
  { name: "module-quest", account: "SMOKE4" },
  // Smokes that have passed every hand run since their last fix, each on the
  // account its character lives on or derives its name from:
  // move_to's verdict vocabulary: meshZ arrival, target_off_mesh, too_far (`Smokenav` lives on SMOKE3).
  { name: "module-navigation", account: "SMOKE3" },
  // The achievement data at login, a taxi activation and the taxiFlight reading (`Txsmokec` lives on SMOKE2).
  { name: "achievements-taxi", account: "SMOKE2" },
  // The Deadmines instance portal from the Moonbrook mine (`Dminessmokee`).
  { name: "deadmines-entry", account: "SMOKE4" },
  // Looting a chest-type gameobject through the SDK (`Chsmokee`).
  { name: "chest-loot", account: "SMOKE4" },
];

/** Accounts the fleet can hold, and why; a member on one is refused. */
export function fleetHeld(account: string): string | undefined {
  const a = account.toUpperCase();
  if (/^RUNNER\d*$/.test(a) || /^SHAKEOUT\d*$/.test(a)) return "a fleet pool account";
  if (a === "PROBE") return "held by a reference run";
  if (/^PARTY\d+$/.test(a)) return "held by the deadmines campaign's party";
  if (a === "SMOKE") return "the launch gate's account, smoked on every supervisor boot";
  return undefined;
}

/** Every account a member logs in on, case-folded. */
export function accountsOf(m: SuiteMember): string[] {
  return [...new Set([m.account, ...Object.values(m.also ?? {})].map((a) => a.toUpperCase()))];
}

/** Why the members may not run as given, one line each; empty when they may. */
export function refusals(members: readonly SuiteMember[]): string[] {
  const out: string[] = [];
  for (const m of members) {
    for (const a of accountsOf(m)) {
      const why = fleetHeld(a);
      if (why !== undefined) out.push(`${m.name} would log in on ${a}, ${why}`);
    }
  }
  return out;
}

/**
 * The members split into chains that may run at the same time: two members
 * that share any account are in one chain, in member order, because one
 * account holds one live session. Chains are in the order of their first member.
 */
export function chainsOf(members: readonly SuiteMember[]): SuiteMember[][] {
  const chains: { accounts: Set<string>; members: SuiteMember[] }[] = [];
  for (const m of members) {
    const mine = accountsOf(m);
    const touching = chains.filter((c) => mine.some((a) => c.accounts.has(a)));
    const into = touching[0] ?? { accounts: new Set<string>(), members: [] };
    if (touching.length === 0) chains.push(into);
    // A member that bridges two chains merges them, keeping member order.
    for (const other of touching.slice(1)) {
      for (const a of other.accounts) into.accounts.add(a);
      into.members.push(...other.members);
      chains.splice(chains.indexOf(other), 1);
    }
    for (const a of mine) into.accounts.add(a);
    into.members.push(m);
  }
  const order = new Map(members.map((m, i) => [m, i]));
  return chains.map((c) => c.members.sort((a, b) => order.get(a)! - order.get(b)!));
}

export interface SuiteResult {
  member: SuiteMember;
  ok: boolean;
  ms: number;
  /** The smoke's last line of output, or why it did not run to the end. */
  tail: string;
}

export type MemberRunner = (m: SuiteMember) => Promise<Omit<SuiteResult, "member">>;

/**
 * Every chain at once, each chain's members one after another. A failure does
 * not stop its chain: the members are independent claims, and the next
 * login reclaims whatever session a failed one left. Results in member order.
 */
export async function runSuite(members: readonly SuiteMember[], run: MemberRunner): Promise<SuiteResult[]> {
  const results = new Map<SuiteMember, SuiteResult>();
  await Promise.all(
    chainsOf(members).map(async (chain) => {
      for (const m of chain) {
        const r = await run(m).catch((e: unknown) => ({ ok: false, ms: 0, tail: `could not run: ${String(e instanceof Error ? e.message : e)}` }));
        results.set(m, { member: m, ...r });
      }
    }),
  );
  return members.map((m) => results.get(m)!);
}

/** One line per smoke, PASS or FAIL with its account and duration, then the totals. */
export function formatSummary(results: readonly SuiteResult[], wallMs: number): string[] {
  const w = Math.max(...results.map((r) => r.member.name.length), 4);
  const lines = results.map((r) => {
    const head = `${r.ok ? "PASS" : "FAIL"}  ${r.member.name.padEnd(w)}  ${accountsOf(r.member).join("+").padEnd(7)}  ${(r.ms / 1000).toFixed(1).padStart(6)}s`;
    return r.ok ? head : `${head}  ${r.tail}`;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push(`suite: ${results.length} smoke(s), ${results.length - failed} passed, ${failed} failed, ${(wallMs / 1000).toFixed(1)}s wall`);
  return lines;
}

/** Write a child's output line by line, each line with the smoke's name in front; `keep` gathers the non-blank lines. */
export async function pipeLines(stream: ReadableStream<Uint8Array>, name: string, write: (s: string) => void, keep: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (line: string) => {
    write(`[${name}] ${line}\n`);
    if (line.trim() !== "") keep.push(line);
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      emit(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf !== "") emit(buf);
}

export interface SpawnOptions {
  /** Where the member scripts are: `<dir>/<name>.ts`. */
  dir: string;
  cwd: string;
  timeoutMs: number;
  out: { stdout: (s: string) => void; stderr: (s: string) => void };
  env?: Record<string, string | undefined>;
}

/**
 * One member as a child, `bun <dir>/<name>.ts` with MODULE_ACCOUNT (and its
 * `also` variables) set, its output attributed line by line, SIGKILLed at
 * `timeoutMs`. The verdict is its exit code; the tail is its last line.
 */
export async function spawnMember(m: SuiteMember, o: SpawnOptions): Promise<Omit<SuiteResult, "member">> {
  const t0 = Date.now();
  const proc = Bun.spawn(["bun", `${o.dir}/${m.name}.ts`], {
    cwd: o.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(o.env ?? process.env), MODULE_ACCOUNT: m.account, ...m.also },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, o.timeoutMs);
  const lines: string[] = [];
  const [code] = await Promise.all([proc.exited, pipeLines(proc.stdout, m.name, o.out.stdout, lines), pipeLines(proc.stderr, m.name, o.out.stderr, lines)]);
  clearTimeout(timer);
  const ms = Date.now() - t0;
  const last = lines.at(-1) ?? "no output";
  if (timedOut) return { ok: false, ms, tail: `killed after ${Math.round(o.timeoutMs / 1000)}s; last line: ${last}` };
  return { ok: code === 0, ms, tail: code === 0 ? last : `exit ${code}: ${last}` };
}

/** The members a command line names (all of them for none), or the names it got wrong. */
export function select(argv: readonly string[], members: readonly SuiteMember[] = SUITE_MEMBERS): { members: SuiteMember[] } | { unknown: string[] } {
  const names = argv.filter((a) => !a.startsWith("-"));
  if (names.length === 0) return { members: [...members] };
  const unknown = names.filter((n) => !members.some((m) => m.name === n));
  if (unknown.length > 0) return { unknown };
  return { members: members.filter((m) => names.includes(m.name)) };
}
