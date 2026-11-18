# Part 2 feedback: building on the Platform API

Test environment, platform `wes-inc-489cfe37`, host `https://www.oncade.gg`. Calls made on 2026-11-16 and 2026-11-17. Docs as read at `pay.oncade.xyz/docs` on 2026-11-17.

**How these were found.** I took invoices and payouts end to end on the test API, with webhooks. Then I asked every family of the API the same five questions: does the happy path work, what does a bad request answer, does a repeated `Idempotency-Key` make a duplicate, what does a call in the wrong state answer, and which webhooks arrive. That is 72 of the 75 endpoints in the reference, with a second account where a call needs one. The scripts are in [`explore/`](../explore/), and every endpoint is in [`docs/api-coverage.md`](../docs/api-coverage.md).

**How to read an item.** Where it happened, what I did, what I expected, what happened, and a tag: broken, feels broken or confusing. Each item names its source: a reply recorded in this repository, a page of the docs, or a screenshot.

**The screenshots are in Portuguese.** The Pay app and the developer portal showed me Oncade's Portuguese version. Where an item quotes one of those screens, the English is my translation.

## Summary

28 items: 4 broken, 9 feels broken, 15 confusing.

| #   | Tag          | Item                                                                                                                                                                           |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | broken       | [A repeated Idempotency-Key creates a duplicate on five kinds of create](#1-a-repeated-idempotency-key-creates-a-duplicate-on-five-kinds-of-create)                            |
| 2   | broken       | [Starting or stopping a test campaign answers 500](#2-starting-or-stopping-a-test-campaign-answers-500)                                                                        |
| 3   | confusing    | [No event tells a platform that a payout paid from the dashboard is done](#3-no-event-tells-a-platform-that-a-payout-paid-from-the-dashboard-is-done)                          |
| 4   | confusing    | [In test, money comes from a public faucet, and nothing says so](#4-in-test-money-comes-from-a-public-faucet-and-nothing-says-so)                                              |
| 5   | feels broken | [A payout accepts a total that does not match its recipients, and changes it silently](#5-a-payout-accepts-a-total-that-does-not-match-its-recipients-and-changes-it-silently) |
| 6   | feels broken | [A funded, running campaign can be deleted, and its funds do not come back](#6-a-funded-running-campaign-can-be-deleted-and-its-funds-do-not-come-back)                        |
| 7   | feels broken | [A cancelled distribution still shows its recipients as pending](#7-a-cancelled-distribution-still-shows-its-recipients-as-pending)                                            |
| 8   | feels broken | [Reading one distribution answers 410 with a misleading hint](#8-reading-one-distribution-answers-410-with-a-misleading-hint)                                                  |
| 9   | confusing    | [One person can be in a payout three times](#9-one-person-can-be-in-a-payout-three-times)                                                                                      |
| 10  | feels broken | [An invite to a business that does not exist is accepted](#10-an-invite-to-a-business-that-does-not-exist-is-accepted)                                                         |
| 11  | feels broken | [A campaign accepts a webhook URL that is not HTTPS](#11-a-campaign-accepts-a-webhook-url-that-is-not-https)                                                                   |
| 12  | confusing    | [The Idempotency-Key must be a UUID, and the docs do not say so](#12-the-idempotency-key-must-be-a-uuid-and-the-docs-do-not-say-so)                                            |
| 13  | confusing    | [Error answers do not follow one pattern](#13-error-answers-do-not-follow-one-pattern)                                                                                         |
| 14  | confusing    | [Two fields in every payout reply are not in the docs](#14-two-fields-in-every-payout-reply-are-not-in-the-docs)                                                               |
| 15  | confusing    | [After creating the platform, the grant had no invoice or payout scope](#15-after-creating-the-platform-the-grant-had-no-invoice-or-payout-scope)                              |
| 16  | broken       | [The webhook verifier in the Webhooks guide throws on a bad signature](#16-the-webhook-verifier-in-the-webhooks-guide-throws-on-a-bad-signature)                               |
| 17  | broken       | [The campaign examples in the guide do not work](#17-the-campaign-examples-in-the-guide-do-not-work)                                                                           |
| 18  | confusing    | ["Webhooks Guide" in the platform docs opens the game webhooks guide](#18-webhooks-guide-in-the-platform-docs-opens-the-game-webhooks-guide)                                   |
| 19  | confusing    | [No example payload for invoice events](#19-no-example-payload-for-invoice-events)                                                                                             |
| 20  | confusing    | [The docs and the API disagree on an error code and an event name](#20-the-docs-and-the-api-disagree-on-an-error-code-and-an-event-name)                                       |
| 21  | confusing    | [The reference is missing calls that exist](#21-the-reference-is-missing-calls-that-exist)                                                                                     |
| 22  | confusing    | [Webhook retries: no delivery id, no schedule](#22-webhook-retries-no-delivery-id-no-schedule)                                                                                 |
| 23  | feels broken | [The link page shows an error before it asks to sign in](#23-the-link-page-shows-an-error-before-it-asks-to-sign-in)                                                           |
| 24  | confusing    | [The link request does not say what linking allows](#24-the-link-request-does-not-say-what-linking-allows)                                                                     |
| 25  | feels broken | [After funding, the page reports success and still shows zero](#25-after-funding-the-page-reports-success-and-still-shows-zero)                                                |
| 26  | confusing    | [The webhook settings say the webhook is only for link events](#26-the-webhook-settings-say-the-webhook-is-only-for-link-events)                                               |
| 27  | feels broken | [The portal saves a webhook URL whose host is incomplete](#27-the-portal-saves-a-webhook-url-whose-host-is-incomplete)                                                         |
| 28  | confusing    | [The "next steps" e-mail to a platform builder is about games](#28-the-next-steps-e-mail-to-a-platform-builder-is-about-games)                                                 |

## The five I would look at first

### 1. A repeated Idempotency-Key creates a duplicate on five kinds of create

**Tag:** broken

- **Where:** `POST /invoices`, `POST /distributions`, `POST /invoice-templates`, `POST /campaigns` and `POST /me/keys`.
- **What I did:** sent the same request twice, with the same `Idempotency-Key` (a UUID) and the same body.
- **What I expected:** the second call returns the first object. The reference says the header is there "to safely retry requests without creating duplicates".
- **What happened:** `201` both times, with two different ids: two invoices, two payouts, two recurring invoices, two campaigns, two API keys. An invoice call with the same key and another amount also answered `201`.
- **The mechanism exists:** on three other calls the same key answered `200` and returned the first object: the fund session of a payout, the fund session of a campaign, and the link session of a business user. So the header is honoured there and ignored on the five creates above. (Split templates are safe for another reason: a second one with the same name answers `409 DUPLICATE_NAME`.)
- **How sure I am:** invoices on two days (2026-11-16 and 17), with two HTTP clients, on drafts addressed to a business and to an e-mail address. Distributions on both days. Recurring invoices, campaigns and API keys once. Everything was cancelled, deleted or revoked afterwards.
- **Why it matters:** a platform that retries a payout after a timeout creates a second payout for the same people. A retried recurring invoice bills a client twice every month. A retried campaign deploys a second contract.
- **To reproduce:** `npm run explore -- invoices`, `payouts`, `invoice-templates`, `campaigns`, `keys`. Each prints a line "repeated key".
- **What I did meanwhile:** my client sends a create once. After a lost answer it looks for the object by its own reference (`externalMetadata` on an invoice, the memo on a distribution). One found: it adopts it. None or two: it stops and asks a person.
- **Source:** the two replies to one key, [`invoice-created.json`](../tests/contract/fixtures/invoice-created.json) and [`invoice-created-same-key.json`](../tests/contract/fixtures/invoice-created-same-key.json), [`distribution-created.json`](../tests/contract/fixtures/distribution-created.json) and [`distribution-created-same-key.json`](../tests/contract/fixtures/distribution-created-same-key.json); and the line "repeated key" in [`invoices.json`](../explore/results/invoices.json) ("repeated key"), [`payouts.json`](../explore/results/payouts.json), [`invoice-templates.json`](../explore/results/invoice-templates.json), [`campaigns.json`](../explore/results/campaigns.json), [`keys.json`](../explore/results/keys.json), [`business-users.json`](../explore/results/business-users.json) and [`split-templates.json`](../explore/results/split-templates.json).

### 2. Starting or stopping a test campaign answers 500

**Tag:** broken

- **Where:** `PUT /campaigns/{campaignId}/start`, `PUT /campaigns/{campaignId}/stop` and `POST /campaigns/{campaignId}/events`.
- **What I did:** created a campaign with one event. A second account joined it through a link session and was approved. The business owner funded it with $5.00 through a fund session. Then I called start, and recorded the event for the person who had joined.
- **What I expected:** start to succeed, and the event to pay the person.
- **What happened:**
  - start and stop answered `500 "Temporarily unavailable. Please try again later. If this persists please reach out to the Oncade team."` every time: nine calls on five campaigns, funded or not, with or without a member;
  - on the funded campaign, the event and a one-time tip answered `404 "Platform user not found"`. I saw this once, for a person who joined through a link session opened with `userRef: "new"`. The same reference worked on the other calls: the user list showed the person, and their wallet balance read `200`. It may follow from the campaign never having started.
- **So:** joining and funding work. I could not take the campaign flow to a payout in test.
- **Also:** the reference shows a new campaign as `status: "created"`. Mine came back as `"active"`.
- **Source:** [`campaigns.json`](../explore/results/campaigns.json) ("start and stop") and [`campaign-join-close.json`](../explore/results/campaign-join-close.json) ("events").

### 3. No event tells a platform that a payout paid from the dashboard is done

**Tag:** confusing

- **Where:** a distribution with `payoutPath: "dashboard"`, paid by the business owner under Pay people.
- **What I did:** created the payout through the API, then paid it from the dashboard with the test balance.
- **What I expected:** an event for it, as `Platform.Invoice.Paid` came for the invoice a few minutes earlier.
- **What happened:** nothing was delivered. The webhook log shows no event for it. My service found out by reading the distribution list: `completed`, every line `sent`. It was the same on both runs I paid that day.
- **Why it matters:** the docs say webhooks keep a system "in sync without polling". For this path I have to poll.
- **Question:** is `Platform.Gifts.Funded` meant to fire here, or is an event for a completed distribution planned?
- **Source:** the paid payout as the list returned it, [`distribution-list-paid.json`](../tests/contract/fixtures/distribution-list-paid.json), from the first paid run, and the timeline of the second in [`docs/test-api-run.md`](../docs/test-api-run.md).

### 4. In test, money comes from a public faucet, and nothing says so

**Tag:** confusing

- **Where:** the funding page of a payout (`fund_session`), the hosted invoice page ("Pay now" → "Oncade balance"), and "Add funds".
- **What I did:** tried to pay a test invoice and to fund a test payout.
- **What I expected:** the docs, or the page, to say where test money comes from.
- **What happened, in three screens:**
  1. the funding page says "test tokens only" and "you need $6.00 but have $0.00";
  2. "Add funds" offers only real bank transfers and real crypto deposits, with no "test" label;
  3. only the payment confirmation window shows the answer: the balance is a wallet on **Base Sepolia**, marked "Test". It says "add funds to your wallet and try again", without saying how.
- **What worked in the end:** I sent test USDC from Circle's public faucet to that wallet. The balance showed $20.00. I paid the invoice ($6.03 with the fee) and the payout ($6.00), and my run ended `completed`, with nothing simulated.
- **What the docs say:** "testnet" and "faucet" appear in none of the sixteen pages under `pay.oncade.xyz/docs`, as read on 2026-11-17. `base-sepolia` appears once, as a value inside an example reply in the reference. No page says that a test balance is a wallet on Base Sepolia, or how to fill it. Getting Started for Platforms says test is good for "Building and rehearsing the whole flow end to end"; one sentence about test funds would make that true for the steps that move money.
- **Also:** the reference shows the fund session URL as `https://oncade.gg/fund-distribution?session=…`. The real one is under `pay.oncade.xyz/platform/{platform}/{business}/fund-distribution`, as the Embedded Finance page says.
- **Screenshots:** [`03-fund-payout-zero-balance.png`](screenshots/03-fund-payout-zero-balance.png), [`08-add-funds-options.png`](screenshots/08-add-funds-options.png), [`14-confirm-payment-base-sepolia.png`](screenshots/14-confirm-payment-base-sepolia.png).
- **Source:** the three screenshots; the docs as searched on 2026-11-17.

### 5. A payout accepts a total that does not match its recipients, and changes it silently

**Tag:** feels broken

- **Where:** `POST /distributions`, `mode: "fixed"`.
- **What I did:** sent `totalAmountCents: 999` with three recipients of 1, 2 and 3 dollars.
- **What I expected:** `400`, as on an invoice, where a wrong `total` answers "Total mismatch".
- **What happened:** `201`. The stored `totalAmountCents` is `600`. My number was replaced without a word.
- **Why it matters:** the two numbers exist so that one can catch a mistake in the other. Here a caller with a bug in either gets a success.
- **Source:** [`payouts.json`](../explore/results/payouts.json) ("validation"): `amounts≠total 201`.

## API behaviour

### 6. A funded, running campaign can be deleted, and its funds do not come back

**Tag:** feels broken

- **Where:** `DELETE /campaigns/{campaignId}`.
- **What I did:** deleted a campaign that was `active` and held $5.00 of test funds, after stop had answered 500.
- **What I expected:** a refusal. The guide says deletion is only allowed for a campaign that is created or stopped, and that remaining funds can be withdrawn after a stop.
- **What happened:** `204`. The campaign is gone from the list. The business balance did not receive the $5.00 back: it read the same fifteen minutes and seventy minutes after the delete, with no campaign left in the list.
- **Why it matters:** with real money this is a way to lose funds with one call.
- **Source:** [`campaign-join-close.json`](../explore/results/campaign-join-close.json): funded with `5000000`, stop `500`, delete `204`. The balance afterwards was read by hand, fifteen and seventy minutes after the delete, and is not recorded.

### 7. A cancelled distribution still shows its recipients as pending

**Tag:** feels broken

- **Where:** `POST /api/v1/platform/distributions/{id}/cancel`, and the list afterwards.
- **What I did:** cancelled a pending distribution of three recipients.
- **What I expected:** the distribution and its line items to show `cancelled`.
- **What happened:** the distribution is `cancelled`, with `cancelledAt`. Each line item is still `pending`.
- **Why it matters:** an integrator who tracks each recipient reads "still to be paid". I take the distribution's own status as the answer, unless a line shows as paid: then a person decides.
- **Source:** [`distribution-cancelled.json`](../tests/contract/fixtures/distribution-cancelled.json).

### 8. Reading one distribution answers 410 with a misleading hint

**Tag:** feels broken

- **Where:** `GET /api/v1/platform/distributions/{id}`.
- **What I did:** read a distribution I had just created, by its id.
- **What I expected:** the distribution, or a 404 that says this route does not exist.
- **What happened:** `410 { "error": "Endpoint not found.  Did you mean /api/v1/ for your api call?." }`. I was already on `/api/v1/`.
- **Note:** the reference lists no read-one call for distributions, so I find mine by walking the list and matching my reference in the memo. A read by id, or a filter on the list, would remove that walk.
- **Source:** [`distribution-get-by-id.json`](../tests/contract/fixtures/distribution-get-by-id.json).

### 9. One person can be in a payout three times

**Tag:** confusing

- **Where:** `POST /distributions`.
- **What I did:** sent three recipients with the same e-mail address.
- **What I expected:** `400`, or one merged line.
- **What happened:** `201`, with three line items for one address.
- **Why it matters:** a line item has no id of its own; I match each one to a person by address. With a repeated address the lines cannot be told apart. My service refuses a payroll with a repeated address for that reason.
- **Source:** [`payouts.json`](../explore/results/payouts.json) ("validation"): `same person three times 201`.

### 10. An invite to a business that does not exist is accepted

**Tag:** feels broken

- **Where:** `POST /invites`.
- **What I did:** sent `businessId: "000000000000000000000000"`.
- **What I expected:** `404`.
- **What happened:** `201`, an invite in `pending` with an expiry date. I cancelled it.
- **Source:** [`platform.json`](../explore/results/platform.json) ("invites").

### 11. A campaign accepts a webhook URL that is not HTTPS

**Tag:** feels broken

- **Where:** `POST /campaigns`, `webhookUrl`.
- **What I did:** sent `"webhookUrl": "http://example.com/hook"`.
- **What I expected:** `400`. The reference says the URL "must be HTTPS and will be validated".
- **What happened:** `201`. I deleted the campaign.
- **Source:** [`campaigns.json`](../explore/results/campaigns.json) ("validation"): `http webhook URL 201`.

### 12. The Idempotency-Key must be a UUID, and the docs do not say so

**Tag:** confusing

- **Where:** any POST. Seen on `POST /invoices`.
- **What I did:** sent `Idempotency-Key: explore-<my reference>`, a readable key built from my own reference.
- **What I expected:** any unique string to be accepted. The docs only show `$(uuidgen)` in examples.
- **What happened:** `400 { "error": "Invalid Idempotency-Key format. Expected UUID format." }`.
- **Why it matters:** deriving the key from a business reference is the usual way to make a retry carry the same key. It works only after hashing the reference into a UUID shape.
- **Source:** [`invoices.json`](../explore/results/invoices.json) ("validation"): `a key that is not a UUID 400`.

### 13. Error answers do not follow one pattern

**Tag:** confusing

- **Where:** across the API. Each line below was seen.
- **A call in the wrong state** answers with four different statuses:
  - `422` with a code: send or cancel an invoice in the wrong status, cancel a payout twice;
  - `403` with no code: update a cancelled invoice ("Cancelled invoices cannot be modified"). A 403 reads as a permission problem;
  - `400` with a code: revoke a key twice (`ALREADY_REVOKED`), cancel an invite twice;
  - `404`: delete a recurring invoice twice.
- **Cancelling an invite twice** answers code `INVITE_ALREADY_ACCEPTED` with the message "Invite is already cancelled".
- **A validation error** has a `code` on recurring invoices (`INVALID_TEMPLATE`) and on some payout fields (`INVALID_RECIPIENTS`), and none on invoices.
- **A missing object** has a code for invoices and recurring invoices (`INVOICE_NOT_FOUND`, `TEMPLATE_NOT_FOUND`) and none for payouts, link sessions and keys.
- **An unknown `mode`** on a payout answers "Invalid percentage for <the recipient's address>": the message is about another field, and it repeats an e-mail address.
- **Why it matters:** an integrator writes one error handler. Today it needs a table per endpoint.
- **Source:** the lines "wrong state" and "validation" in [`invoices.json`](../explore/results/invoices.json), [`payouts.json`](../explore/results/payouts.json), [`keys.json`](../explore/results/keys.json), [`platform.json`](../explore/results/platform.json) and [`invoice-templates.json`](../explore/results/invoice-templates.json).

### 14. Two fields in every payout reply are not in the docs

**Tag:** confusing

- **Where:** `GET /distributions/fee-preview` and every distribution reply.
- **What I did:** read the reply to compute what the business must fund.
- **What I expected:** every money field to be in the reference.
- **What happened:** `recipientPaysPercentage: true` and `recipientPaysPlatformFeePercentage: true` come back, with an empty `fees` list. I found neither name in the reference or the guides.
- **Question:** does a recipient receive less than the `amount` I send?
- **Source:** [`fee-preview.json`](../tests/contract/fixtures/fee-preview.json) and [`distribution-created.json`](../tests/contract/fixtures/distribution-created.json).

### 15. After creating the platform, the grant had no invoice or payout scope

**Tag:** confusing

- **Where:** developer portal, then `GET /api/v1/platform/grants` and the first `POST /invoices`.
- **What I did:** created a test platform in my business, made a key, and read the invoices of that business.
- **What I expected:** it to work. The docs say a new platform "is automatically granted access to the business that owns it".
- **What happened:** `403 { "error": "Grant does not include required scope: invoice:read", "code": "SCOPE_NOT_GRANTED" }`. The grant held only virtual-currency scopes. I opened a link session for the scopes, approved it in the portal, and the grant went from 5 scopes to 19.
- **What helped:** the error named the missing scope, so it took minutes. What I missed is one sentence saying that a key's scopes and a grant's scopes are two lists, and which one a 403 is about.
- **Source:** the section "The key and the grant" of [`docs/test-api-run.md`](../docs/test-api-run.md).

## Documentation

### 16. The webhook verifier in the Webhooks guide throws on a bad signature

**Tag:** broken (the example, not the service)

- **Where:** `dev.oncade.xyz/docs/guides/webhooks`, "Minimal Verifier".
- **What I did:** copied `verifyOncadeSignature` and called it with five signatures.
- **What I expected:** `false` for every wrong signature.
- **What happened:** it returns `false` for a wrong signature of the right length, and **throws** `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` for a short one, for one that is not hex, and for one with a `sha256=` prefix. A handler built from it answers 500 to anyone who posts garbage.
- **Note:** the verifier in the Platform API Reference is right: it compares the lengths first. The two pages give different code for the same job.
- **Source:** the guide's code, copied on 2026-11-17 and run on Node 24 with the five signatures.

### 17. The campaign examples in the guide do not work

**Tag:** broken (the examples)

- **Where:** Platform Payouts guide, "Campaigns", steps 1 and 3.
- **What I did:** sent the guide's own example for creating a campaign, with `"payoutAmount": "5000000"`. Then I posted to the path it shows for a link session, `/campaigns/{id}/link/users/initiate`.
- **What I expected:** `201` for both.
- **What happened:** the create answered `400 "Invalid events"`. With a number, as the reference shows (`"payoutAmount": 500`), it answered `201`. The link path answered `410 "Endpoint not found"`; the path in the reference, `/campaigns/{campaignId}/users/{userRef}/link/initiate`, works.
- **The unit is unclear too:** the guide says USDC smallest units ("5000000 = $5.00"), the reference shows `500`, and a tip on the events call is "in USD". The replies mix units as well: after $5.00 of funding the campaign's balance reads `5000000`, while a wallet balance reads `"0.00"`. I sent an event amount of `1` and could not find out what it pays, because no event could be recorded.
- **Source:** [`campaigns.json`](../explore/results/campaigns.json), lines "validation" and "joining": `the guide's example, amounts as strings 400`, `the guide's path 410`.

### 18. "Webhooks Guide" in the platform docs opens the game webhooks guide

**Tag:** confusing

- **Where:** the "Webhooks Guide" link under References in the Platform Invoices guide, and at the end of the Platform API Reference.
- **What I did:** followed it to learn the invoice and payout events.
- **What I expected:** the platform events, and where the platform secret is.
- **What happened:** it opens `dev.oncade.xyz/docs/guides/webhooks`, which covers purchases, cashouts and listings. It says the key is under Dashboard → Games → Webhooks. It has no `Platform.Invoice.*` or `Platform.Distribution.*` event. The right text is the Webhooks section of the Platform API Reference.
- **Source:** the two pages, as read on 2026-11-17.

### 19. No example payload for invoice events

**Tag:** confusing

- **Where:** Platform API Reference, Webhooks, "Example Webhook Payloads".
- **What I did:** looked for the body of `Platform.Invoice.Paid` before writing the handler.
- **What I expected:** an example, as there is for link, campaign, distribution, gift and verification events.
- **What happened:** none for the five invoice events. The text says to use "the invoiceId from the event".
- **Seen on 2026-11-17, in the portal's delivery log:** the body of `Platform.Invoice.Cancelled` has `invoiceId`, `invoiceNumber`, `businessId`, `receiverName`, `receiverEmail`, `total` (dollars), `currency`, `status`, `environment` and `publicInvoiceId`. So `invoiceId` is the name, and the event carries the receiver's e-mail address, which a handler should keep out of its logs.
- **Confirmed the same day:** my endpoint received `Platform.Invoice.Created` and `Platform.Invoice.Cancelled` with exactly those fields. An invoice created as `sent` arrived as `Platform.Invoice.Created` with `status: "sent"`.
- **Source:** [`webhook-invoice-cancelled.json`](../tests/contract/fixtures/webhook-invoice-cancelled.json) and [`webhook-invoice-created.json`](../tests/contract/fixtures/webhook-invoice-created.json).

### 20. The docs and the API disagree on an error code and an event name

**Tag:** confusing

- **Where:** Platform Payouts guide, "Cancelling a distribution".
- **What I did:** cancelled a distribution twice, and compared the reply with the guide.
- **What I expected:** `422` with code `NOT_CANCELLABLE`, as the guide and the reference say.
- **What happened:** `422` with code `DISTRIBUTION_NOT_CANCELLABLE`.
- **Also:** the same paragraph names the event `platform.distribution.cancelled`. The reference writes `Platform.Distribution.Cancelled`. A handler that compares strings needs the exact case. Seen in a real delivery: the header and the body both carry `Platform.Distribution.Cancelled`, with that case.
- **Also:** the reference shows a three-field reply for cancelling an invoice (`_id`, `status`, `invoiceNumber`). The API returned the whole invoice.
- **Source:** [`distribution-cancel-twice.json`](../tests/contract/fixtures/distribution-cancel-twice.json), [`webhook-distribution-cancelled.json`](../tests/contract/fixtures/webhook-distribution-cancelled.json) and [`invoice-cancelled.json`](../tests/contract/fixtures/invoice-cancelled.json).

### 21. The reference is missing calls that exist

**Tag:** confusing

- **Where:** Platform API Reference, the endpoint list.
- **What I did:** called two endpoints that the docs mention but the reference does not list.
- **What happened:**
  - `DELETE /campaigns/{campaignId}/fund-sessions/{handle}`, from the guide: `200 { "success": true }`. The reference lists create and read only.
  - `GET /business/users/{userRef}/compliance`, named twice in the webhook text: `404 USER_REF_NOT_FOUND` for a user who does not exist, with a clear message, so the route is there.
- **Also:** my test key carries scopes in four families the reference never mentions: `affiliateLink`, `gameplay`, `item` and `receiving_account`.
- **Also:** the reference says assigning a business user to a campaign returns a campaign reference that starts with `pvu_`. Mine was a bare UUID.
- **Source:** [`campaigns.json`](../explore/results/campaigns.json) ("fund sessions") and [`business-users.json`](../explore/results/business-users.json) ("wrong state"); the scope families of the key are listed in [`docs/test-api-run.md`](../docs/test-api-run.md).

### 22. Webhook retries: no delivery id, no schedule

**Tag:** confusing

- **Where:** Platform API Reference, Webhooks; Webhooks guide, "Best Practices".
- **What I did:** wrote the handler so that a repeated delivery runs once.
- **What I expected:** a delivery id to deduplicate on, and the retry schedule.
- **What happened:** the body is `event`, `data`, `timestamp`, and the headers are the signature, the event and the platform id. The guide says to "store the latest processed idempotency key", but no key is sent. I deduplicate on a hash of the raw body.
- **Seen on 2026-11-17, in the portal's delivery log:** deliveries are retried by themselves. One event was on attempt 3 about 18 minutes after it happened, another on attempt 5 after 24 minutes. The schedule and the last attempt are not in the docs.
- **Confirmed the same day:** a resend from the portal has the same bytes. My endpoint recognised it by the hash of the body and answered `{ "received": true, "duplicate": true }`.
- **Source:** the eight recorded deliveries, `webhook-*.json` in [`tests/contract/fixtures/`](../tests/contract/fixtures/); the retries were read in the portal's delivery log.

## Hosted pages

### 23. The link page shows an error before it asks to sign in

**Tag:** feels broken

- **Where:** the link session URL, on `www.oncade.gg/link`.
- **What I did:** opened it as the person being invited, already signed in at `pay.oncade.xyz`.
- **What I expected:** to be recognised, or to be asked to sign in.
- **What happened:** a red error, "Authentication token not available. Please log in.", in the page and again as a pop-up, above a Sign In button. Signing in at the Pay app does not carry over to this site. After signing in again the page worked.
- **Screenshot:** [`30-link-authentication-error.png`](screenshots/30-link-authentication-error.png).

### 24. The link request does not say what linking allows

**Tag:** confusing

- **Where:** the same page, after signing in.
- **What I saw:** "Wesley, through Wes Inc, is requesting to link with your Oncade account", with Approve and Decline. For a campaign: "API exploration is requesting to link with your Oncade account".
- **What I expected:** one line on what the business or the campaign can do once I approve: pay me, see my balance, see my e-mail address.
- **What happened:** nothing about it. The person approving has only two names to go on.
- **Screenshots:** [`31-link-business.png`](screenshots/31-link-business.png), [`32-link-campaign.png`](screenshots/32-link-campaign.png).

### 25. After funding, the page reports success and still shows zero

**Tag:** feels broken

- **Where:** the hosted page of a campaign fund session.
- **What I did:** funded the campaign with $5.00 from the test balance.
- **What I expected:** the totals on the page to change.
- **What happened:** a green box says the campaign was funded successfully, and above it the page still shows total funded $0.00, available $0.00 and my balance as it was before. The API had it right at once: `totalFunded: 5000000`.
- **Screenshot:** [`34-campaign-funded-totals-at-zero.png`](screenshots/34-campaign-funded-totals-at-zero.png).
- **Source:** the screenshot, and [`campaign-join-close.json`](../explore/results/campaign-join-close.json) ("joining and funding") for what the API said.

## Developer portal

### 26. The webhook settings say the webhook is only for link events

**Tag:** confusing

- **Where:** developer portal, the platform, Settings, the webhook section.
- **What I did:** set the webhook URL to receive invoice and payout events.
- **What I expected:** the text to say which events are sent.
- **What happened:** the text under the heading says the URL receives notifications when businesses link or unlink, and the line under the field says POST requests are sent to it when linking events happen. The reference lists invoice, distribution, campaign, gift and verification events for the same URL, and they do arrive.
- **Screenshot:** [`09-portal-webhook-settings.png`](screenshots/09-portal-webhook-settings.png).

### 27. The portal saves a webhook URL whose host is incomplete

**Tag:** feels broken

- **Where:** the same screen.
- **What I did:** saved a URL whose host had no domain: a tunnel address cut short when copied.
- **What I expected:** the form to refuse a host that cannot resolve, or a "send a test event" button that would fail at once.
- **What happened:** it was saved. Events were created and nothing arrived. The Webhooks tab showed why: every delivery "Failed", status 0, "Host could not be resolved". So the failure is visible to someone who opens that tab; nothing points to it on the screen where the URL is typed.
- **Screenshots:** [`10-portal-webhook-log-host-not-resolved.png`](screenshots/10-portal-webhook-log-host-not-resolved.png), [`16-portal-settings-url.png`](screenshots/16-portal-settings-url.png).

### 28. The "next steps" e-mail to a platform builder is about games

**Tag:** confusing

- **Where:** the e-mail "Your next steps on Oncade", received the day after signing up.
- **What I did:** signed up, created a test platform and generated a platform API key.
- **What I expected:** next steps for a platform: set the webhook URL, read the platform guides, make the first call.
- **What happened:** the three steps are "Add your first game", "Create a store item" and "Generate an API key". Nothing in it mentions platforms, invoices or payouts, and I already had a key. It ends with "Questions? Just reply to this email", and it comes from a `noreply@` address.
- **Screenshot:** [`04-email-next-steps.png`](screenshots/04-email-next-steps.png).

## What worked well

- **Joining.** A second account joined a business and a campaign in two clicks each, and the API showed it at once: the session `approved`, the person in the list, a wallet to read. Assigning a business user to a campaign and removing both links worked on the first call.
- **Linking a person to a business.** The same address, or the same key, returned the same session, as documented. Every refusal has a code that says what is wrong: `USER_NOT_LINKED`, `USER_REF_NOT_FOUND`, `SESSION_NOT_FOUND`.
- **The payout-path refusals.** A call on the wrong path answers `409 PAYOUT_PATH_MISMATCH` and says which path the payout has and which one the call accepts. It is the best error message in the API.
- **Key rotation works as documented.** The old key and the new one both worked during the grace period; a revoked key answered `403 KEY_REVOKED`.
- **A paid payout cannot be cancelled.** `422 DISTRIBUTION_NOT_CANCELLABLE`, "Cannot cancel distribution in 'completed' status".
- **The webhook log in the portal.** Every delivery with its event, URL, status code, attempt number, the error in words, the request body, my response body, and a Resend button. It is how I found that my URL was wrong, and how I tested a repeated delivery without creating anything new.
- **The scope error told me what to fix.** `403 { "code": "SCOPE_NOT_GRANTED" }` named the scope.
- **I could find my own objects again.** `externalMetadata` comes back on an invoice's create, get and list. The memo comes back on the distribution list.
- **Errors a person can read.** 21 recipients: `400 TOO_MANY_RECIPIENTS`, "A payout can have at most 20 recipients. This one has 21."
- **Test keys approve scopes at once.** I never waited for anyone.
- **A renamed field fails loudly.** `metadata` on an invoice answers 400 and names `externalMetadata`, and the guide explains the rename.
- **The verifier in the Platform API Reference is the safe one.** It reads the raw body and compares lengths before the constant-time compare.
