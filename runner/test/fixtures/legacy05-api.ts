/**
 * An in-process viewer over the frozen 0.5 runs (`legacy05.ts`), and one GET
 * as a golden holds it. Kept apart from the loader so the loader stays free of
 * everything under `runner/`.
 *
 * The viewer takes no clock: a caller freezes it with `setSystemTime` at
 * `LEGACY05_NOW` before the first request, and resets it after the last.
 */

import { join } from "node:path";
import { createApi } from "../../viewer/api";
import { localRunStore } from "../../viewer/clickhouse";

/** One handle over a materialised runs directory: the local store, no module, no tiles. */
export function legacy05Api(runsDir: string, publicMode: boolean): ReturnType<typeof createApi> {
  return createApi({
    runsDir,
    tilesDir: join(runsDir, "..", "tiles"),
    publicMode,
    moduleUrl: "http://127.0.0.1:1",
    store: localRunStore(runsDir),
  });
}

/** What a golden holds of one response: the status, the two headers a reader keys on, and the body. */
export interface Legacy05Answer {
  path: string;
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: unknown;
}

/** GET `path` from a handle; a JSON body parsed, any other kept as text. */
export async function legacy05Get(handle: (req: Request) => Promise<Response>, path: string): Promise<Legacy05Answer> {
  const res = await handle(new Request(`http://viewer.local${path}`));
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  return {
    path,
    status: res.status,
    contentType,
    cacheControl: res.headers.get("cache-control"),
    body: contentType?.startsWith("application/json") === true ? (JSON.parse(text) as unknown) : text,
  };
}
