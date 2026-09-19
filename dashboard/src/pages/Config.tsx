/**
 * The fleet config, edited from the viewer.
 *
 * The store and its API landed earlier; this page is a client of them
 * and invents nothing. Every write renders the WHOLE candidate config and runs
 * it through `parseFleet` — the same function the supervisor refuses a bad
 * config with — so a refusal here is the parser's own sentence, and it is
 * shown verbatim beside the row that caused it. The row keeps the operator's
 * unsaved value: a refusal is something to fix, not something to lose.
 *
 * **The roster is where the ergonomics go.** Tier, idle, billing and routing
 * are the four things an operator actually changes, so they are inline fields
 * on a table row. Everything else — policy, accounts, campaigns, the pinned
 * jobs in the queue — is a textarea of the stored document, one per ROW KEY as
 * the API lists them. Deliberately plain, and deliberately per row key rather
 * than per top-level name: `campaigns` and `queue` are collections, and a PUT
 * to the bare name would be stored and then ignored by the renderer.
 *
 * **Concurrency is check-then-write, and that is the API's ceiling.** There is
 * no if-version parameter and no server-side conflict detection: `version` is
 * the last audit id, and a write takes no expectation of it. So the page
 * re-reads `/api/config` immediately before each write and refuses when the
 * version moved under it, reloading instead. That closes the window an
 * operator can actually hit — a second operator, or the CLI in a pod — and
 * leaves a genuinely simultaneous pair racing, which is what the API allows.
 *
 * **Attribution.** `x-wrathbench-actor` and `x-wrathbench-note` are optional
 * server-side; the note is required HERE, because the audit table is the only
 * record of why the fleet changed and an unexplained row is worth less than
 * the edit cost.
 */

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { SNAPSHOT_MODE } from "../api/client";
import { ConfigError, configApi, type AuditRow, type ConfigResponse } from "../api/config-client";
import {
  BILLINGS,
  EMPTY_NEW_ENTRY,
  IDLES,
  TIERS,
  auditVerb,
  editorText,
  formOf,
  isRosterName,
  jsonEditorKeys,
  newEntryDoc,
  rosterWrite,
  type EditableField,
  type NewEntryForm,
  type RosterEntry,
} from "../lib/config";
import { SNAPSHOT_WITHHELD_TEXT } from "../lib/errors";
import { fmtWhen } from "../lib/format";

/** The operator this tab writes as, remembered so it is typed once a session. */
const ACTOR_KEY = "wrathbench.config.actor";

function readActor(): string {
  try {
    return window.localStorage.getItem(ACTOR_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActor(v: string): void {
  try {
    window.localStorage.setItem(ACTOR_KEY, v);
  } catch {
    /* a browser that refuses storage still gets a usable page */
  }
}

/** A thrown value as the sentence to show. A `ConfigError` is already one. */
function refusal(e: unknown): string {
  return e instanceof ConfigError ? e.message : e instanceof Error ? e.message : String(e);
}

export default function Config() {
  // Not polled. A page whose fields are being typed into must not have the
  // document swapped under it on a timer; the version check before each write
  // is what catches an edit from elsewhere, and it says so out loud.
  const [doc, setDoc] = createSignal<ConfigResponse | undefined>(undefined);
  const [audit, setAudit] = createSignal<AuditRow[]>([]);
  const [loadError, setLoadError] = createSignal<unknown>(undefined);
  const [actor, setActor] = createSignal(readActor());
  const [note, setNote] = createSignal("");
  const [banner, setBanner] = createSignal<string | null>(null);
  const [exported, setExported] = createSignal<string | null>(null);
  /*
   * A roster row's own message, held HERE rather than in the row.
   * `reload()` after a successful write hands `<For>` a new array of new
   * objects, so every row component is disposed and rebuilt — which is what
   * re-seeds the fields from the saved document, and would also throw away a
   * "saved" line set on the component being torn down. Keyed by roster name,
   * it survives that. A refusal does not reload, so the row itself survives
   * and keeps what the operator typed.
   */
  const [rowMessages, setRowMessages] = createSignal<Record<string, string>>({});
  const setRowMessage = (name: string, text: string | null): void => {
    const next = { ...rowMessages() };
    if (text === null) delete next[name];
    else next[name] = text;
    setRowMessages(next);
  };

  const reload = async (): Promise<void> => {
    try {
      const next = await configApi.config();
      setDoc(next);
      setLoadError(undefined);
      if (next.seeded) setAudit((await configApi.audit(50)).audit);
    } catch (e) {
      setLoadError(e);
    }
  };

  onMount(() => {
    if (SNAPSHOT_MODE) return;
    void reload();
  });

  /** Who and why, or the reason it is not usable yet. */
  const attribution = (): { actor: string; note: string } | string => {
    const a = actor().trim();
    const n = note().trim();
    if (a.length === 0) return "name yourself in the actor field before writing";
    if (n.length === 0) return "every write takes a note — say why";
    return { actor: a, note: n };
  };

  /**
   * Run one write, with the version check around it. `fn` gets the attribution
   * and returns the API call; anything it throws comes back as a sentence.
   */
  const write = async (fn: (att: { actor: string; note: string }) => Promise<unknown>): Promise<string | null> => {
    const att = attribution();
    if (typeof att === "string") return att;
    const seen = doc()?.version;
    try {
      const fresh = await configApi.config();
      if (seen !== undefined && fresh.version !== seen) {
        setDoc(fresh);
        setAudit((await configApi.audit(50)).audit);
        return `the config changed underneath (version ${String(seen)} → ${String(fresh.version)}) — nothing was written, and the page now shows the current document`;
      }
      await fn(att);
    } catch (e) {
      return refusal(e);
    }
    writeActor(att.actor);
    setNote("");
    setBanner(null);
    await reload();
    return null;
  };

  const roster = createMemo<[string, RosterEntry][]>(() => {
    const r = doc()?.config["roster"];
    if (typeof r !== "object" || r === null || Array.isArray(r)) return [];
    return Object.entries(r as Record<string, unknown>).map(([name, v]) => [
      name,
      typeof v === "object" && v !== null && !Array.isArray(v) ? (v as RosterEntry) : {},
    ]);
  });

  const editorKeys = createMemo(() => jsonEditorKeys(doc()?.keys ?? []));

  return (
    <div class="page">
      <h1>config</h1>

      {/*
        Three states, not two. The public build and a public viewer withhold
        the routes outright; a private viewer with no store answers 200 and
        says so, and the repair is a command an operator can run.
      */}
      <Show
        when={!SNAPSHOT_MODE && !(loadError() instanceof ConfigError && (loadError() as ConfigError).status === 404)}
        fallback={<p class="dim">{SNAPSHOT_WITHHELD_TEXT}</p>}
      >
        <p>
          The live fleet config, as the store holds it. Every write is validated against the whole
          config by the same parser the supervisor reads it with, and
          takes effect on the supervisor's next 60s re-read — nothing restarts. The store's history
          is below.
        </p>

        <Show when={loadError() !== undefined}>
          <div class="banner bad">{refusal(loadError())}</div>
        </Show>
        <Show when={banner() !== null}>
          <div class="banner bad">{banner()}</div>
        </Show>

        <Show when={doc()} fallback={<Show when={loadError() === undefined}><p class="dim">loading…</p></Show>}>
          {(body) => (
            <Show
              when={body().seeded}
              fallback={
                <div class="banner warn">
                  No config store at <code>{body().path}</code> yet — the file is still the config.
                  Seed it with <code>bun runner/src/config-store.ts seed infra/fleet.example.json</code>.
                </div>
              }
            >
              <div class="configbar">
                <label>
                  actor
                  <input
                    type="text"
                    value={actor()}
                    placeholder="who you are"
                    onInput={(e) => setActor(e.currentTarget.value)}
                  />
                </label>
                <label class="grow">
                  note
                  <input
                    type="text"
                    value={note()}
                    placeholder="why — recorded in the audit table with the before and after"
                    title="The note travels as an HTTP header, which carries Latin-1 only: an em dash is recorded as a hyphen and anything further out as ?"
                    onInput={(e) => setNote(e.currentTarget.value)}
                  />
                </label>
                <span class="dim mono">v{body().version}</span>
                <button type="button" onClick={() => void reload()}>
                  reload
                </button>
              </div>

              <h3 class="section">roster</h3>
              <RosterTable rows={roster()} write={write} messages={rowMessages()} setMessage={setRowMessage} />

              <AddEntry write={write} />

              <h3 class="section">policy, accounts, campaigns, pinned jobs</h3>
              <p class="dim">
                One editor per row key, as the store holds them — a collection's entries are rows of
                their own (<code>campaigns/&lt;name&gt;</code>, <code>queue/&lt;n&gt;</code>), so each is
                edited on its own and file order is kept.
              </p>
              <For each={editorKeys()}>
                {(key) => <JsonEditor rowKey={key} value={body().config} write={write} />}
              </For>

              <h3 class="section">export</h3>
              <p class="dim">
                The store is the only fleet config; the active config is operational state and is
                never committed. Export renders it to a document for reading or for diffing against
                an earlier export.
              </p>
              <button
                type="button"
                onClick={() => {
                  void configApi
                    .export()
                    .then((r) => setExported(r.text))
                    .catch((e: unknown) => setBanner(refusal(e)));
                }}
              >
                export as JSON
              </button>
              <Show when={exported()}>
                {(text) => (
                  <div class="detail">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(text());
                      }}
                    >
                      copy
                    </button>
                    <pre class="mono scroller">{text()}</pre>
                  </div>
                )}
              </Show>

              <h3 class="section">history</h3>
              <AuditPanel rows={audit()} />
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}

type Write = (fn: (att: { actor: string; note: string }) => Promise<unknown>) => Promise<string | null>;

/** The roster, one row per entry, with the four fields an operator changes. */
function RosterTable(props: {
  rows: [string, RosterEntry][];
  write: Write;
  messages: Record<string, string>;
  setMessage: (name: string, text: string | null) => void;
}) {
  return (
    <div class="scroller">
      <table class="configtable">
        <thead>
          <tr>
            <th>name</th>
            <th>model</th>
            <th>billing</th>
            <th>tier</th>
            <th>idle</th>
            <th title="which backend behind OpenRouter may serve this entry — a name, a comma-separated list, or a JSON object; empty is the author's own provider with fallbacks off">
              routing
            </th>
            <th>race/class</th>
            <th>api</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <Show when={props.rows.length === 0}>
            <tr>
              <td colSpan={9} class="dim">
                No roster entries.
              </td>
            </tr>
          </Show>
          <For each={props.rows}>
            {([name, entry]) => (
              <RosterRow
                name={name}
                entry={entry}
                write={props.write}
                message={props.messages[name] ?? null}
                setMessage={(text) => props.setMessage(name, text)}
              />
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function RosterRow(props: {
  name: string;
  entry: RosterEntry;
  write: Write;
  message: string | null;
  setMessage: (text: string | null) => void;
}) {
  // Seeded from the document once. After a refusal nothing reloads, so this
  // component survives and keeps what the operator typed — the value they
  // still mean to save. After a success the whole row is rebuilt from the
  // saved document, which is why the message lives on the page.
  const [form, setForm] = createSignal(formOf(props.entry));
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const set = (field: EditableField, v: string): void => {
    setForm({ ...form(), [field]: v });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      let plan;
      try {
        plan = rosterWrite(props.entry, form());
      } catch (e) {
        props.setMessage(refusal(e));
        return;
      }
      if (plan === null) {
        props.setMessage("nothing changed");
        return;
      }
      const err = await props.write((att) =>
        plan.method === "PATCH"
          ? configApi.patch(`roster/${props.name}`, plan.body, att)
          : configApi.put(`roster/${props.name}`, plan.body, att),
      );
      props.setMessage(err ?? `saved (${plan.method} ${plan.changed.join(", ")})`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      // Validated like any other write: removing an entry a campaign names
      // comes back as the same refusal the file would be rejected with.
      const err = await props.write((att) => configApi.remove(`roster/${props.name}`, att));
      props.setMessage(err ?? "removed");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr>
        <td class="mono">{props.name}</td>
        <td class="dim">
          {String(props.entry["model"] ?? "—")}
          <Show when={typeof props.entry["effort"] === "string"}> · {String(props.entry["effort"])}</Show>
          <Show when={typeof props.entry["driver"] === "string"}>
            <div class="dim">{String(props.entry["driver"])}</div>
          </Show>
        </td>
        <td>
          {/* `selected` on the option, not `value` on the select: Solid sets
              `value` as a property, and in a template whose options are built in
              the same pass that can land before they exist. */}
          <select onChange={(e) => set("billing", e.currentTarget.value)}>
            <option value="" selected={form().billing === ""}>
              — derived
            </option>
            <For each={BILLINGS}>{(b) => <option value={b} selected={form().billing === b}>{b}</option>}</For>
          </select>
        </td>
        <td>
          <select onChange={(e) => set("tier", e.currentTarget.value)}>
            <For each={TIERS}>{(t) => <option value={t} selected={form().tier === t}>{t}</option>}</For>
          </select>
        </td>
        <td>
          <select onChange={(e) => set("idle", e.currentTarget.value)}>
            <option value="" selected={form().idle === ""}>
              — absent
            </option>
            <For each={IDLES}>{(i) => <option value={i} selected={form().idle === i}>{i}</option>}</For>
          </select>
        </td>
        <td>
          <input
            type="text"
            class="routing"
            value={form().routing}
            placeholder="author's own"
            onInput={(e) => set("routing", e.currentTarget.value)}
          />
        </td>
        <td class="dim mono">
          {String(props.entry["race"] ?? "—")}/{String(props.entry["class"] ?? "—")}
        </td>
        <td class="dim mono">
          <Show when={typeof props.entry["apiBase"] === "string"}>
            <div title={String(props.entry["apiBase"])}>{String(props.entry["apiBase"])}</div>
          </Show>
          <Show when={typeof props.entry["apiKeyEnv"] === "string"}>
            <div>{String(props.entry["apiKeyEnv"])}</div>
          </Show>
        </td>
        <td>
          <button type="button" disabled={busy()} onClick={() => void save()}>
            save
          </button>{" "}
          <Show
            when={confirming()}
            fallback={
              <button type="button" disabled={busy()} onClick={() => setConfirming(true)}>
                remove
              </button>
            }
          >
            <button type="button" class="on" disabled={busy()} onClick={() => void remove()}>
              really remove {props.name}
            </button>{" "}
            <button type="button" onClick={() => setConfirming(false)}>
              cancel
            </button>
          </Show>
        </td>
      </tr>
      <Show when={props.message !== null}>
        <tr>
          <td
            colSpan={9}
            class={props.message?.startsWith("saved") === true || props.message === "removed" ? "ok" : "err"}
          >
            {props.message}
          </td>
        </tr>
      </Show>
    </>
  );
}

/** A new roster entry. `name`, `model` and `tier` are what the catalog requires. */
function AddEntry(props: { write: Write }) {
  const [form, setForm] = createSignal<NewEntryForm>(EMPTY_NEW_ENTRY);
  const [message, setMessage] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  const set = (k: keyof NewEntryForm, v: string): void => {
    setForm({ ...form(), [k]: v });
  };

  const add = async (): Promise<void> => {
    const f = form();
    if (!isRosterName(f.name.trim())) {
      setMessage("a roster name is letters, digits and _ . : - (it is the row key)");
      return;
    }
    if (f.model.trim().length === 0) {
      setMessage("model is required");
      return;
    }
    let body;
    try {
      body = newEntryDoc(f);
    } catch (e) {
      setMessage(refusal(e));
      return;
    }
    const err = await props.write((att) => configApi.put(`roster/${f.name.trim()}`, body, att));
    setMessage(err ?? `added ${f.name.trim()}`);
    if (err === null) setForm(EMPTY_NEW_ENTRY);
  };

  return (
    <div class="detail">
      <Show
        when={open()}
        fallback={
          <button type="button" onClick={() => setOpen(true)}>
            add a roster entry
          </button>
        }
      >
        <div class="configform">
          <For
            each={
              [
                ["name", "name (the row key)"],
                ["model", "model"],
                ["race", "race"],
                ["class", "class"],
                ["routing", "routing"],
                ["apiBase", "apiBase"],
                ["apiKeyEnv", "apiKeyEnv"],
              ] as [keyof NewEntryForm, string][]
            }
          >
            {([key, label]) => (
              <label>
                {label}
                <input type="text" value={form()[key]} onInput={(e) => set(key, e.currentTarget.value)} />
              </label>
            )}
          </For>
          <label>
            tier
            <select onChange={(e) => set("tier", e.currentTarget.value)}>
              <For each={TIERS}>{(t) => <option value={t} selected={form().tier === t}>{t}</option>}</For>
            </select>
          </label>
          <label>
            billing
            <select onChange={(e) => set("billing", e.currentTarget.value)}>
              <option value="" selected={form().billing === ""}>
                — derived
              </option>
              <For each={BILLINGS}>{(b) => <option value={b} selected={form().billing === b}>{b}</option>}</For>
            </select>
          </label>
          <label>
            idle
            <select onChange={(e) => set("idle", e.currentTarget.value)}>
              <option value="" selected={form().idle === ""}>
                — absent
              </option>
              <For each={IDLES}>{(i) => <option value={i} selected={form().idle === i}>{i}</option>}</For>
            </select>
          </label>
          <button type="button" onClick={() => void add()}>
            add
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            cancel
          </button>
        </div>
      </Show>
      <Show when={message() !== null}>
        <p class={message()?.startsWith("added") === true ? "ok" : "err"}>{message()}</p>
      </Show>
    </div>
  );
}

/** One row key as raw JSON. Plain on purpose — the roster is the ergonomic surface. */
function JsonEditor(props: { rowKey: string; value: Record<string, unknown>; write: Write }) {
  const current = (): unknown => {
    const slash = props.rowKey.indexOf("/");
    if (slash < 0) return props.value[props.rowKey];
    const head = props.value[props.rowKey.slice(0, slash)];
    const name = props.rowKey.slice(slash + 1);
    if (Array.isArray(head)) return head[Number(name)];
    if (typeof head === "object" && head !== null) return (head as Record<string, unknown>)[name];
    return undefined;
  };
  const [text, setText] = createSignal(editorText(current()));
  const [message, setMessage] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);

  const save = async (): Promise<void> => {
    let body: unknown;
    try {
      body = JSON.parse(text()) as unknown;
    } catch (e) {
      setMessage(`not valid JSON: ${refusal(e)}`);
      return;
    }
    const err = await props.write((att) => configApi.put(props.rowKey, body, att));
    setMessage(err ?? "saved");
  };

  return (
    <div class="jsoneditor">
      <button type="button" class={open() ? "on" : ""} onClick={() => setOpen(!open())}>
        {open() ? "▾" : "▸"} {props.rowKey}
      </button>
      <Show when={open()}>
        <textarea rows={16} value={text()} onInput={(e) => setText(e.currentTarget.value)} spellcheck={false} />
        <div>
          <button type="button" onClick={() => void save()}>
            save {props.rowKey}
          </button>{" "}
          <button type="button" onClick={() => { setText(editorText(current())); setMessage(null); }}>
            revert
          </button>
        </div>
        <Show when={message() !== null}>
          <p class={message() === "saved" ? "ok" : "err"}>{message()}</p>
        </Show>
      </Show>
    </div>
  );
}

/** The change history: when, who, why, and the before and after. */
function AuditPanel(props: { rows: AuditRow[] }) {
  const [open, setOpen] = createSignal<number | null>(null);
  return (
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th>when</th>
            <th>actor</th>
            <th>key</th>
            <th>what</th>
            <th>note</th>
          </tr>
        </thead>
        <tbody>
          <Show when={props.rows.length === 0}>
            <tr>
              <td colSpan={5} class="dim">
                No changes recorded.
              </td>
            </tr>
          </Show>
          <For each={props.rows}>
            {(row) => (
              <>
                <tr
                  onClick={() => setOpen(open() === row.id ? null : row.id)}
                  class="clickable"
                  title="show the before and after"
                >
                  <td class="dim">{fmtWhen(row.ts)}</td>
                  <td>{row.actor}</td>
                  <td class="mono">{row.key}</td>
                  <td class="dim">{auditVerb(row)}</td>
                  <td class="dim">{row.note ?? "—"}</td>
                </tr>
                <Show when={open() === row.id}>
                  <tr>
                    <td colSpan={5}>
                      <div class="detail">
                        <div class="auditdiff">
                          <div>
                            <div class="dim">before</div>
                            <pre class="mono">{row.before === null ? "(none)" : editorText(row.before)}</pre>
                          </div>
                          <div>
                            <div class="dim">after</div>
                            <pre class="mono">{row.after === null ? "(none)" : editorText(row.after)}</pre>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </Show>
              </>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
