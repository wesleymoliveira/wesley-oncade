# What is tested here, and what is not

One rule decides: **test what can lose money or lie about money. Do not test what someone else owns.**

## Tested

| What                                                                                    | Where                          | Why                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| Money arithmetic, batching, fees                                                        | `tests/core/`                  | A wrong cent is a wrong payment                                |
| State machines of a run, a batch and a person                                           | `tests/core/`                  | An illegal move pays twice or never                            |
| Idempotency decisions (same key, other body)                                            | `tests/core/`                  | The client will retry                                          |
| Ledger: every transaction sums to zero, rebuild equals balances                         | `tests/core/` (property-based) | The books must prove what is owed                              |
| Webhook signature and delivery key                                                      | `tests/core/`                  | A forged or repeated event must not move money                 |
| Failure kinds and the circuit breaker                                                   | `tests/core/`                  | Retrying the wrong failure pays twice                          |
| Reconciliation: which difference repairs itself, which goes to a person                 | `tests/core/`                  | A wrong automatic repair is a wrong payment                    |
| The flows, end to end, on real MongoDB and a real queue                                 | `tests/flows/`                 | Crashes, duplicates and races only exist with real storage     |
| This service's own API: a repeated key, bad requests, one code for each kind of refusal | `tests/flows/api.test.ts`      | It must answer the questions this project asks of the provider |

`lib/core` must stay at 100% line and branch coverage (`vitest.config.ts` enforces it). Nothing else has a coverage target.

## Not tested, on purpose

| What                                                                       | Why not                                                     | What covers the risk instead                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Oncade's own behaviour                                                     | Not ours. A test against a stand-in proves nothing about it | `npm run explore` asks the real API and records its replies; the periodic check compares with the provider while the service runs |
| Next.js routing, the MongoDB driver, the SQS client, the OpenTelemetry SDK | Their authors test them                                     | The flow tests use them for real                                                                                                  |
| That a function was called with certain arguments                          | It restates the code and breaks on every refactor           | Assert the state in the database, not the call                                                                                    |
| Log wording and span names                                                 | Cosmetic, changes often                                     | The drills read the metrics that alerts depend on                                                                                 |
| The scripts in `scripts/`                                                  | Tools for a person, run by hand                             | They fail loudly                                                                                                                  |

## State is proven in tests. Signals are proven in drills.

A test asserts what is in the database after a failure. A drill (`npm run drill`) causes the same failure in the running system and reads the metric from Prometheus, because a signal that was never seen arriving in the backend is not observability.

## Rules for an agent writing tests

- A new rule in `lib/core` comes with its test. A new flow comes with one test of its failure, not only its success. For a flow that only reads, the failure is "nothing to read": an unknown run, nothing posted yet.
- No mocks of our own modules. Use the stand-in and real MongoDB.
- No snapshot tests. An expected value typed into the test is fine; a file recorded from the output is not.
- If a test needs a sleep, the design is wrong: inject the clock.
- Before deleting a test, say which risk it covered and what covers it now.
