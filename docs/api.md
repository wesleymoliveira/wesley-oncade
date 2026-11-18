# The API of this service

Six routes. A business system calls four of them with a shared token. Oncade calls one with a signature. Health is open.

This page says what each route accepts and answers. [`tests/flows/api.test.ts`](../tests/flows/api.test.ts) checks the create, read, cancel and webhook routes against it.

## What holds for the five routes that carry data

Health is the exception: it answers `{ "ok": true }` with `setup`, or `503 { "ok": false }`, and nothing else.

- An amount is an integer number of cents.
- An error is `{ "error": "<a sentence for a person>", "code": "<A_CODE>" }`. The code says what kind of refusal it is, and one code has one status. Where the remedy differs, the code differs: a reused key and a taken reference are both a `409`, with two codes.
- An answer carries the header `x-trace-id`, to quote when something needs to be looked up.
- `Authorization: Bearer <APP_TOKEN>` is required, except on the webhook and on health. Without it: `401 UNAUTHORIZED`.
- An error the code did not expect answers `500 INTERNAL_ERROR`, in the same shape, without the error's own text.

## Routes

| Route                                     | Success                                                                         | Refusals                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/runs`                          | `201` with `reference`, `status`, `payrollCents`; `200` with `replayed: true`   | `400 IDEMPOTENCY_KEY_REQUIRED`, `400 IDEMPOTENCY_KEY_TOO_LONG`, `400 INVALID_JSON`, `422 INVALID_BODY` with `issues`, `409 IDEMPOTENCY_KEY_REUSED`, `409 REFERENCE_EXISTS` |
| `GET /api/runs/{reference}`               | `200`: state, money, people (counted, never named), batches, history            | `404 NOT_FOUND`                                                                                                                                                            |
| `POST /api/runs/{reference}/cancel`       | `202` with `status: "cancelling"`; `200` with `status: "cancelled"`             | `404 NOT_FOUND`, `409 CANNOT_CANCEL`                                                                                                                                       |
| `POST /api/runs/{reference}/retry-failed` | `202` with the number of new batches and of people in them                      | `404 NOT_FOUND`, `409 CANNOT_RETRY`                                                                                                                                        |
| `POST /api/webhooks/oncade`               | `200 { "received": true }`, with `duplicate: true` for a delivery already seen  | `401 INVALID_SIGNATURE`, `400 NOT_AN_EVENT`                                                                                                                                |
| `GET /api/health`                         | `200` with `setup`: the provider, database and queue this process is pointed at | `503` when the database does not answer                                                                                                                                    |

## The body of `POST /api/runs`

| Field         | Rule                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `reference`   | 3 to 40 letters, digits, dots, dashes or underscores. It names the run from then on |
| `client`      | `name` and `email`: who receives the invoice                                        |
| `marginCents` | 0 to 100,000,000. Optional                                                          |
| `people`      | 1 to 2,000, each with `name`, `email` and `amountCents` from 1 to 100,000,000       |

One e-mail address is one person: a payroll that names an address twice is refused.

## Repeating a request

- **`POST /api/runs`** needs an `Idempotency-Key`: any text of 1 to 255 characters. A UUID works, and so does a key built from your own reference.
  - The same key with the same body returns the first run, also when the two requests arrive at the same moment.
  - The same key with another body is refused: `409 IDEMPOTENCY_KEY_REUSED`.
- **Cancel** takes no key: it answers by the state of the run. Asked again, it says `cancelling` while the provider has not confirmed, and `cancelled` after.
- **Retry failed** takes no key either. The first request moves the run out of `partially_failed`, so a second one is refused with `409 CANNOT_RETRY` and builds nothing.

## What a cancel means

`202` says the cancel was asked, not that it happened. The run is `cancelled` only when Oncade has confirmed every part. If Oncade refuses a part, the run goes back to where it was, and `cancel.refused` in the run view says why.

A run can be cancelled until the first person is paid. Money already received then shows as `refundDueCents` in the run view.

## What the business system is told

When `CUSTOMER_WEBHOOK_URL` is set, the service posts a signed webhook for each of these events:

| Event                  | When                                              | Extra field in `data`                          |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `run.funded`           | The client's payment was recorded                 | `simulated`: true when an operator typed it in |
| `run.completed`        | Everyone was paid                                 |                                                |
| `run.partially_failed` | No batch is in flight and someone is still unpaid |                                                |
| `run.cancelled`        | Every part was confirmed cancelled                | `refundDue`: true when money had been received |

- **Body:** `{ "id", "event", "data", "timestamp" }`. `data.runId` is the run's reference.
- **Headers:** `x-payout-event`, `x-payout-delivery` (the same value as `id`) and `x-payout-signature`: the hex HMAC-SHA256 of the raw body, with `CUSTOMER_WEBHOOK_SECRET`.
- **Retries:** a delivery that gets no `2xx` within 5 seconds is tried again after 2 and then 4 seconds: three attempts, all with the same `id`. After that it waits in the dead-letter queue until an operator sends it again ([runbook](runbook.md)).
- **Deduplicate on `id`.** A delivery can arrive more than once.
