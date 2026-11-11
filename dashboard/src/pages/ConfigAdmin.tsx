/**
 * The admin page's sections beside the roster (GitHub issue #427):
 * credentials with their status, freeplay agents, campaigns, the queue, and
 * the deployment's groups and publishing. Each is one more client of the
 * config store: every write goes through the page's `write` (the version
 * check, the actor and the note) to `/api/config`, where `parseFleet` judges
 * the whole candidate config, so a refusal here is the supervisor's own
 * sentence. The status beside the rows is `/api/admin`'s and is read-only.
 *
 * What a secret's value is never appears: a credential names the env var its
 * secret is in, and the page says whether the supervisor has it set.
 */

import { For, Show, createMemo, createSignal } from "solid-js";
import type { AdminCredentialView, AdminResponse } from "@viewer/api-types";
import { configApi } from "../api/config-client";
import {
  EMPTY_CREDENTIAL,
  GROUP_ROWS,
  QUEUE_EPISODES,
  campaignDoc,
  campaignRows,
  credentialDoc,
  fmtDelay,
  freeplayRows,
  jobDoc,
  nextQueueKey,
  publishedDefs,
  queueRows,
  type BudgetKind,
  type NewCredentialForm,
  type NewJobForm,
} from "../lib/admin";
import { fmtWhen } from "../lib/format";

type Write = (fn: (att: { actor: string; note: string }) => Promise<unknown>) => Promise<string | null>;

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
        <Show when={props.c.secretSet} fallback={<span class="err" title="the supervisor's environment does not have this variable">not set</span>}>
          <span class="ok" title="the supervisor's environment has this variable; its value is never shown">set</span>
        </Show>
      </Show>
      <Show when={props.c.deployed === false}>
        {" "}
        <span class="warn" title="not in the chart's modelKeys, so no pod that runs a model carries it">not in chart</span>
      </Show>
    </>
  );
}

export function CredentialsSection(props: { admin: AdminResponse | undefined; write: Write }) {
  const r = useResult();
  const toggle = (c: AdminCredentialView): Promise<void> =>
    r.run(props.write((att) => configApi.patch(`credentials/${c.id}`, { enabled: !c.enabled }, att)), `${c.id} ${c.enabled ? "disabled" : "enabled"}`);
  const remove = (c: AdminCredentialView): Promise<void> => r.run(props.write((att) => configApi.remove(`credentials/${c.id}`, att)), `${c.id} removed`);
  return (
    <>
      <h3 class="section">credentials</h3>
      <Show when={props.admin} fallback={<p class="dim">loading…</p>}>
        {(a) => (
          <>
            <div class="scroller">
              <table class="configtable">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>provider</th>
                    <th title={a().fleet.up ? "as the supervisor last saw its environment" : "no supervisor is up: whether each is set is unknown"}>secret</th>
                    <th title="sessions on its slots now, of its slots">slots</th>
                    <th>budget</th>
                    <th>used</th>
                    <th>held</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <Show when={a().credentials.length === 0}>
                    <tr>
                      <td colSpan={8} class="dim">
                        No credentials.
                      </td>
                    </tr>
                  </Show>
                  <For each={a().credentials}>
                    {(c) => (
                      <CredentialRow c={c} write={props.write} toggle={() => void toggle(c)} remove={() => void remove(c)} onResult={r.run} />
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

function CredentialRow(props: {
  c: AdminCredentialView;
  write: Write;
  toggle: () => void;
  remove: () => void;
  onResult: (p: Promise<string | null>, done: string) => Promise<void>;
}) {
  const [slots, setSlots] = createSignal(String(props.c.slots));
  const [confirming, setConfirming] = createSignal(false);
  const saveSlots = (): void => {
    const n = Number(slots());
    void props.onResult(props.write((att) => configApi.patch(`credentials/${props.c.id}`, { slots: n }, att)), `${props.c.id}: ${n} slots`);
  };
  const held = (): string => [props.c.held.scored, props.c.held.freeplay].filter((h): h is string => h !== undefined).join("; ");
  return (
    <tr>
      <td class="mono">{props.c.id}</td>
      <td class="dim">
        {props.c.provider} · {props.c.billing}
      </td>
      <td>
        <SecretState c={props.c} />
      </td>
      <td>
        <span class="dim">{props.c.inUse === null ? "?" : String(props.c.inUse)} of </span>
        <input type="text" size={3} value={slots()} onInput={(e) => setSlots(e.currentTarget.value)} />{" "}
        <Show when={slots() !== String(props.c.slots)}>
          <button type="button" onClick={saveSlots}>
            save
          </button>
        </Show>
      </td>
      <td class="dim">{props.c.budget}</td>
      <td class="dim">{props.c.used ?? "—"}</td>
      <td>
        <Show when={held() !== ""}>
          <span class="warn">{held()}</span>
        </Show>
        <Show when={props.c.lastError}>
          {(e) => (
            <div class="err" title={`at ${new Date(e().at).toISOString()}`}>
              {e().reason} {fmtWhen(e().at)}
            </div>
          )}
        </Show>
      </td>
      <td>
        <button type="button" class={props.c.enabled ? "on" : ""} title={props.c.enabled ? "enabled: click to disable (live runs finish)" : "disabled: click to enable"} onClick={props.toggle}>
          {props.c.enabled ? "enabled" : "disabled"}
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
  );
}

function AddCredential(props: { admin: AdminResponse; write: Write }) {
  const [open, setOpen] = createSignal(false);
  const [form, setForm] = createSignal<NewCredentialForm>({ ...EMPTY_CREDENTIAL });
  const r = useResult();
  const provider = () => props.admin.providers.find((p) => p.id === form().provider);
  const set = <K extends keyof NewCredentialForm>(k: K, v: NewCredentialForm[K]): void => {
    setForm({ ...form(), [k]: v });
  };
  const save = (): void => {
    const doc = credentialDoc(form());
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    void r.run(
      props.write((att) => configApi.put(doc.key, doc.body, att)),
      `${form().id} added, disabled`,
    ).then(() => {
      if (r.line()?.ok === true) setForm({ ...EMPTY_CREDENTIAL });
    });
  };
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
        <div class="configform">
          <label>
            id
            <input type="text" value={form().id} onInput={(e) => set("id", e.currentTarget.value)} />
          </label>
          <label>
            provider
            <select
              onChange={(e) => {
                const p = props.admin.providers.find((x) => x.id === e.currentTarget.value);
                setForm({ ...form(), provider: e.currentTarget.value, secretEnv: p?.envBase ?? "", budget: "none" });
              }}
            >
              <option value="" selected={form().provider === ""}>
                —
              </option>
              <For each={props.admin.providers}>{(p) => <option value={p.id} selected={form().provider === p.id} title={p.label}>{p.id}</option>}</For>
            </select>
          </label>
          <label title={provider() === undefined ? "" : `${provider()!.envBase}, or ${provider()!.envBase}_<n> for a second one; the value goes in the deployment's Secret, never here`}>
            secret env var
            <input type="text" value={form().secretEnv} onInput={(e) => set("secretEnv", e.currentTarget.value)} />
          </label>
          <label>
            slots
            <input type="text" size={4} value={form().slots} onInput={(e) => set("slots", e.currentTarget.value)} />
          </label>
          <label>
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
          <label>
            budget
            <select onChange={(e) => set("budget", e.currentTarget.value as BudgetKind)}>
              <option value="none" selected={form().budget === "none"}>
                none
              </option>
              <For each={provider()?.budgets ?? []}>{(b) => <option value={b} selected={form().budget === b}>{b}</option>}</For>
            </select>
          </label>
          <Show when={form().budget !== "none"}>
            <label title={form().budget === "usage" ? "the usage percentage it stops at" : form().budget === "spend" ? "dollars a day" : "runs a day"}>
              {form().budget === "usage" ? "max %" : form().budget === "spend" ? "$ / day" : "runs / day"}
              <input type="text" size={5} value={form().limit} onInput={(e) => set("limit", e.currentTarget.value)} />
            </label>
          </Show>
          <button type="button" onClick={save}>
            add
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
        </div>
        <ResultLine line={r.line()} />
      </Show>
    </div>
  );
}

export function FreeplaySection(props: { config: Record<string, unknown>; write: Write }) {
  const r = useResult();
  const rows = createMemo(() => freeplayRows(props.config["roster"]));
  const flip = (name: string, playing: boolean): Promise<void> =>
    r.run(props.write((att) => configApi.patch(`roster/${name}`, { idle: playing ? "none" : "unlimited" }, att)), `${name} ${playing ? "stopped" : "playing"}`);
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
    r.run(props.write((att) => configApi.patch(`campaigns/${name}`, { enabled: !enabled }, att)), `${name} ${enabled ? "disabled" : "enabled"}`);
  const remove = (name: string): Promise<void> => r.run(props.write((att) => configApi.remove(`campaigns/${name}`, att)), `${name} removed`);
  const add = (): void => {
    const doc = campaignDoc({ def: def(), models: models(), runsPerCell: runs() });
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    void r.run(props.write((att) => configApi.put(doc.key, doc.body, att)), `${doc.key.slice("campaigns/".length)} added, disabled`);
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
    r.run(props.write((att) => configApi.patch(key, { enabled: !enabled }, att)), `${key} ${enabled ? "disabled" : "enabled"}`);
  const remove = (key: string): Promise<void> => r.run(props.write((att) => configApi.remove(key, att)), `${key} removed`);
  const add = (): void => {
    const doc = jobDoc(form());
    if (typeof doc === "string") {
      void r.run(Promise.resolve(doc), "");
      return;
    }
    const key = nextQueueKey(props.keys);
    void r.run(props.write((att) => configApi.put(key, doc, att)), `${key} added`);
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
