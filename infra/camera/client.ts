/**
 * The camera client's control port: `GET /status`, `POST /lua`,
 * `GET /screenshot` on 127.0.0.1 inside the pod, behind a bearer the client
 * container makes per pod and hands over through the shared emptyDir. The
 * director drives it with GM chat commands and client-only Lua; nothing here
 * targets, talks to or acts on anyone.
 */

export interface ClientStatus {
  state?: string;
  in_world?: boolean;
  ui_ready?: boolean;
}

export interface LuaResult {
  ok: boolean;
  values?: unknown[];
  output?: string[];
  error?: string;
}

/** A Lua string literal. */
export function luaString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * GM invisibility is aura 37800 on self; it reads as a debuff, so both lists
 * are searched (the spike's finding: `UnitAura` with no filter misses it).
 */
export const INVISIBLE_LUA =
  'for i=1,40 do local a={UnitDebuff("player",i)} if not a[1] then break end if a[11]==37800 then return true end end ' +
  'for i=1,40 do local a={UnitBuff("player",i)} if not a[1] then break end if a[11]==37800 then return true end end return false';

/** No interface, bubbles or name text in a frame: the world only. */
export const WORLD_ONLY_LUA = [
  "UIParent:Hide()",
  ...["chatBubbles", "chatBubblesParty", "UnitNameOwn", "UnitNameNPC", "UnitNamePlayerGuild", "UnitNamePlayerPVPTitle", "UnitNameFriendlyPlayerName", "UnitNameEnemyPlayerName", "UnitNameFriendlySpecialNPCName", "nameplateShowEnemies", "nameplateShowFriends", "Sound_EnableAllSound"].map(
    (c) => `pcall(SetCVar, ${luaString(c)}, "0")`,
  ),
  "return true",
].join(" ");

/** The subject's distance in the camera's own view, or -1 when it is not streamed. */
export function subjectDistanceLua(name: string): string {
  return `for _,u in ipairs(AgentNearby() or {}) do if u.name==${luaString(name)} then return u.distance end end return -1`;
}

export class CameraClient {
  constructor(
    private readonly base: string,
    private readonly token: () => string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token()}` };
  }

  async status(): Promise<ClientStatus | null> {
    try {
      const r = await this.http(`${this.base}/status`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
      return r.ok ? ((await r.json()) as ClientStatus) : null;
    } catch {
      return null;
    }
  }

  async lua(src: string): Promise<LuaResult> {
    try {
      const r = await this.http(`${this.base}/lua`, { method: "POST", headers: this.headers(), body: src, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return (await r.json()) as LuaResult;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The first value of a Lua call, or undefined when it failed. */
  async value(src: string): Promise<unknown> {
    const r = await this.lua(src);
    return r.ok ? r.values?.[0] : undefined;
  }

  /** A GM command, as the camera's own chat line. Only the director's fixed commands are ever sent. */
  async gm(command: string): Promise<boolean> {
    return (await this.lua(`SendChatMessage(${luaString(command)}, "SAY") return true`)).ok;
  }

  async screenshot(quality: number): Promise<Uint8Array | null> {
    try {
      const r = await this.http(`${this.base}/screenshot?format=jpeg&quality=${quality}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
}
