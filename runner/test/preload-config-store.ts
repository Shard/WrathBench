/**
 * Tests never read the operator's live config store.
 *
 * `readFleetText` (runner/src/config-store.ts) prefers the config store over
 * whatever fleet.json a caller names, which is the whole point of item 127 —
 * and which would quietly make every fixture that writes its own fleet.json
 * assert against the operator's real roster the day they seed a store. The
 * suite must be green from a bare clone AND on the machine that runs the
 * fleet, so the store is pinned out of the way here, once, before any test
 * file loads. Unconditional, not "unless already set": a suite whose answer
 * depends on the environment it was run in is the failure this prevents. A
 * test that wants a store passes its own path or its own env object, which
 * every caller in `config-store.ts` takes.
 */

process.env["WRATHBENCH_CONFIG_DB"] = "/nonexistent/wrathbench-test/config.sqlite";
