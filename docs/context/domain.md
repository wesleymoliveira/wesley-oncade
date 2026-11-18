# Domain: a payout run

Read this before touching states, the ledger or `lib/flows/`.

## The story

A BPO sends its client one invoice. When the money arrives, the BPO pays each person on the payroll. Oncade pays at most 20 people per distribution, so a run of 300 people is 15 batches.

## Three things have a state

**Run** (`lib/core/run.ts`)

```
created ─► awaiting_funds ─► funded ─► processing ─► completed
   │            │               │           │    └──► partially_failed ─► processing (after "retry failed")
   └────────────┴───────────────┴───────────┴──► cancelling ─► cancelled
                                                      └──────► back to where it was, when the provider refuses
```

A `partially_failed` run can be cancelled too, while nobody is paid. An `awaiting_funds` run goes straight to `cancelled` when its invoice was cancelled at the provider.

**Batch**: the unit we send. One batch is one Oncade distribution.

```
pending ─► sending ─► sent ─► confirmed
              │         └───► cancelled        (the provider confirmed the cancel)
              ├──► failed                      (the provider refused it: nothing was created)
              └──► parked                      (we do not know what happened: a person decides)

A `sent` batch can also be `parked`, when the provider and we disagree about it.
```

`sending` is the dangerous state. The batch has our reference and a lease. If the worker dies there, nobody resends: the next worker asks Oncade whether a distribution with that reference exists.

**Person on the payroll** (payee)

```
unpaid ─► assigned (to one batch) ─► paid
             └──► unpaid again, when that batch ends without paying them
```

A person is in at most one live batch. "Retry failed" builds new batches from the people who are `unpaid`. It never resends a batch.

## The ledger

This service never holds money. The ledger records **what is owed**: from the moment the client pays until each person is paid, the BPO owes them.

| Account              | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `cash:provider`      | Money the provider confirmed it received for us                           |
| `cash:simulated`     | Funding typed in by an operator in test. Never mixed with `cash:provider` |
| `payable:<payee id>` | What we owe one person                                                    |
| `fees:<run>`         | Set aside for the provider's service fee on each distribution             |
| `margin:<run>`       | What the BPO keeps                                                        |
| `refund_due:<run>`   | Owed back to the client after a confirmed cancellation                    |

Rules:

- An entry is a signed number of cents: debit positive, credit negative. The entries of one transaction sum to zero.
- Entries are only added. A correction is a new transaction.
- An entry has the time its transaction was posted (`at`) and the id `<transaction id>#<n>`. Posted order is `at`, then `n` as a number: as text, `#10` sorts before `#2`.
- A transaction id is unique (`funding:<run>`, `payout:<batch>`, `cancel:<run>`), so replaying an event cannot post twice.
- Balances are a copy, updated in the same database transaction. `balanceDrift` recomputes them from the entries; any difference is an alert.

## Rules that must hold

1. A person is paid at most once per run.
2. Batches are sent only when the run is funded, and never for more than was funded. Fees count.
3. Simulated funding can release payouts only outside production, and it is labelled as simulated in the run, the ledger and everything a person reads: the run view, the timeline, any export.
4. A cancel is a request. The ledger reverses only after the provider confirms, and only when every batch was cancelled. Money really received becomes `refund_due`; simulated funding is simply undone.
5. A difference in amount between us and Oncade is never repaired automatically.

## What is a difference, and who repairs it

| We see               | Oncade says                                          | Kind                    | Repair                         |
| -------------------- | ---------------------------------------------------- | ----------------------- | ------------------------------ |
| run `awaiting_funds` | invoice `paid`, same amount                          | `funding_missed`        | automatic: record the funding  |
| run `awaiting_funds` | invoice `paid`, other amount                         | `amount_mismatch`       | a person                       |
| run `awaiting_funds` | invoice `cancelled`                                  | `cancelled_at_provider` | automatic: cancel the run      |
| run `awaiting_funds` | invoice not found                                    | `missing_at_provider`   | a person                       |
| batch `sent`         | distribution `completed`                             | `completion_missed`     | automatic: confirm, per person |
| batch `sent`         | distribution `cancelled`                             | `cancelled_at_provider` | automatic: release the people  |
| batch `sent`         | not everyone paid, or a paid line in a cancelled one | `partial_payout`        | a person                       |
| batch `sent`         | not found                                            | `missing_at_provider`   | a person                       |
| batch `sent`         | other total or other people                          | `amount_mismatch`       | a person                       |
