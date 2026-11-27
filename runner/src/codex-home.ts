/**
 * What a Codex home on disk says about its login, and nothing else: a leaf,
 * so the login flow (`codex-login.ts`) and the admin page that reads it need
 * not load the codex driver (`adapter-codex.ts`, which re-exports this) and
 * the agent loop behind it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Whether a Codex home looks logged in: the CLI keeps the login in auth.json there. */
export function homeLooksLoggedIn(codexHome: string | undefined): boolean {
  return codexHome !== undefined && codexHome.length > 0 && existsSync(join(codexHome, "auth.json"));
}
