/**
 * Tests never read the operator's live config store.
 *
 * `readFleetConfig` (runner/src/config-store.ts) reads the config store at
 * `WRATHBENCH_CONFIG_DB` (else `$WRATHBENCH_DATA/config.sqlite`, else the
 * checkout's `data/config.sqlite`) and nothing else — which would quietly make
 * every fixture that expects an empty board assert against the operator's real
 * roster on a machine with a seeded store. The suite must be green from a bare
 * clone AND on the machine that runs the fleet, so the store is pinned to a
 * path that does not exist here, once, before any test file loads. Unconditional, not "unless already set": a suite whose answer
 * depends on the environment it was run in is the failure this prevents. A
 * test that wants a store passes its own path or its own env object, which
 * every caller in `config-store.ts` takes.
 */

process.env["WRATHBENCH_CONFIG_DB"] = "/nonexistent/wrathbench-test/config.sqlite";
