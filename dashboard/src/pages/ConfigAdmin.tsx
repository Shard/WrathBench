/**
 * The admin page's sections beside the roster (GitHub issue #427): the agent
 * stack (wrath-mcp: the module's status, the store's sessions and how to
 * connect an agent), the providers (credentials with their health), freeplay
 * agents, campaigns, the queue, and the deployment's groups and publishing.
 * Each writing one is one more client of the
 * config store: every write goes through the page's `write` (the version
 * check) to `/api/config`, where `parseFleet` judges
 * the whole candidate config, so a refusal here is the supervisor's own
 * sentence. The status beside the rows is `/api/admin`'s and is read-only.
 *
 * What a secret's value is never appears: a credential names the env var its
 * secret is in, and the page says whether it is set. A secret typed or pasted
 * here goes to the store sealed and is never read back
 * (`runner/viewer/admin-api.ts`); a Codex home is logged in again by the
 * supervisor, and the page shows the link and the one-time code it waits on.
 */

import { A } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { AdminCodexLoginView, AdminCredentialView, AdminProviderView, AdminResponse, WrathMcpModuleView, WrathMcpView } from "@viewer/api-types";
import { configApi } from "../api/config-client";
import { InfoHint } from "../components/InfoHint";
import { STACK_URL } from "../lib/repo";
import {
  AGENT_MODULE_URL,
  CONNECT_FORMS,
  EMPTY_CREDENTIAL,
  GROUP_ROWS,
  LIMIT_ROWS,
  MODULE_SECRET_ENV,
  QUEUE_EPISODES,
  canCopy,
  connectSnippet,
  fmtLimit,
  moduleErrorText,
  type ConnectForm,
  campaignDoc,
  campaignRows,
  credentialDoc,
  credentialFormOf,
  fmtDelay,
  fixLabel,
  freeplayRows,
  healthTitle,
  healthTone,
  jobDoc,
  loginInFlight,
  nextQueueKey,
  publishedDefs,
  queueRows,
  secretControl,
  secretControlLabel,
  secretControlOff,
  storedCredentialRows,
  type BudgetKind,
  type NewCredentialForm,
  type NewJobForm,
} from "../lib/admin";
import { fmtDuration, fmtWhen, stamp } from "../lib/format";

type Write = (fn: () => Promise<unknown>) => Promise<string | null>;

/** A section's one result line: saved, or the refusal verbatim. */
function useResult(): { line: () => { ok: boolean; text: string } | null; run: (p: Promise<string | null>, done: string) => Promise<void> } {
  const [line, setLine] = createSignal<{ ok: boolean; text: string } | null>(null);
  return {
    line,
    run: async (p, done) => {
      const err = await p;
      setLine(err === null ? { ok: true, text: done } : { ok: false, text: err });
    },
  };
}

function ResultLine(props: { line: { ok: boolean; text: string } | null }) {
  return (
    <Show when={props.line}>
      {(l) => <p class={l().ok ? "ok" : "err"}>{l().text}</p>}
    </Show>
  );
}

/** Whether a credential's variable is set, as the supervisor last said; unknown while it is not up. */
function SecretState(props: { c: AdminCredentialView }) {
  return (
    <>
      <span class="mono">{props.c.secretEnv}</span>{" "}
      <Show
        when={props.c.secretSet !== null}
        fallback={
          <span class="dim" title="no supervisor is up to say whether its environment has this variable">
            ?
          </span>
        }
      >
        <Show when={props.c.secretSet} fallback={<span class="err" title="neither the config store nor the supervisor's environment has this variable">not set</span>}>
          <span class="ok" title="set; its value is never shown">set</span>
        </Show>
      </Show>
      <Show when={props.c.stored}>
        {" "}
        <span class="dim" title="sealed in the config store, set from this page or the CLI; it wins over the deployment's Secret">stored</span>
      </Show>
      <Show when={props.c.deployed === false && !props.c.stored}>
        {" "}
        <span class="warn" title="not in the chart's modelKeys, so no pod that runs a model carries it">not in chart</span>
      </Show>
    </>
  );
}

/** How often the page asks after a Codex login under way: its link, then its end. */
const LOGIN_POLL_MS = 2_000;

export function ProvidersSection(props: { admin: AdminResponse | undefined; config: Record<string, unknown>; write: Write; refreshAdmin: () => Promise<void> }) {
  const r = useResult();
  const rows = createMemo(() => storedCredentialRows(props.config));
  // Polled only while a login is under way: the page is otherwise still.
  createEffect(() => {
    if (!(props.admin?.credentials ?? []).some((c) => loginInFlight(c.login))) return;
    const t = setInterval(() => void props.refreshAdmin(), LOGIN_POLL_MS);
    onCleanup(() => clearInterval(t));
  });
  const toggle = (c: AdminCredentialView): Promise<void> =>
    r.run(props.write(() => configApi.patch(`credentials/${c.id}`, { enabled: !c.enabled })), `${c.id} ${c.enabled ? "disabled" : "enabled"}`);
  const remove = (c: AdminCredentialView): Promise<void> => r.run(props.write(() => configApi.remove(`credentials/${c.id}`)), `${c.id} removed`);
  return (
    <>
      <h3 class="section">providers</h3>
      <Show when={props.admin} fallback={<p class="dim">loading…</p>}>
        {(a) => (
          <>
            <div class="scroller">
              <table class="configtable">
                <thead>
                  <tr>
                    <th>credential</th>
                    <th title={a().fleet.up ? "as the supervisor last saw it, with the store's switch and the chart's modelKeys" : "no supervisor is up: only what the store and the chart say"}>health</th>
                    <th title={a().fleet.up ? "as the supervisor last saw its environment" : "no supervisor is up: whether each is set is unknown"}>secret</th>
                    <th title="sessions on its slots now, of its slots">slots</th>
                    <th title="its budget, then its usage windows as last read or what the budget has used today">budget</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <Show when={a().credentials.length === 0}>
                    <tr>
                      <td colSpan={6} class="dim">
                        No credentials.
                      </td>
                    </tr>
                  </Show>
                  <For each={a().credentials}>
                    {(c) => (
                      <CredentialRow
                        c={c}
                        admin={a()}
                        provider={a().providers.find((p) => p.id === c.provider)}
                        providers={a().providers}
                        row={rows()[c.id]}
                        write={props.write}
                        toggle={() => void toggle(c)}
                        remove={() => void remove(c)}
                      />
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <ResultLine line={r.line()} />
            <AddCredential admin={a()} write={props.write} />
          </>
        )}
      </Show>
    </>
  );
}

/** The health cell: the state as a badge, the reason, and a fix that is a wait rather than a control. */
function HealthCell(props: { c: AdminCredentialView }) {
  const tone = (): string => healthTone(props.c.health?.state ?? null);
  return (
    <Show
      when={props.c.health}
      fallback={
        <span class="badge" title="no supervisor is up to say">
          unknown
        </span>
      }
    >
      {(h) => (
        <>
          <span class={`badge ${tone()}`} title={healthTitle(h(), stamp)}>
            {h().state}
          </span>
          <Show when={h().reason !== "" && h().state !== "disabled"}>
            <div class={tone()} title={healthTitle(h(), stamp)}>
              {h().reason}
            </div>
          </Show>
          <Show when={props.c.fix !== null && (props.c.fix.kind === "wait-reset" || props.c.fix.kind === "raise-budget") ? props.c.fix : undefined}>
            {(f) => (
              <div class="dim" title={f().text}>
                {fixLabel(f(), stamp)}
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

/** Used: the windows as meters when there is a reading, else the budget's own count. */
function UsedCell(props: { c: AdminCredentialView }) {
  return (
    <Show when={props.c.windows !== null && props.c.windows.length > 0 ? props.c.windows : undefined} fallback={<Show when={props.c.used}>{(u) => <div class="dim">{u()}</div>}</Show>}>
      {(ws) => (
        <For each={ws()}>
          {(w) => (
            <div class={w.limited ? "err" : "dim"} title={w.resetsAt !== null ? `resets ${stamp(w.resetsAt)}` : undefined}>
              {w.name}
              {w.family !== undefined ? ` ${w.family}` : ""} {Math.round(w.usedPercent)}%
            </div>
          )}
        </For>
      )}
    </Show>
  );
}

/** A Codex login's line: the link and the code while it waits, then how it ended. */
function LoginLine(props: { login: AdminCodexLoginView }) {
  return (
    <div>
      <Show when={props.login.state === "requested" || props.login.state === "starting"}>
        <span class="dim">login starting…</span>
      </Show>
      <Show when={props.login.state === "waiting" && props.login.url !== null ? props.login : undefined}>
        {(l) => (
          <>
            <a href={l().url!} target="_blank" rel="noopener noreferrer">
              {l().url}
            </a>{" "}
            <span class="mono" title={l().expiresAt !== null ? `enter it there before ${stamp(l().expiresAt!)}` : "enter it there"}>
              {l().code}
            </span>
          </>
        )}
      </Show>
      <Show when={props.login.state === "ok"}>
        <span class="ok" title={props.login.actor !== null ? `by ${props.login.actor}` : ""}>
          logged in {fmtWhen(props.login.at)}
        </span>
      </Show>
      <Show when={props.login.state === "failed"}>
        <span class="err">login failed: {props.login.detail ?? "unknown"}</span>
      </Show>
    </div>
  );
}

/** A secret typed or pasted in, write-only: a password field, cleared once sent. */
function SecretForm(props: { c: AdminCredentialView; kind: "key" | "token"; write: Write; close: () => void }) {
  const [value, setValue] = createSignal("");
  const r = useResult();
  const save = (): void => {
    const v = value();
    if (v.trim() === "") {
      void r.run(Promise.resolve(props.kind === "token" ? "paste the token" : "type the key"), "");
      return;
    }
    void r.run(props.write(() => configApi.setSecret(props.c.secretEnv, v)), `${props.c.secretEnv} stored`).then(() => {
      if (r.line()?.ok !== true) return;
      setValue("");
      props.close();
    });
  };
  return (
    <>
      <div class="configform">
        <label title={props.kind === "token" ? "the token `claude setup-token` prints; sealed in the config store and never shown again" : "sealed in the config store and never shown again; it wins over the deployment's Secret"}>
          {props.kind === "token" ? "token" : "key"} for {props.c.secretEnv}
          <input type="password" autocomplete="new-password" spellcheck={false} value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
        </label>
        <button type="button" onClick={save}>
          store
        </button>
        <button type="button" onClick={() => props.close()}>
          cancel
        </button>
      </div>
      <ResultLine line={r.line()} />
    </>
  );
}

function CredentialRow(props: {
  c: AdminCredentialView;
  admin: AdminResponse;
  provider: AdminProviderView | undefined;
  providers: readonly AdminProviderView[];
  row: unknown;
  write: Write;
  toggle: () => void;
  remove: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [entering, setEntering] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const secret = useResult();
  const kind = (): "key" | "token" | "login" | null => secretControl(props.provider);
  const off = (): string | null => {
    const k = kind();
    return k === null ? "unknown provider" : secretControlOff(k, props.c, { storeKey: props.admin.storeKey, fleetUp: props.admin.fleet.up });
  };
  const fixText = (): string => {
    const f = props.c.fix;
    const k = kind();
    const how = k === "login" ? "the supervisor runs codex login --device-auth on this home" : k === "token" ? "paste a token from claude setup-token" : "type a new key";
    return [off(), f !== null && (f.kind === "set-secret" || f.kind === "replace-secret") ? f.text : null, how].filter((x): x is string => x !== null).join("; ");
  };
  const onSecret = (): void => {
    if (kind() === "login") void secret.run(props.write(() => configApi.codexLogin(props.c.id)), "login asked for");
    else setEntering(!entering());
  };
  const clear = (): void => {
    setClearing(false);
    void secret.run(props.write(() => configApi.clearSecret(props.c.secretEnv)), `${props.c.secretEnv} cleared`);
  };
  return (
    <>
      <tr>
        <td>
          <div class="mono">{props.c.id}</div>
          <div class="dim" title={props.provider?.label ?? ""}>
            {props.c.provider} · {props.c.billing}
          </div>
        </td>
        <td>
          <HealthCell c={props.c} />
        </td>
        <td>
          <SecretState c={props.c} />{" "}
          <Show when={kind()}>
            {(k) => (
              <button type="button" class={entering() ? "on" : ""} disabled={off() !== null} title={fixText()} onClick={onSecret}>
                {secretControlLabel(k())}
              </button>
            )}
          </Show>{" "}
          <Show when={props.c.stored}>
            <Show
              when={clearing()}
              fallback={
                <button type="button" title="remove the stored secret: the deployment's Secret stands again" onClick={() => setClearing(true)}>
                  clear
                </button>
              }
            >
              <button type="button" class="on" onClick={clear}>
                really clear
              </button>{" "}
              <button type="button" onClick={() => setClearing(false)}>
                cancel
              </button>
            </Show>
          </Show>
          <Show when={props.c.login}>{(l) => <LoginLine login={l()} />}</Show>
          <ResultLine line={secret.line()} />
        </td>
        <td class="mono">
          {props.c.inUse === null ? "?" : String(props.c.inUse)}/{props.c.slots}
        </td>
        <td>
          <div class="dim">{props.c.budget}</div>
          <UsedCell c={props.c} />
        </td>
        <td>
          <button type="button" class={props.c.enabled ? "on" : ""} title={props.c.enabled ? "enabled: click to disable (live runs finish)" : "disabled: click to enable"} onClick={props.toggle}>
            {props.c.enabled ? "enabled" : "disabled"}
          </button>{" "}
          <button type="button" class={editing() ? "on" : ""} onClick={() => setEditing(!editing())}>
            edit
          </button>{" "}
          <Show
            when={confirming()}
            fallback={
              <button type="button" onClick={() => setConfirming(true)}>
                remove
              </button>
            }
          >
            <button type="button" class="on" onClick={props.remove}>
              really remove {props.c.id}
            </button>{" "}
            <button type="button" onClick={() => setConfirming(false)}>
              cancel
            </button>
          </Show>
        </td>
      </tr>
      <Show when={entering() && (kind() === "key" || kind() === "token") ? (kind() as "key" | "token") : undefined}>
        {(k) => (
          <tr>
            <td colSpan={6}>
              <SecretForm c={props.c} kind={k()} write={props.write} close={() => setEntering(false)} />
            </td>
          </tr>
        )}
      </Show>
      <Show when={editing()}>
        <tr>
          <td colSpan={6}>
            <CredentialForm
              providers={props.providers}
              initial={credentialFormOf(props.c.id, props.row)}
              enabled={props.c.enabled}
              write={props.write}
              close={() => setEditing(false)}
            />
          </td>
        </tr>
      </Show>
    </>
  );
}

function AddCredential(props: { admin: AdminResponse; write: Write }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="detail">
      <Show
        when={open()}
        fallback={
          <button type="button" onClick={() => setOpen(true)}>
            add a credential
          </button>
        }
      >
        <CredentialForm providers={props.admin.providers} initial={{ ...EMPTY_CREDENTIAL }} write={props.write} close={() => setOpen(false)} />
      </Show>
    </div>
  );
}

/**
 * A credential's non-secret fields, new or existing. A new one names its id
 * and provider and is written disabled; an existing one keeps both and its
 * switch, and is written whole (`credentialDoc`).
 */
function CredentialForm(props: {
  providers: readonly AdminProviderView[];
  initial: NewCredentialForm;
  /** Set on an edit: the row's own switch, which the write keeps. */
  enabled?: boolean;
  write: Write;
  close: () => void;
}) {
  const editing = props.enabled !== undefined;
  const [form, setForm] = createSignal<NewCredentialForm>(props.initial);
  const r = useResult();
  const provider = () => props.providers.find((p) => p.id === form().provider);
  const set = <K extends keyof NewCredentialForm>(k: K, v: NewCredentialForm[K]): void => {
    setForm({ ...form(), [k]: v });
  };
  const save = (): void => {
    const doc = credentialDoc(form(), editing ? { enabled: props.enabled! } : {});
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    void r.run(props.write(() => configApi.put(doc.key, doc.body)), editing ? `${form().id} saved` : `${form().id} added, disabled`).then(() => {
      if (r.line()?.ok === true && !editing) setForm({ ...EMPTY_CREDENTIAL });
    });
  };
  const limitLabel = (): string => (form().budget === "usage" ? "scored %" : form().budget === "spend" ? "$ / day" : "runs / day");
  return (
    <>
      <div class="configform">
        <Show when={!editing}>
          <label>
            id
            <input type="text" value={form().id} onInput={(e) => set("id", e.currentTarget.value)} />
          </label>
          <label>
            provider
            <select
              onChange={(e) => {
                const p = props.providers.find((x) => x.id === e.currentTarget.value);
                setForm({ ...form(), provider: e.currentTarget.value, secretEnv: p?.envBase ?? "", budget: "none" });
              }}
            >
              <option value="" selected={form().provider === ""}>
                —
              </option>
              <For each={props.providers}>{(p) => <option value={p.id} selected={form().provider === p.id} title={p.label}>{p.id}</option>}</For>
            </select>
          </label>
        </Show>
        <label title={provider() === undefined ? "" : `${provider()!.envBase}, or ${provider()!.envBase}_<n> for a second one; the value goes in the deployment's Secret, never here`}>
          secret env var
          <input type="text" value={form().secretEnv} onInput={(e) => set("secretEnv", e.currentTarget.value)} />
        </label>
        <label>
          slots
          <input type="text" size={4} value={form().slots} onInput={(e) => set("slots", e.currentTarget.value)} />
        </label>
        <label title={provider()?.bill === "subscription" ? "descriptive on a subscription: every model on it bills the plan" : "which models it carries: free ones or paid ones"}>
          billing
          <select onChange={(e) => set("billing", e.currentTarget.value as NewCredentialForm["billing"])}>
            <option value="paid" selected={form().billing === "paid"}>
              paid
            </option>
            <option value="free" selected={form().billing === "free"}>
              free
            </option>
          </select>
        </label>
        <label title="default: usage below 80% where it bills a plan with usage windows, else no budget">
          budget
          <select onChange={(e) => set("budget", e.currentTarget.value as BudgetKind)}>
            <option value="none" selected={form().budget === "none"}>
              default
            </option>
            <For each={provider()?.budgets ?? []}>{(b) => <option value={b} selected={form().budget === b}>{b}</option>}</For>
          </select>
        </label>
        <Show when={form().budget !== "none"}>
          <label>
            {limitLabel()}
            <input type="text" size={5} value={form().limit} onInput={(e) => set("limit", e.currentTarget.value)} />
          </label>
        </Show>
        <Show when={form().budget === "usage"}>
          <label title="empty: the same as scored">
            freeplay %
            <input type="text" size={5} value={form().freeplayLimit} onInput={(e) => set("freeplayLimit", e.currentTarget.value)} />
          </label>
        </Show>
        <button type="button" onClick={save}>
          {editing ? "save" : "add"}
        </button>
        <button type="button" onClick={() => props.close()}>
          {editing ? "cancel" : "close"}
        </button>
      </div>
      <ResultLine line={r.line()} />
    </>
  );
}

export function FreeplaySection(props: { config: Record<string, unknown>; write: Write }) {
  const r = useResult();
  const rows = createMemo(() => freeplayRows(props.config["roster"]));
  const flip = (name: string, playing: boolean): Promise<void> =>
    r.run(props.write(() => configApi.patch(`roster/${name}`, { idle: playing ? "none" : "unlimited" })), `${name} ${playing ? "stopped" : "playing"}`);
  return (
    <>
      <h3 class="section" title="a roster entry with idle: unlimited keeps one durable freeplay character playing once it owes no counted run; stopping it pauses the character, and starting it again brings the same one back">
        freeplay agents
      </h3>
      <div class="scroller">
        <table class="configtable">
          <thead>
            <tr>
              <th>entry</th>
              <th>model</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show when={rows().length === 0}>
              <tr>
                <td colSpan={3} class="dim">
                  No roster entries.
                </td>
              </tr>
            </Show>
            <For each={rows()}>
              {(row) => (
                <tr>
                  <td class="mono">{row.name}</td>
                  <td class="dim">{row.model}</td>
                  <td>
                    <button type="button" class={row.playing ? "on" : ""} onClick={() => void flip(row.name, row.playing)}>
                      {row.playing ? "playing" : "stopped"}
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <ResultLine line={r.line()} />
    </>
  );
}

export function CampaignsSection(props: { config: Record<string, unknown>; write: Write }) {
  const r = useResult();
  const rows = createMemo(() => campaignRows(props.config["campaigns"]));
  const defs = createMemo(() => publishedDefs(props.config["campaign-defs"]));
  const roster = createMemo(() => Object.keys((props.config["roster"] as Record<string, unknown> | undefined) ?? {}));
  const [def, setDef] = createSignal("");
  const [models, setModels] = createSignal<string[]>([]);
  const [runs, setRuns] = createSignal("1");
  const toggle = (name: string, enabled: boolean): Promise<void> =>
    r.run(props.write(() => configApi.patch(`campaigns/${name}`, { enabled: !enabled })), `${name} ${enabled ? "disabled" : "enabled"}`);
  const remove = (name: string): Promise<void> => r.run(props.write(() => configApi.remove(`campaigns/${name}`)), `${name} removed`);
  const add = (): void => {
    const doc = campaignDoc({ def: def(), models: models(), runsPerCell: runs() });
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    void r.run(props.write(() => configApi.put(doc.key, doc.body)), `${doc.key.slice("campaigns/".length)} added, disabled`);
  };
  return (
    <>
      <h3 class="section" title="probe campaigns: a published definition (bun wb campaign publish) and who runs it; the policy schedules an enabled one between the evals and the idle work">
        campaigns
      </h3>
      <div class="scroller">
        <table class="configtable">
          <thead>
            <tr>
              <th>campaign</th>
              <th>version</th>
              <th>assignments</th>
              <th>pinned</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show when={rows().length === 0}>
              <tr>
                <td colSpan={5} class="dim">
                  No campaigns.
                </td>
              </tr>
            </Show>
            <For each={rows()}>
              {(c) => (
                <tr>
                  <td class="mono">{c.name}</td>
                  <td class="mono">
                    {c.version ?? "?"}
                    <Show when={c.concluded.length > 0}>
                      <span class="dim" title="versions declared concluded"> · concluded {c.concluded.join(", ")}</span>
                    </Show>
                  </td>
                  <td class="dim">{c.assignments.map((a) => `${a.model} ×${a.runsPerCell}`).join(", ")}</td>
                  <td class="dim mono">{[c.account, c.credential].filter((x) => x !== null).join(" · ") || "—"}</td>
                  <td>
                    <button type="button" class={c.enabled ? "on" : ""} onClick={() => void toggle(c.name, c.enabled)}>
                      {c.enabled ? "enabled" : "disabled"}
                    </button>{" "}
                    <button type="button" onClick={() => void remove(c.name)}>
                      remove
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <ResultLine line={r.line()} />
      <Show when={defs().length > 0}>
        <div class="configform">
          <label>
            definition
            <select onChange={(e) => setDef(e.currentTarget.value)}>
              <option value="" selected={def() === ""}>
                —
              </option>
              <For each={defs()}>{(d) => <option value={`${d.id}@${d.version}`} selected={def() === `${d.id}@${d.version}`}>{`${d.id}@${d.version}`}</option>}</For>
            </select>
          </label>
          <label>
            entries
            <select
              multiple
              size={Math.min(6, Math.max(2, roster().length))}
              onChange={(e) => setModels([...e.currentTarget.selectedOptions].map((o) => o.value))}
            >
              <For each={roster()}>{(n) => <option value={n} selected={models().includes(n)}>{n}</option>}</For>
            </select>
          </label>
          <label>
            runs per cell
            <input type="text" size={4} value={runs()} onInput={(e) => setRuns(e.currentTarget.value)} />
          </label>
          <button type="button" onClick={add}>
            add a campaign
          </button>
        </div>
      </Show>
    </>
  );
}

export function QueueSection(props: { config: Record<string, unknown>; keys: readonly string[]; write: Write }) {
  const r = useResult();
  const rows = createMemo(() => queueRows(props.config["queue"], props.keys));
  const roster = createMemo(() => Object.keys((props.config["roster"] as Record<string, unknown> | undefined) ?? {}));
  const [form, setForm] = createSignal<NewJobForm>({ ref: "", episode: "e90", repeat: "1", enabled: false });
  const toggle = (key: string, enabled: boolean): Promise<void> =>
    r.run(props.write(() => configApi.patch(key, { enabled: !enabled })), `${key} ${enabled ? "disabled" : "enabled"}`);
  const remove = (key: string): Promise<void> => r.run(props.write(() => configApi.remove(key)), `${key} removed`);
  const add = (): void => {
    const doc = jobDoc(form());
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    const key = nextQueueKey(props.keys);
    void r.run(props.write(() => configApi.put(key, doc)), `${key} added`);
  };
  return (
    <>
      <h3 class="section" title="jobs, in priority order: a roster entry, an episode and a repeat count; disabling one drains it at its episode boundary">
        queue
      </h3>
      <div class="scroller">
        <table class="configtable">
          <thead>
            <tr>
              <th>job</th>
              <th>entries</th>
              <th>episode</th>
              <th>repeat</th>
              <th>pinned</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show when={rows().length === 0}>
              <tr>
                <td colSpan={6} class="dim">
                  No queue jobs.
                </td>
              </tr>
            </Show>
            <For each={rows()}>
              {(j) => (
                <tr>
                  <td class="mono">{j.key}</td>
                  <td class="mono">{j.refs.join(", ")}</td>
                  <td>{j.episode}</td>
                  <td>{j.repeat ?? "?"}</td>
                  <td class="dim mono">{[j.account, j.credential].filter((x) => x !== null).join(" · ") || "—"}</td>
                  <td>
                    <button type="button" class={j.enabled ? "on" : ""} onClick={() => void toggle(j.key, j.enabled)}>
                      {j.enabled ? "enabled" : "disabled"}
                    </button>{" "}
                    <button type="button" onClick={() => void remove(j.key)}>
                      remove
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <ResultLine line={r.line()} />
      <div class="configform">
        <label>
          entry
          <select onChange={(e) => setForm({ ...form(), ref: e.currentTarget.value })}>
            <option value="" selected={form().ref === ""}>
              —
            </option>
            <For each={roster()}>{(n) => <option value={n} selected={form().ref === n}>{n}</option>}</For>
          </select>
        </label>
        <label>
          episode
          <select onChange={(e) => setForm({ ...form(), episode: e.currentTarget.value })}>
            <For each={QUEUE_EPISODES}>{(ep) => <option value={ep} selected={form().episode === ep}>{ep}</option>}</For>
          </select>
        </label>
        <label title="a total of counted runs, or loop">
          repeat
          <input type="text" size={4} value={form().repeat} onInput={(e) => setForm({ ...form(), repeat: e.currentTarget.value })} />
        </label>
        <label>
          enabled
          <input type="checkbox" checked={form().enabled} onChange={(e) => setForm({ ...form(), enabled: e.currentTarget.checked })} />
        </label>
        <button type="button" onClick={add}>
          add a job
        </button>
      </div>
    </>
  );
}

/** A copy button that is there only where it can work; the text it copies stays selectable either way. */
export function CopyButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <Show when={canCopy(typeof window === "undefined" ? undefined : window)}>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(props.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied() ? "copied" : "copy"}
      </button>
    </Show>
  );
}

/** One status row: a key with its hover, a value, and a dim detail. */
function StatusRow(props: { name: string; title: string; children: JSX.Element; detail?: JSX.Element }) {
  return (
    <tr>
      <td class="mono" title={props.title}>
        {props.name}
      </td>
      <td>{props.children}</td>
      <td class="dim">{props.detail}</td>
    </tr>
  );
}

/**
 * The agent stack: the module as its `/health` answers the viewer, the
 * sessions the viewer reads from the store, and how to connect an agent.
 * Read-only; every deployment has it, store or no store.
 */
export function WrathMcpSection(props: { admin: AdminResponse | undefined }) {
  const [form, setForm] = createSignal<ConnectForm>("claude");
  const snippet = (): string => connectSnippet(form());
  return (
    <Show when={props.admin} fallback={<p class="dim">loading…</p>}>
      {(a) => {
        const w = (): WrathMcpView => a().wrathMcp;
        const m = (): WrathMcpModuleView | null => w().module;
        return (
          <>
            <h3 class="section" title="the module as its /health answers this viewer, with the port secret, and the sessions this viewer reads; read here, configured in mod_wrathbench.conf and the viewer's environment">
              status
            </h3>
            <div class="scroller">
              <table class="configtable">
                <tbody>
                  <StatusRow
                    name="module"
                    title="whether the module answers this viewer's /health"
                    detail={
                      <Show when={m()}>
                        {(mm) => (
                          <span class="mono" title="the viewer's own route to the module, which an agent does not use">
                            {mm().url}
                          </span>
                        )}
                      </Show>
                    }
                  >
                    <Show
                      when={m()}
                      fallback={
                        <Show when={w().moduleError}>
                          {(e) => (
                            <span class={e() === "unset" ? "dim" : "err"} title={moduleErrorText(e(), w().secret.env).title}>
                              {moduleErrorText(e(), w().secret.env).word}
                            </span>
                          )}
                        </Show>
                      }
                    >
                      {(mm) => (mm().ok ? <span class="ok">ok</span> : <span class="err" title="it answered 503: the world did not load whole">not ready</span>)}
                    </Show>
                  </StatusRow>
                  <StatusRow name="port secret" title="what the viewer authenticates /health with; its value is never shown">
                    <span class="mono">{w().secret.env}</span>{" "}
                    {w().secret.set ? <span class="ok">set</span> : <span class="warn">not set</span>}
                  </StatusRow>
                  <Show when={m()}>
                    {(mm) => (
                      <>
                        <StatusRow name="build" title="the build stamp the module was compiled with">
                          <span class="mono">{mm().build ?? "—"}</span>
                        </StatusRow>
                        <StatusRow name="protocol" title="the wire protocol version the module speaks; the SDK checks it on connect">
                          <span class="mono">{mm().protocol ?? "—"}</span>
                        </StatusRow>
                        <StatusRow name="uptime" title="since the worldserver process started">
                          <span title={mm().startedAtMs !== null ? `started ${stamp(mm().startedAtMs)}` : ""}>{fmtDuration(mm().uptimeMs)}</span>
                        </StatusRow>
                        <StatusRow name="world" title="whether the world loaded whole at startup; a world that did not serves nothing until a restart">
                          {mm().worldLoaded === null ? <span class="dim">?</span> : mm().worldLoaded ? <span class="ok">loaded</span> : <span class="err">not loaded</span>}
                        </StatusRow>
                        <StatusRow name="sessions" title="live bench sessions, then leases held, on the whole module">
                          <span class="mono">
                            {mm().sessions ?? "?"} / {mm().leases ?? "?"}
                          </span>
                        </StatusRow>
                        <Show when={mm().limits}>
                          {(l) => (
                            <StatusRow name="limits" title="what the module refuses past, per lease and in all; 0 is off">
                              <For each={LIMIT_ROWS.filter((r) => l()[r.key] !== undefined)}>
                                {(r, i) => (
                                  <>
                                    {i() > 0 ? " · " : ""}
                                    <span title={r.setting}>
                                      <span class="dim">{r.label}</span> {fmtLimit(l()[r.key]!, r.bytes === true)}
                                    </span>
                                  </>
                                )}
                              </For>
                            </StatusRow>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show
                    when={w().store}
                    fallback={
                      <StatusRow name="session store" title="the wrath-mcp sessions this viewer reads beside its runs (WRATHBENCH_SESSION_STORE)">
                        <span class="dim">none</span>
                      </StatusRow>
                    }
                  >
                    {(s) => (
                      <>
                        <StatusRow name="recorded" title="sessions in the session store whose character entered the world, live and ended, as the runs page lists them">
                          <span class="mono">{s().sessions}</span>
                        </StatusRow>
                        <StatusRow name="live" title="open, with a heartbeat in the last two minutes">
                          <span class={s().live > 0 ? "ok mono" : "mono"}>{s().live}</span>
                        </StatusRow>
                        <Show when={s().versions.length > 0}>
                          <StatusRow name="stack" title="the wrath-mcp release each recorded session reports, with how many">
                            <For each={s().versions}>
                              {(v, i) => (
                                <>
                                  {i() > 0 ? " · " : ""}
                                  <span class="mono" title={v.commit ?? "no commit recorded"}>
                                    {v.version}
                                  </span>{" "}
                                  <span class="dim">×{v.sessions}</span>
                                </>
                              )}
                            </For>
                          </StatusRow>
                        </Show>
                        <For each={s().liveSessions}>
                          {(l) => (
                            <tr>
                              <td title="a live session: its run page">
                                <A href={`/run/${l.id}`}>{l.character}</A>
                              </td>
                              <td>
                                <span class="ok">live</span>{" "}
                                <span class="dim mono" title={l.commit ?? "no commit recorded"}>
                                  {l.version}
                                </span>
                              </td>
                              <td />

                            </tr>
                          )}
                        </For>
                      </>
                    )}
                  </Show>
                </tbody>
              </table>
            </div>

            <h3 class="section">
              connect an agent{" "}
              <InfoHint
                text={`Run on the worldserver's host, from the directory the agent starts in. Fill in an allowlisted account, the module's port secret (${MODULE_SECRET_ENV}), this checkout's absolute path and the session store this viewer reads. ${AGENT_MODULE_URL} is the module's own port on that host, not the viewer's route to it.`}
              />
            </h3>
            <div class="chips">
              <For each={CONNECT_FORMS}>
                {(f) => (
                  <button type="button" class={form() === f.id ? "on" : ""} onClick={() => setForm(f.id)}>
                    {f.label}
                  </button>
                )}
              </For>
              <CopyButton text={snippet()} />
              <Show when={STACK_URL}>
                {(u) => (
                  <a href={`${u()}/blob/master/mcp/README.md#connect-an-mcp-client`} target="_blank" rel="noopener noreferrer" title="wrath-mcp's mcp/README.md: other clients, headless use, and the first prompt">
                    connect an MCP client
                  </a>
                )}
              </Show>
            </div>
            <pre class="mono scroller">{snippet()}</pre>
          </>
        );
      }}
    </Show>
  );
}

export function DeploymentSection(props: { admin: AdminResponse | undefined }) {
  return (
    <Show when={props.admin}>
      {(a) => (
        <>
          <h3 class="section" title="deployment config: the chart's groups, admin and publisher values, read here and changed there">
            deployment
          </h3>
          <div class="scroller">
            <table class="configtable">
              <tbody>
                <For each={GROUP_ROWS}>
                  {(g) => (
                    <tr>
                      <td class="mono" title={`groups.${g.group}.enabled`}>
                        {g.group}
                      </td>
                      <td>{a().groups[g.group] ? <span class="ok">on</span> : <span class="dim">off</span>}</td>
                      <td class="dim">{g.holds}</td>
                    </tr>
                  )}
                </For>
                <tr>
                  <td class="mono" title="publisher.enabled">
                    publisher
                  </td>
                  <td>
                    {a().publishing.enabled === null ? <span class="dim">?</span> : a().publishing.enabled ? <span class="ok">on</span> : <span class="dim">off</span>}
                  </td>
                  <td class="dim">
                    <Show when={a().publishing.enabled === true}>
                      <span class="mono" title="publisher.target: the endpoint and bucket, or the Secret's when not set as plain values">
                        {a().publishing.target ?? "target in the Secret"}
                      </span>
                      <Show when={a().publishing.region !== null}> · region {a().publishing.region}</Show>
                      <Show when={a().publishing.virtualHostedStyle}> · virtual-hosted</Show>
                      <span title="publisher.delayMs"> · delay {fmtDelay(a().publishing.delayMs)}</span>
                      <span title="publisher.history"> · {a().publishing.history ? "history" : "current view only"}</span>
                    </Show>
                  </td>
                </tr>
                <Show when={a().publishing.last}>
                  {(l) => (
                    <tr>
                      <td class="mono">last pass</td>
                      <td>{l().withheld > 0 ? <span class="err" title="objects the secret scan withheld">{l().withheld} withheld</span> : <span class="ok">clean</span>}</td>
                      <td class="dim">
                        flipped {l().flipAt === null ? "never" : fmtWhen(l().flipAt)}
                        <Show when={l().held > 0}> · {l().held} held</Show>
                      </td>
                    </tr>
                  )}
                </Show>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Show>
  );
}
