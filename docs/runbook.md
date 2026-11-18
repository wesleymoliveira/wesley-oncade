# Runbook: what to do when an alert fires

Start every case the same way: `npm run where -- <reference>` for the run, then its traces in Grafana. For a run on the Oncade test API the same commands end in `:oncade`: `npm run where:oncade -- <reference>`, `npm run operator:oncade -- dead-letters`.

## LedgerOutOfBalance

**Means:** a stored balance differs from the sum of its ledger entries. **Page.**

1. Stop payouts: stop the worker. Nothing is lost; messages wait in the queue.
2. Compare `balances` with the entries of the affected accounts. The entries are the truth: they are only ever added.
3. Find the transaction that wrote one side only. Correct with a new ledger transaction, never by editing an entry.

## BatchWaitingForAPerson

**Means:** a batch is `parked`. Its `problem` says why. **Page.**

| Problem                                          | What happened                                                                                                        | What to do                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `outcome_unknown_not_found_at_provider`          | We sent, got no answer, and the provider does not show the distribution                                              | Wait, look again at the provider. If it is still absent, mark the batch failed and use "retry failed". Never resend the batch |
| `duplicate_distributions_at_provider`            | Two live distributions carry this batch's reference. The provider does not deduplicate a repeated create             | Cancel the extra one at the provider. Then look again: the batch adopts the one that is left                                  |
| `partial_payout`                                 | The provider completed the distribution and not every line shows as paid, or cancelled it while a line shows as paid | Ask the provider about the missing lines before releasing anyone                                                              |
| `amount_mismatch`, `amount_differs_from_request` | The provider's amounts or people differ from ours                                                                    | Do not pay. Find which side is wrong                                                                                          |
| `missing_at_provider`                            | The provider no longer has a distribution we recorded                                                                | Ask the provider                                                                                                              |
| `fee_above_reserve`                              | The fee is higher than the invoice reserved                                                                          | Cancel the distribution at the provider, or approve the extra fee                                                             |

## BatchOutcomeUnknown

**Means:** a batch has been `sending` for too long. A worker died mid-call, or the provider is not answering. **Page.**

It usually clears itself: when the lease ends, the next worker asks the provider whether the send exists. If it does not clear, the worker is down (see `CheckStopped`) or the provider is unreachable (see `ProviderBreakerOpen`).

## DeadLetters

**Means:** a message failed three times. **Page.**

1. `npm run operator -- dead-letters` shows it.
2. The worker log has the reason: search `queue.handler_failed`.
3. After the fix: `npm run operator -- dead-letters redrive`. If the message is garbage: `drop`.

## CheckStopped

**Means:** the periodic check has not completed, or no worker is reporting. The safety net has a hole: a lost webhook would stay lost. **Page.**

1. Is the worker running? Start it.
2. If it runs, a step is failing: search the log for `sweep.step_failed`.

## ProviderBreakerOpen

**Means:** three calls in a row got no answer. The worker stopped taking work. **Ticket; page if it lasts.**

Nothing to do while the provider is down: messages wait, the breaker probes by itself and closes when a call succeeds. Check the provider's status and tell the customer what is delayed.

## WebhookPathBroken

**Means:** a payment was found by reading the provider, not by its webhook. **Ticket.**

No money is at risk: the payment was recorded. Find out why the webhook did not come: the URL registered at the provider, the secret, or our endpoint failing (see `ForgedWebhook`).

## ForgedWebhook

**Means:** a webhook's signature did not match. **Ticket.**

Most often it is ours: a rotated secret, or a proxy that changed the body. The signature covers the exact bytes, so anything that parses and re-serializes the body breaks it. If neither, someone is probing the endpoint.

## OutboxNotPublishing

**Means:** events are saved and not reaching the queue. **Ticket.**

The relay is stuck or the queue is down. Nothing is lost: events are in the database and are published when the relay runs again.

## A run needs a person

Not an alert yet: `where` shows `NEEDS A PERSON` with the reason. The run does not move by itself until it is cleared.

| Reason                           | What happened                                                                                     | What to do                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_outcome_unknown`        | We asked for the invoice, got no answer, and the provider has none with our reference             | Look again at the provider. Still none: clear the mark and let the invoice be created. Never create one while it may still appear |
| `duplicate_invoices_at_provider` | Two open invoices carry this run's reference. The provider does not deduplicate a repeated create | Cancel the extra one at the provider, then clear the mark                                                                         |
| `invoice_rejected`               | The provider refused the invoice                                                                  | Read the reason in the log, fix the run's data                                                                                    |
| `amount_mismatch`                | The client paid an amount other than the invoice                                                  | Decide with the client. Never accepted automatically                                                                              |
| `missing_at_provider`            | The provider no longer has our invoice                                                            | Ask the provider                                                                                                                  |

## An invoice was left open

Not an alert: the log line `run.invoice_left_open` names an invoice that is still payable for a run that was cancelled while the invoice was being created. Cancel it at the provider.

## A refund is due

Not an alert: `where` shows `REFUND DUE` after a funded run was cancelled. The provider's reference has no refund call, so a person sends the money back and records it.
