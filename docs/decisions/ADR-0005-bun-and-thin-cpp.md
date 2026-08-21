# ADR-0005: Bun 1.4 and a thin C++ module

Status: Accepted. Date: 2026-08-21.

## Context
The module must be C++ because AzerothCore modules are in-process C++. Everything above it can be any language. Bun 1.4 shipped on 2026-08-20 with built-in JSONL parsing, sqlite, HTTP and WebSocket serving, markdown rendering, and improved long-running memory behaviour, all of which this project uses.

## Decision
Module in C++, as thin as possible: packet bridge, event tap, session management, audit log. Everything else in TypeScript on Bun 1.4.x, exact version pinned. Prefer Bun built-ins over dependencies.

## Alternatives
- Rust over FFI for the module: adds build complexity for a few hundred lines that should never grow.
- Node: fine, but Bun's built-ins remove several dependencies and the project already uses it elsewhere.

## Consequences
- Bun 1.4 is a fresh large rewrite; pin exactly, bump patches deliberately, keep code plain enough to fall back to 1.3.
- Hot paths, if any, are expected in the module's event filtering, not TypeScript.
