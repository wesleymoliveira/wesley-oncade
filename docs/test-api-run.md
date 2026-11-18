# What ran against the Oncade test API

Test key, host `www.oncade.gg`, 2026-11-16 and 2026-11-17. This page is the record of the two flows taken end to end: what happened, when, and how this service learned it. What each endpoint of the reference answered is in [api-coverage.md](api-coverage.md).

Raw replies stay on my machine. Scrubbed copies, with the real structure and no real ids or addresses, are in [`tests/contract/fixtures/`](../tests/contract/fixtures/). Every e-mail address used is mine: two mailboxes, and `+tag` aliases of them where a call needed more people.

## One run paid for real, in test

On 2026-11-17, `npm run real-run:oncade -- --pay`: nothing simulated, nothing cancelled. A person paid the invoice and the payout at the provider, from the business's test balance. That balance is USDC on Base Sepolia, a public test network, and it was filled from a public faucet. No page of the docs says this: the hosted payment window does.

The run below was paid at 22:30 UTC, on the code as it is in this repository. It is the second paid run of that day: the first was at 14:38 UTC, and the two fixtures named below come from it.

| Time (UTC) | What happened                                                                            | How this service learned it                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 22:30:22   | The run is created through our API                                                       |                                                                                                |
| 22:30:24   | The invoice is issued, $6.00                                                             | The reply to the create                                                                        |
| 22:31:29   | The invoice is paid on the hosted page                                                   | `Platform.Invoice.Paid`, then a read of the invoice: `paid`                                    |
| 22:31:30   | Funding recorded as "provider, found by webhook". The batch is claimed and sent          | The reply to the create, and `Platform.Distribution.Created`                                   |
| 22:32:36   | The payout is paid from the dashboard. The batch is confirmed and the run is `completed` | The periodic check: the list showed `completed`, and every line `sent`. No webhook came for it |

The same run in Tempo, as spans: service, span, time, answer. The money arriving is one trace that starts at the webhook and crosses the queue twice.

```text
the invoice is paid: one trace across two services
  api     POST /api/webhooks/oncade      16 ms
  worker  queue funding.check           294 ms
  worker  oncade invoice_get            272 ms  200
  worker  queue batch.send              765 ms
  worker  oncade distribution_create    735 ms  201
  worker  queue customer.notify           1 ms
the payout is paid: found by the periodic check
  worker  reconcile.sweep               291 ms
  worker  oncade distribution_list      274 ms  200
  worker  queue customer.notify           1 ms
```

- A paid invoice returns `status: "paid"`, `balanceDue: 0`, `paymentTxHash` and `paymentFromAddress`.
- A paid payout returns `status: "completed"`. Each line is `status: "sent"`, `method: "gift"`, with `transactionHash` and `sentAt`. The three people have no account, so each one got a claim link.
- Both replies are fixtures (`invoice-paid.json`, `distribution-list-paid.json`), and the two rules that wait for money are tested against them.

## Webhooks from Oncade

On 2026-11-17 the platform's webhook URL pointed at this project through a tunnel. One run of three people was created and cancelled, and four kinds of event arrived, signed, at `POST /api/webhooks/oncade`:

| Event                             | What this API answered     | In the body                                                                                              |
| --------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Platform.Invoice.Created`        | 200 `{ "received": true }` | `invoiceId`, `status: "sent"`, `total` in dollars, the receiver's name and address                       |
| `Platform.Distribution.Created`   | 200 `{ "received": true }` | `distributionId`, `status: "pending"`, `totalAmountCents`, `recipientCount`, the memo with our reference |
| `Platform.Invoice.Cancelled`      | 200 `{ "received": true }` | the same fields, `status: "cancelled"`                                                                   |
| `Platform.Distribution.Cancelled` | 200 `{ "received": true }` | the same fields, `status: "cancelled"`                                                                   |

- Each one carried `x-oncade-signature` (64 hex characters), `x-oncade-event` and `x-oncade-platform-id`. The signature matched the raw body, with the platform secret.
- A delivery sent again from the portal had the same bytes. The API answered `{ "received": true, "duplicate": true }` and queued nothing.
- A request without a signature, sent to the same route through the tunnel, answered 401.
- The provider retries a failed delivery by itself: the portal's log showed one event on its fifth attempt, 24 minutes after it happened.
- Four more kinds arrived with other calls: `Platform.Invoice.Paid`, `Platform.Invoice.Updated`, `Platform.Invoice.Sent` and `Platform.Link.Started`.
- Scrubbed copies of every kind are in `tests/contract/fixtures/webhook-*.json`, and `tests/contract/recorded.test.ts` reads them.

## The same run as a rehearsal: funding simulated, then cancelled

`npm run real-run:oncade`, on 2026-11-17 at 22:18 UTC. Nobody has to pay, and nothing stays open: the worker created a real invoice and a real distribution of three people, and the run was then cancelled through our API.

```text
1. run created through our API           REAL-2026-11-17-J9BT, 3 people, $6.00
2. invoice issued at the provider        $6.00, sent to the client address
3. client payment                        SIMULATED by an operator, not received, found by: operator
4. batch at the provider                 sent, fee $0.00
   found there by our reference          pending, 3 people, $6.00
5. cancel requested                      answered 202
   run                                   cancelled
   books                                 owed to people $0.00, refund due $0.00
6. open invoices at the provider         0
   the distribution at the provider      cancelled
```

The cancel, as spans of one trace:

```text
  api     POST /api/runs/{ref}/cancel    11 ms
  worker  queue run.cancel             2395 ms
  worker  oncade distribution_list      225 ms  200
  worker  oncade distribution_cancel    334 ms  200
  worker  oncade distribution_list      894 ms  200
  worker  oncade invoice_get            377 ms  200
  worker  oncade invoice_cancel         302 ms  200
  worker  oncade invoice_get            227 ms  200
```

- **The client's payment is simulated.** The step is an operator command with a reason. It posts to its own cash account (`cash:simulated`), every view says "SIMULATED, not received", and the cancel undid it: nothing shows as owed back to the client, because no money came in.
- **The cancel is the provider's answer, not ours.** The run became `cancelled` only after the distribution and the invoice were each read again and showed `cancelled`: the trace has a read before and after each cancel call.

## The key and the grant

- `GET /platform/me`: the key's environment is `test`, with 63 scopes approved. They fall in 17 families: `affiliateLink`, `business`, `campaign`, `distribution`, `gameplay`, `gift`, `invoice`, `item`, `lookup`, `platform`, `platform.grant`, `platform.invite`, `platform.key`, `platform.scope`, `receiving_account`, `splitTemplate` and `vc`.
- `GET /platform/grants`: one active grant, holding 5 virtual-currency scopes. The first calls on the business answered `403 SCOPE_NOT_GRANTED`, each naming the missing scope.
- After a link session was approved in the portal, the grant held 19 scopes and the same calls answered `200`.

## What is left at the provider

Read with `open-objects` on 2026-11-17, after everything: **30 invoices, 28 `cancelled` and 2 `paid`; 22 distributions, 20 `cancelled` and 2 `completed`.** Nothing is open, and no campaign, template or extra key is left. The paid invoices and the completed distributions are the two runs paid for real.

## Not exercised on the real API

- **`Platform.Gifts.Funded`.** It never arrived: the payout was paid from the dashboard, and no event reported it.
- **A claimed gift, an expired one, a line that fails.** The claim links expire in seven days. What the line shows then is not known.
- **A distribution with a fee.** The test account has no fee rules.
- **A lost answer.** The real API cannot be told to drop one. That is drill 1, on the stand-in.
