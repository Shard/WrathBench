/**
 * What paid for a run, as its launch config recorded it: a v1 run's
 * credential id (`RunConfig.credential`), or a 0.5 run's subscription lane —
 * the env var NAME a claude-code or codex run billed (`RunConfig.subscription`),
 * which v1 reads and never writes. Empty when the run recorded neither (a 0.5
 * run on the default lane or an endpoint, a run launched by hand). Only the
 * fields recorded are present, so a reader of an old run sees what it saw.
 *
 * A leaf, so a reader of a run's row does not load the credential slots
 * (`credential-slots.ts`) to name what the run recorded.
 */
export function runCredentialOf(config: unknown): { credential?: string; lane?: string } {
  if (typeof config !== "object" || config === null) return {};
  const c = config as { credential?: unknown; subscription?: unknown };
  return {
    ...(typeof c.credential === "string" && c.credential.length > 0 ? { credential: c.credential } : {}),
    ...(typeof c.subscription === "string" && c.subscription.length > 0 ? { lane: c.subscription } : {}),
  };
}
