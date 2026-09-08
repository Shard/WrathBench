# DeepSeek V4.1 beta (opt-in)

This is a deliberately held, short-lived beta configuration. It is **not** part
of the normal fleet roster: `infra/fleet.json` remains unchanged, so the fleet
service does not schedule or charge this model merely because `DEEPSEEK_KEY`
happens to exist.

## Configuration

`infra/fleet-deepseek-v41.example.json` is a supported fleet-config example,
not a live config. It contains exactly one disabled pinned job:

| field | value |
| --- | --- |
| roster ref | `deepseek-v41-beta` |
| model | `deepseek-v4.1-flash-expires-on-0910` |
| driver | `openai` |
| API base | `https://api.deepseek.com` |
| API key env | `DEEPSEEK_KEY` |
| billing | `paid` |
| tier | `t0` |
| queue | one `e90`, `repeat: 1`, `enabled: false` |
| idle | `none` |
| account | `RUNNER7` in the example; replace only with another already-allowlisted account if needed |

The t0 tier supplies one e90 target. The disabled queue, `repeat: 1`, and
`idle: "none"` provide no idle session, promotion, or second episode. No
objective, effort, prompt, retry, or other model-specific tuning is set.

DeepSeek's official [first API call documentation](https://api-docs.deepseek.com/)
describes an OpenAI-compatible base URL of `https://api.deepseek.com` and
`POST /chat/completions`; WrathBench's existing OpenAI-compatible adapter adds
that path. The exact beta model identifier above is preserved verbatim. The
beta's expiry date/time zone and live availability were not verified here.

## Exact opt-in steps

These steps are intentionally manual and local. Do not edit `infra/fleet.json`.

1. Make an untracked working copy of the held config and enable only its queue
   job for inspection:

   ```sh
   cp infra/fleet-deepseek-v41.example.json infra/fleet-deepseek-v41.local.json
   # edit infra/fleet-deepseek-v41.local.json:
   #   queue[0].enabled: false -> true
   ```

   Keep `repeat: 1`, `episode: "e90"`, `tier: "t0"`, and `idle: "none"`.
   Confirm the selected account is not already in use. No token is needed for
   this dry run.

2. Inspect the exact one-job plan before loading a credential or launching
   anything:

   ```sh
   ./infra/run-fleet.sh infra/fleet-deepseek-v41.local.json --dry-run
   ```

   The plan must show the exact model identifier, one e90, and no idle work.
   Confirm the copied config still names `https://api.deepseek.com` and
   `DEEPSEEK_KEY`; a dry run does not call the model API.

3. If the plan is correct and the operator explicitly accepts the charge, put
   the credential in the ignored repository `.env` file:

   ```dotenv
   DEEPSEEK_KEY=<the operator's DeepSeek API key>
   ```

   Compose's Bun runner path loads `/wrathbench/.env`; the host launcher accepts
   the `DEEPSEEK_*` prefix for `--local` runs. Kubernetes needs the same key name
   added to the existing `wrathbench-env` Secret; the chart's `modelKeys` list
   includes `DEEPSEEK_KEY` and keeps it optional until used.

4. Run the copied config once:

   ```sh
   ./infra/run-fleet.sh infra/fleet-deepseek-v41.local.json
   ```

   Do not use `--loop`, add the beta to the normal roster, or leave the local
   queue enabled after the single e90. There is no automatic expiry subsystem;
   because the `0910` time zone and provider availability are unverified, the
   operator must manually disable/remove the local copy after checking the
   provider's current notice.

The example file is not included by `infra/k8s/kustomization.yaml`, and the
running fleet service command names only `infra/fleet.json`. Enabling a local
copy therefore cannot change the normal compose/Kubernetes roster by itself.

## Verification boundary

The configuration and argv plumbing are covered by
`infra/deepseek-v41.test.ts`. No DeepSeek credentials were read, no API
inference or live service was used, and no deployment or fleet activation was
performed for this change. Live availability, billing behavior, tool-call
compatibility, and the beta expiry remain unverified until the operator opts
in deliberately.
