# ADR 0001: Local-first, single process, SQLite

- Status: accepted (2026-11-02)

## Context
Users want to coordinate AI tools they already pay for, without extra infrastructure or recurring costs. Agent CLIs run on the user's machine, with the user's login.

## Decision
DevRelay is one Node.js process (Next.js server plus CLI over a shared core). State is a single SQLite file accessed via Drizzle ORM. It has no Docker, no cloud, no queue and no telemetry, and the server binds to `127.0.0.1`.

## Consequences
- Trivial installation (`npm install`), with private data staying on the machine.
- Background jobs live in-process: a restart interrupts running steps, which are marked failed and can be retried.
- It is not designed for multi-user hosting, which also matches subscription terms (ADR 0002).