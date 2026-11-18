# Design: a payout run that can be repeated without paying anyone twice

I design payment flows in the same five steps: ask, name the rules that cannot break, shape the data, walk the happy path, then list what fails and how we would know. This document follows them.

Where a row says **lived**, I met that failure in production at my previous company and fixed it. The other rows are designed here, and each is proven by a test or a drill.

## 1. Ask

The request, as a customer would put it: _"We're a BPO with 300 staff. We want to pay them through your API every two weeks."_ The questions that decide the design, and the answer this project assumes:

| Question                                                           | Assumed here                           | Why it matters                                 |
| ------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| A platform acting for businesses, or the business itself?          | A platform, with a grant               | Decides the headers and scopes of every call   |
| One total split by rule, or an amount per person?                  | An amount per person                   | Payroll is `fixed`, not `percentage`           |
| 300 people is more than one distribution holds. How to group them? | 15 distributions of 20                 | Each one needs its own idempotency key         |
| Who moves the money?                                               | The business owner, from the dashboard | `payoutPath: "dashboard"`: we never send funds |
| Is the money in before we pay?                                     | Yes: the client pays an invoice first  | Nothing is sent before funding                 |
| If a run fails halfway, what about the people already paid?        | They stay paid; the rest are retried   | Leads to "retry people, never a batch"         |

## 2. Rules that cannot break

1. A person is paid at most once per run.
2. Nothing is paid before the money is in, and never more than came in. Fees count.
3. A payment is never lost in silence: it ends paid, or in front of a person.
4. Every change of state is recorded, with the trace that caused it.

## 3. Data and states

| Thing        | What it is                                             | The key that enforces the rule                                                            |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Run          | One payroll for one client                             | Its reference. The client's `Idempotency-Key` is stored with a fingerprint of the body    |
| Batch        | One distribution of up to 20 people                    | Its id is our reference for the send. It is saved before the call and travels in the memo |
| Person       | One line of the payroll                                | In at most one live batch at a time                                                       |
| Ledger entry | What is owed, in double entry                          | A transaction id per business event, so an event cannot post twice                        |
| Outbox event | Work to do, saved with the state change that caused it | Published at least once; every consumer checks state first                                |

The state machines are drawn in [context/domain.md](context/domain.md) and written in [`lib/core/run.ts`](../lib/core/run.ts).

**Why a ledger, if this service never holds money?** It records what is owed. From the moment the client pays until each person is paid, the BPO owes them. That balance must be provable, and a cancel must reverse it exactly.

## 4. The happy path

1. `POST /api/runs` with an `Idempotency-Key`. One transaction saves the key, the run, 300 people, 15 batches and one outbox event. The API answers.
2. The relay publishes the event. The worker reads the provider's fee rules, fixes the invoice amount, and creates the invoice.
3. The client pays. The webhook handler verifies the signature on the raw body, stores the delivery under a unique key and queues a check. The worker reads the invoice from the provider and, in one transaction, marks the run funded, posts the ledger entries and queues 15 batches.
4. For each batch a worker claims it with a conditional write (`pending → sending`), then calls the provider once.
5. The periodic check reads each distribution. When the provider says it is paid, one transaction confirms the batch, marks each person paid and posts the payout to the ledger.
6. Each step that matters to the BPO writes an event; the BPO gets a signed webhook with a delivery id.

## 5. What fails, and how we would know

| #   | Failure                                      | What the code does                                                                                                                                           | Where                       | Proof               | Lived or built here                                                                                                                          |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The client repeats the request               | Same key and body: the first run comes back. Same key, other body: refused. Two at once: one run                                                             | `lib/flows/create-run.ts`   | flow test           | **Lived.** A real duplicate top-up; I added idempotency keys with a body fingerprint                                                         |
| 2   | Two workers take the same batch              | The conditional write lets one through                                                                                                                       | `lib/flows/send-batch.ts`   | flow test           | **Lived.** A queue worker that re-reads the row and goes on only if it is still queued                                                       |
| 3   | The worker dies after sending, before saving | The batch stays `sending`, with our reference. The next worker asks the provider whether a distribution with that reference exists and adopts it             | `send-batch.ts`, `recover`  | drill 1, flow test  | Failure **lived**; this defence **built here**                                                                                               |
| 4   | The provider gives no answer                 | Unknown is not failed. A call that creates a payment is sent once. If the provider has none with our reference, or has two, the batch is parked for a person | `lib/core/failures.ts`      | flow test           | **Lived.** A job that sent a request back to "pending" after the money had moved; I made it re-read before deciding                          |
| 5   | The provider is unreachable                  | The breaker opens after three failures; the worker stops taking work, so messages wait instead of failing                                                    | `lib/core/breaker.ts`       | drill 2             | Built here                                                                                                                                   |
| 6   | One batch is refused                         | It fails, its people are free again, the run ends `partially_failed`. "Retry failed" builds new batches from unpaid people                                   | `lib/flows/retry-failed.ts` | drill 3, flow test  | Built here                                                                                                                                   |
| 7   | The webhook never arrives                    | The periodic check reads the invoice and calls the same function the webhook would                                                                           | `lib/flows/fund.ts`         | drill 4, flow test  | **Lived.** Customers paid, a provider's feed went silent, nobody saw the payments; I wrote the first version of the job that read the source |
| 8   | A webhook is repeated or forged              | Unique delivery key; constant-time signature check over the raw bytes                                                                                        | `lib/core/webhook.ts`       | drill 4, unit tests | Built here                                                                                                                                   |
| 9   | The client pays another amount               | Never accepted automatically: the run waits for a person                                                                                                     | `lib/core/reconcile.ts`     | flow test           | Built here                                                                                                                                   |
| 10  | A cancel races a payment                     | The run is `cancelling` until the provider confirms each part. The ledger reverses only then. If the provider already paid, the cancel loses                 | `lib/flows/cancel.ts`       | flow tests          | **Lived** in part. A revert that moved one side of the money only; I made it write both sides in one transaction                             |
| 11  | A message can never succeed                  | Three receives, then the dead-letter queue and an alert. Good work keeps flowing                                                                             | `worker/main.ts`            | drill 5             | Built here. In production I ran queue workers on BullMQ                                                                                      |
| 12  | The books drift                              | Balances are a copy; the check recomputes them from the entries and alerts on any difference                                                                 | `lib/core/ledger.ts`        | property test       | **Lived.** I built a double-entry ledger for prepaid credits and a backfill for missing entries                                              |

**How we would know** is in [observability.md](observability.md): the alert for each row, and whether it wakes someone.

## Decisions, and what I chose against

| Decision                                                                       | Instead of                         | Why                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One database transaction per state change: state, ledger entries, outbox event | Writing the state, then publishing | A crash between the two loses the event or sends it without the state                                                                                                                                                                   |
| A call that creates a payment is sent once                                     | Retrying on timeouts and 5xx       | The reference does not say what a repeated `Idempotency-Key` returns, so I did not rely on it. The test API then confirmed the caution: a draft invoice and a distribution, each posted again with the same key, became a second object |
| State per person, not only per batch                                           | Retrying a failed batch            | The reference shows a status per recipient. Resending a batch could pay some people twice                                                                                                                                               |
| The webhook says when to look; reading the provider says what is true          | Trusting the payload               | One code path changes state, and a forged or stale payload cannot move money                                                                                                                                                            |
| A cancel is a state, confirmed by the provider                                 | Reversing the books on request     | A request is not a fact. The owner may be paying at that moment                                                                                                                                                                         |
| After a refused cancel, the object is read again                               | Taking the refusal as final        | One cancel can be delivered twice. The second call is refused for an object the first one cancelled, and that is not a refusal                                                                                                          |
| The progress check of a run writes the run before it reads the batches         | Reading the batches and deciding   | Two batches can end in two transactions at the same moment. Each would see the other as still running, and the run would stay in `processing`                                                                                           |
| Simulated funding has its own cash account and its own switch                  | An "admin override"                | "Never pay more than came in" only means something if "came in" cannot be typed                                                                                                                                                         |
| Standard queue                                                                 | FIFO                               | A bad message must not block the others, so every consumer is idempotent instead                                                                                                                                                        |
| The breaker pauses the consumer                                                | Letting messages fail              | An outage would otherwise push healthy work into the dead-letter queue                                                                                                                                                                  |
| A wait puts a fresh copy on the queue with a delay                             | Leaving the message to time out    | Waiting must not count towards the dead-letter limit. Only real errors do                                                                                                                                                               |

## Patterns I know and did not need here

- **Two-phase commit.** There is no shared transaction with a provider. The run is a saga: steps, each with an undo, undone in reverse while they still can be.
- **Choreography.** One orchestrator, so the state of a run is in one place a person can read.
- **Balance sharding.** No hot row: each person's balance is written twice per run. I would shard the cash account when retries on it show up in the transaction metrics.
- **Change streams as the outbox relay.** Polling four times a second is enough here. I would switch when the delay matters.
- **Redis `SET NX` for idempotency.** The key must live and die with the run, so it is in the same database, under a unique index.
- **Pessimistic locks.** A conditional write is enough when the work is claimed once. I would lock when two writers must read, compute and write the same balance.
- **Exactly-once delivery.** It does not exist. Delivery is at least once and every consumer checks state first.
- **FIFO queues.** See above.

## Limits I know, and what I would do at a hundred times the volume

- **The periodic check reads a bounded number of rows per pass**, in no order: 50 runs to invoice, 100 runs waiting for money, 200 sent batches, 200 stuck ones. That covers this size many times over. Past it, the rows beyond the limit would wait. I would order by the time of the last check and keep a cursor, and ask Oncade for a call that reads one distribution: on the test API, reading one by id answered 410, so each look-up walks the list.
- **A look-up walks at most 20 pages of 100.** Past that it stops with an error: unread pages cannot answer "not found".
- **A message has 30 seconds.** The queue hides a delivery for that long and the worker does not extend it. A step makes a few provider calls and normally fits. A cancel of a run with many batches, or a full check asked for by a webhook, can take longer, and the queue then delivers the message a second time. That is safe, because every step starts by reading the state, and it is wasteful. I would extend the time while a step runs.
- **Every real error has the same budget:** three receives in about 14 seconds, then the dead-letter queue and an alert. That is right for a message that can never succeed. It is short for our customer's endpoint during a deploy: the notice then waits for an operator. I would give notices their own, longer schedule.
- **A read that the provider refuses (a 401, a 403) waits and tries again without end.** It shows as a growing age in the gauges, not as a dead letter. I would stop after a number of waits.
- **A reply the schema cannot read counts as provider trouble**, on a read as on a create. The lists hold every object of the business, so one object in an unknown shape fails each look-up, loudly. I would parse a list item by item.
- **Two workers publish the same outbox event twice.** Safe, because every consumer checks state first, and wasteful. I would claim an event before publishing it.
- **One worker process holds the breaker's state.** With several, that state moves to a shared store.
- **The alerts are rules, and nothing routes them to a person here.** There is no Alertmanager: the drills read each rule's state from Prometheus. `CheckStopped` also fires before the worker's first check.
- **The ledger check loads all entries.** I would verify one run at a time, when it closes.
- **Three hundred people in one transaction is fine. Thirty thousand is not:** the run would be created in pages.
