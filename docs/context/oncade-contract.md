# The Oncade calls this project uses

Read this before touching `lib/oncade/` or `stand-in/`. Sources: the public reference at `dev.oncade.xyz/docs/api-reference/platform`, read as raw text, and real replies from the test API, both on 2026-11-16. Scrubbed copies of the replies are in `tests/contract/fixtures/`.

Marks: **seen** = recorded from a real test-API reply. **docs** = from the documentation, not exercised here.

## Every call

- Host `https://www.oncade.gg`, path `/api/v1/platform/...` (**seen**).
- `Authorization: Bearer <key>`. The key decides the environment (**seen**: `keyInfo.environment: "test"`).
- `X-Oncade-API-Version: v1`.
- `X-Target-Business-Id: <business id>` on business calls. Without the scope in the grant: `403 { "error", "code": "SCOPE_NOT_GRANTED" }` (**seen**).
- Errors are `{ "error": string }`, sometimes with `"code"` (**seen**: 403 and 422 have a code, the 400 for `metadata` has none).

## What a repeated Idempotency-Key did

**Seen** on 2026-11-16, with two HTTP clients (`fetch` and `node:https`): an invoice (a draft, addressed to the business itself or to an e-mail address) and a distribution of three people, each posted again with the same `Idempotency-Key` and the same body, answered `201` with a **new** object. The reference says the header lets a client "safely retry requests without creating duplicates".

On 2026-11-17 the same happened for a recurring invoice, a campaign and an API key. The key is honoured on fund sessions and on business user link sessions: there the repeat answers `200` with the first object. The key must be a UUID: anything else answers `400` (**seen**).

So, in this code:

- a call that creates something is sent **once**. Never repeat it, with or without the same key;
- after no answer, look for the object by our reference. One found: adopt it. None: park for a person. Two: park for a person.

## Calls

| Call                              | What we send                                                                                                                                                           | What we read                                                                                                                        | Mark |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `GET /me`                         |                                                                                                                                                                        | `keyInfo.environment`, `approvedScopes`                                                                                             | seen |
| `GET /grants`                     |                                                                                                                                                                        | `grants[].businessId`, `grantedScopes`, `status`                                                                                    | seen |
| `POST /link-sessions`             | `requestedScopes`                                                                                                                                                      | `url`, `sessionId` (201)                                                                                                            | seen |
| `GET /business/readiness`         |                                                                                                                                                                        | `ready`, `steps`                                                                                                                    | seen |
| `GET /distributions/fee-preview`  |                                                                                                                                                                        | `fees[]` (`label`, `percentage`, `flat` in cents, `feeType`); empty in test                                                         | seen |
| `POST /invoices`                  | `receiverName`, `receiverEmail` or `recipientBusinessId`, `date`, `payToTarget: "BUSINESS"`, `items[]` (`rate`, `amount` in **dollars**), `status`, `externalMetadata` | `_id`, `status`, `total` (dollars), `links.invoice`                                                                                 | seen |
| `GET /invoices/{id}`              |                                                                                                                                                                        | the same object                                                                                                                     | seen |
| `GET /invoices?page&limit`        |                                                                                                                                                                        | `invoices[]` with `externalMetadata`, `pagination.totalPages`                                                                       | seen |
| `POST /invoices/{id}/cancel`      |                                                                                                                                                                        | the invoice, `status: "cancelled"`; a second cancel: `422 INVOICE_INVALID_STATUS`                                                   | seen |
| `POST /distributions`             | `recipients[]` (`email`, `name`, `amount` in **dollars**), `mode: "fixed"`, `totalAmountCents`, `memo`, `payoutPath: "dashboard"`                                      | `_id`, `status: "pending"`, `totalAmountCents`, `totalFeeCents`, `memo`, `lineItems[]` (`email`, `amountCents`, `status`, `method`) | seen |
| `GET /distributions?page&limit`   |                                                                                                                                                                        | `distributions[]`, each with `memo` and `lineItems`; `pagination.totalPages`                                                        | seen |
| `POST /distributions/{id}/cancel` |                                                                                                                                                                        | the distribution, `status: "cancelled"`; a second cancel: `422 DISTRIBUTION_NOT_CANCELLABLE`                                        | seen |

No call reads one distribution: `GET /distributions/{id}` answers `410` (**seen**). We find ours in the list, by the reference in its memo.

## Facts that shape the code

- A distribution holds at most 20 recipients; more returns `400 TOO_MANY_RECIPIENTS` (**seen**). We never send more.
- Units differ: `totalAmountCents`, `amountCents`, `flat` are cents; `recipients[].amount`, `items[].rate`, `items[].amount`, `total` are dollars (**seen**). Conversion happens only in `lib/oncade/client.ts`.
- The payer of an invoice pays a fee on top: `paymentSummary` has `invoiceAmount`, `payerFee`, `totalCharged` (**seen**: 0.5%). The business receives `invoiceAmount`, which is `total`.
- Invoice states: `draft`, `sent`, `processing`, `paid`, `cancelled` (**docs**; all but `processing` **seen**).
- Distribution states: `draft`, `pending`, `funded`, `processing`, `completed`, `cancelled`; cancel only in `draft` or `pending` (**docs**; `pending`, `completed` and `cancelled` **seen**).
- Each recipient has a line item with its own `status` and `method`, and no id: the e-mail address identifies it, and comes back exactly as sent (**seen**). So we track each person. A paid line is `sent`, with `transactionHash` and `sentAt` (**seen**).
- A cancelled distribution keeps its lines as `pending` (**seen**): its own status is the answer, unless a line shows as paid. Then a person decides.
- `payoutPath: "dashboard"`: the business owner pays from the Oncade dashboard. We send no money (**seen**).
- Test money is USDC on Base Sepolia (**seen** in the hosted payment window, not in the docs). A public faucet fills the test balance.
- Custom data on an invoice goes in `externalMetadata`; `metadata` answers 400 (**seen**).

## Webhooks

- Headers: `x-oncade-signature` (hex HMAC-SHA256 of the raw body, keyed with the platform webhook secret), `x-oncade-event`, `x-oncade-platform-id` (**seen** 2026-11-17: a real delivery passed our check).
- Body: `{ "event", "data", "timestamp" }`. No delivery id (**seen**): we deduplicate on a hash of the raw body.
- Events that lead to a check: every `Platform.Invoice.*` and `Platform.Distribution.*`, and `Platform.Gifts.Funded`. Invoice events carry `invoiceId` (**seen**), plus the receiver's e-mail address: never log a payload.
- No event came for a payout paid from the dashboard (**seen**). We read the list.

## Not known yet

1. `Platform.Gifts.Funded`: never received.
2. A claimed gift, an expired one (links last seven days), a line that fails.
3. A distribution with a fee: the test account has no fee rules.
