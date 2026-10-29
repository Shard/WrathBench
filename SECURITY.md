# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability). If that is unavailable to you, mail
mark@afrotoss.com. Either way you get an acknowledgement within a week. There
is no further SLA — this is one operator's research project, not a product with
a response team.

## What is in scope

- `module/` — the HTTP/WebSocket bridge the module opens inside the worldserver.
- `sdk/` and `runner/` — the SDK, the agent loop, and the snippet sandbox.
- `dashboard/` and its publisher — the public static site and the projection
  that produces it.

## What is not, and why

The lab is private. No game client can connect and the game ports are never
exposed to a network anyone else is on (`docs/DATA-AND-LEGAL.md`). So a report
about AzerothCore or about WoW 3.3.5a itself has nowhere to land here; take
those upstream. What *is* meaningful is the module's own surface, because that
is the only door: what it serves, who may call it, and what a caller can reach
that it should not. `wrath-mcp/module/PROTOCOL.md` is the authority on what that surface
exposes, including its bearer-credential classes.

Two other things are worth a report even though they are not memory-safety
bugs: anything that lets an agent observe or act beyond the contracts in
`wrath-mcp/docs/CONTRACTS.md`, and anything in the published dashboard that leaks what
`docs/DATA-AND-LEGAL.md` says must never leave the lab.

## Secrets and the model

The harness holds every credential: provider API keys, the Claude and Codex
subscription logins, the module's port secret, database and bucket keys. The
model holds none of them and can reach none of them, whichever driver runs it.
A report that shows otherwise is the most valuable kind this project can get.

- **Snippets** run in a child process whose environment is an explicit
  allowlist: plumbing, the module URL, the run's session token and its own
  leased session secret, which reaches that one session and nothing else.
  Bun's `.env` autoload is off for it, and a Linux Landlock ruleset the kernel
  enforces limits it to reading the interpreter and the runner's own code, its
  own `/proc` entry and a handful of device nodes, to TCP on the module's port,
  and to executing nothing but the interpreter. Another process's environment
  or command line, the home directory where the CLI logins live, the run
  directories and `.env` all answer `EACCES` (`runner/test/sandbox-secrets.test.ts`
  plants sentinels in each and asserts none comes back).
- **The Claude Code CLI** runs with its built-in tools switched off, so the
  model has only the harness's MCP tools: no shell and no file reads. Its
  environment carries the one subscription token it bills and no other
  credential, and no `ANTHROPIC_*` variable.
- **The Codex CLI** runs with its shell and unified exec disabled under a
  read-only sandbox. What it keeps — the code-mode JavaScript runtime, image
  viewing, the patch tool — returns no file's contents: the runtime has no file
  system or network, image viewing refuses anything that is not an image, and
  the patch tool reports only whether a whole line matched before the sandbox
  refuses the write. Its environment carries only the path to its own login
  directory.

What every tool result and context message carries is also scrubbed of the
run's own secrets by value before the model reads it, as a second layer.

Nothing reaches the public site without passing a secret scan at the
publisher, which withholds any object carrying a known credential by value or
a credential-shaped string, and stops the site's update until it is clean
(`runner/viewer/README.md`, "What it will not serve").
