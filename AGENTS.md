# Working in this repository

A payout run on the Oncade Platform API (test mode): a BPO bills its client and pays its staff in batches of up to 20. Unofficial, not an Oncade product.

## Money rules

1. Money is an integer number of cents: stored, computed and answered by our API that way. Dollars appear in two places only: talking to Oncade (`lib/oncade/client.ts`) and printing for a person (`formatUsd`).
2. Save first, call second. A run, a batch and its reference are in the database before any call to Oncade.
3. A timeout is not a failure. Never send a payment call again on your own: ask the source, or park it for a person.
4. A state changes only through the `move…` functions of `lib/infra/store.ts`. They ask `lib/core/run.ts` and put the expected state in the database filter.
5. A state change that moves money writes its ledger entries and its outbox event in the same transaction.
6. A person is paid at most once per run. Retry people, never a whole batch.
7. Simulated funding is not money received. Keep the two apart everywhere.

## Hard limits

- Never read `.env`. Never print or log `API_KEY`. Only test keys run (`assertTestKey`).
- Nothing personal in logs, metrics, API answers, exports, tests or fixtures: ids only. No e-mails, wallets or keys.
- Every route except the signed webhook and health checks the shared token first: `guarded` in `lib/http/respond.ts`.
- A metric label never holds an id or a reference.
- Never commit, push, deploy or open a pull request.
- Ask before adding a dependency.

## Commands

| Command                        | What it does                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| `docker compose up -d`         | MongoDB, the queue, Grafana                                                |
| `npm run check`                | types, lint, format, unit tests, context budget. Not the flow tests        |
| `npm test`                     | unit tests of `lib/core` (no services needed)                              |
| `npm run test:flows`           | flow tests on a real MongoDB and queue. Run it when you touch `lib/flows/` |
| `npm run demo`                 | 300 people against the stand-in                                            |
| `npm run drill`                | the failure drills                                                         |
| `npm run where -- <reference>` | the timeline of one run                                                    |

## Where things are

- `lib/core/`: pure rules, no I/O, 100% tested. Start here.
- `lib/oncade/`: the only code that knows Oncade's request and response shapes.
- `lib/infra/`: MongoDB and the queue. `lib/telemetry/`: logs, metrics, traces. `lib/http/`: what every route shares.
- `lib/flows/`: one file per step of a run. A step that changes state reads, calls core and writes in one transaction. `view.ts` only reads.
- `app/api/`: route handlers. They read or write the database and answer; they never call Oncade. For a new route, copy the shape of `app/api/runs/[reference]/route.ts`.
- `worker/`: outbox relay, queue consumer, periodic check.
- `stand-in/`: a local imitation of the Oncade calls we use. Not Oncade.
- `explore/`: questions for the real test API. Never save a key value; use the operator's addresses only.

## Read only when the task needs it

| File                              | Read it when you touch                       |
| --------------------------------- | -------------------------------------------- |
| `docs/context/oncade-contract.md` | `lib/oncade/` or `stand-in/`                 |
| `docs/context/domain.md`          | states, the ledger or `lib/flows/`           |
| `lib/infra/store.ts`              | the documents, and the only ways they change |
| `TESTING.md`                      | any test, before adding or deleting one      |
| `docs/observability.md`           | a metric, a span, a log line or an alert     |

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
