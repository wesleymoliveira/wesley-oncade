# Working with an AI agent: what I decided, and what the checks caught

This project was built with an AI coding agent (Claude Code). I gave the design, the rules and the decisions; the agent wrote most of the code. Two lists follow: where I changed what the agent proposed, and where a check caught the agent being wrong. The method is in the middle column of each.

## Where I changed the agent's proposal

| What the agent proposed                           | What I asked for                                                                                    | Why                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A custom status screen to show observability      | The tools teams already use: OpenTelemetry and Grafana                                              | A home-made screen proves nothing about operating a system                                                    |
| Verify the real API contract late, after building | First. Idempotency, lookup by reference and states decide the recovery design                       | A stand-in that agrees with a guess proves the guess, not the design                                          |
| "Retry on network errors and 5xx" for every call  | A call that creates a payment is sent once                                                          | It contradicted its own rule, "a timeout is not a failure". Without proven idempotency, a retry can pay twice |
| State per batch                                   | State per person too                                                                                | The reference shows a status per recipient. Resending a batch could pay some people twice                     |
| Reverse the ledger when a cancel is requested     | Only after the provider confirms, and the cancel can lose                                           | A request is not a fact                                                                                       |
| Operator-entered funding counts as funding        | It is simulated: its own cash account, a label everywhere, and only with the stand-in or a test key | "Never pay more than came in" depends on "came in" not being typed                                            |
| Validate the alert file and watch a metric move   | Evaluate the rules for real and read the alert's state                                              | A valid file and a moving number do not prove the alert fires                                                 |

## Where the agent was wrong, and what caught it

Each of these was caught by a check that exists for that purpose: a real call, a test, a drill, a look at the dashboard, a review by a second model, a review by specialist agents, a mirror test.

| Mistake                                                                                                                                                                                  | Caught by                                                                                  | What changed                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent assumed the business grant included invoice scopes                                                                                                                             | The first real call: `403 SCOPE_NOT_GRANTED`                                               | The probe runs before anything else                                                                                                                   |
| A tool that summarises web pages reported a "units discrepancy" in the reference that does not exist, and two summaries disagreed on `metadata` versus `externalMetadata`                | Reading the raw page text                                                                  | A claim about the API comes from raw text or a recorded reply, never from a summary                                                                   |
| Histograms in seconds had buckets meant for milliseconds: every p95 read "5 s"                                                                                                           | The dashboard screenshot. No test would have caught it                                     | Buckets in seconds                                                                                                                                    |
| A counter that is born at 1 shows no growth, so the first failure of each kind was invisible to its alert                                                                                | A drill that failed on the metric while the behaviour was right                            | Counters start at zero, and the zeros are sent before any work                                                                                        |
| A drill passed for the wrong reason: its alerts were still firing from the run before                                                                                                    | The check that an alert is `inactive` before and `firing` after                            | The alert windows in the demo are two minutes                                                                                                         |
| A label said "confirmed by Oncade" while the local stand-in was answering                                                                                                                | Reading the demo output before saving it as evidence                                       | "confirmed by the provider"                                                                                                                           |
| Three rules in `lib/core` were fully tested and never called by the code that moves money                                                                                                | A review of the whole session by a second model                                            | Two are now called, one was deleted with its test                                                                                                     |
| A cancel that arrived while an invoice was being created could leave that invoice open at the provider                                                                                   | The same review                                                                            | The invoice is cancelled when nobody is waiting for it                                                                                                |
| The stand-in assumed that a repeated `Idempotency-Key` returns the first reply. The real test API created a second draft invoice                                                         | The contract check against the real API, run twice                                         | The stand-in now creates a second object too, and a flow test checks that a whole run never repeats a create                                          |
| A cancel of a run funded by simulation booked the amount as owed back to the client, and left the unpaid invoice open at the provider                                                    | Preparing the run against the real API, with the rule "simulated is not received" in hand  | The simulation is undone instead, and the invoice is cancelled                                                                                        |
| The queue and the periodic check could both reach "create invoice" for one run. One of them then cancelled the invoice the other had just adopted, and the run ended cancelled           | Drill 2 (provider unreachable), rerun after a change                                       | The step now claims its work with one conditional write, like a batch, and a flow test runs three executions at once                                  |
| The stand-in's distributions were written from the documentation. The real replies differed in three places: the cancel reply, the code of a refused cancel, the text of the limit error | The contract check against the test API                                                    | The stand-in follows the recorded replies, and contract tests read them                                                                               |
| After a lost answer the code adopted the first distribution it found with the batch's reference. The test API showed that two can exist                                                  | The same check: a repeated key made a second distribution                                  | Two live ones park the batch for a person; a flow test covers it                                                                                      |
| The log line of a received webhook lost its own name: a field called `event` overwrote it, so an accepted delivery and a repeated one looked the same                                    | The first real deliveries, in the API's output                                             | The logger's type refuses a field with a reserved name                                                                                                |
| Two batches of one run that ended at the same moment left the run in `processing` for good. Each transaction read the other batch as still live. Every test ran one thing at a time      | The storage reviewer; then reproduced with two transactions held open                      | The progress check writes the run first, so the database refuses one of the two and the driver runs it again. A flow test holds two transactions open |
| A cancel delivered twice at the same moment undid a cancel that had worked. The second call got a `422`, which was already among the recorded replies, and the code read it as a refusal | The reviewer of the run steps. The new test fails on the old code three times out of three | After a refused cancel the object is read again: `cancelled` is success                                                                               |
| A funded run whose batches had all failed could not be cancelled, so the money could not be shown as owed back to the client                                                             | The reviewer of the money rules, and the mirror test                                       | Such a run can be cancelled while nobody is paid                                                                                                      |
| `.env.example`, copied as it was, left the token empty: every route answered `401`, and the demo that needs no credentials did not run                                                   | The configuration reviewer; then run                                                       | An empty line in `.env` counts as not set                                                                                                             |
| `POST /api/runs` answered `500` for amounts whose sum left the safe integers. The errors of the webhook route had no `code`. A cancel of a cancelled run answered `cancelling`           | The mirror test                                                                            | A limit on each amount, a code on every error, the true state in the answer. [`tests/flows/api.test.ts`](../tests/flows/api.test.ts) keeps them       |
| `npm run drill -- 7` wiped the local data, ran no drill and printed "All drills passed". `open-objects` printed "none" when the provider refused the read                                | The reviewer of the scripts                                                                | Arguments are checked before anything is wiped, and a read that fails says so                                                                         |

## The review by other agents, and the mirror test

On 2026-11-17, with the code done, I ran two checks that the agent that wrote the code could not run on itself.

**Nine reviewers.** A Claude Code plugin, cartographer, sent each part of the code to a specialist agent: the money rules, the client and the webhooks, storage, the queue and the worker, the steps of a run, the routes, the tests, the scripts, the configuration. Each read a copy of the repository without `.env`, wrote nothing but its report, and got the same brief: what the project is, the decisions I made on purpose, and one rule for a finding, which is a file, a line and a concrete failure.

- **134 findings:** 1 marked high, 39 medium, 94 low.
- **What led to a change** was checked against the code first, and the strongest were reproduced by running them. Five are in the table above. The others are smaller: one code for each kind of refusal in the API, script arguments, and limits that [design.md](design.md) now states.
- **The rest** were repeats between reviewers, matters of taste, or wrong.

**What the reviewers got wrong, or could not know:**

| Claim                                                                                      | What the code or the record says                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A person can be confirmed paid by another person's line, when an e-mail appears twice      | A payroll with a repeated e-mail is refused when the run is created                                  |
| The delivery id of the webhook to our customer is outside the signature                    | The id is inside the signed body                                                                     |
| A growing pause can pass the queue's limit when the receive limit is 16 or more            | The receive limit is a constant: 3                                                                   |
| A drill can end either way, because a held answer lasts as long as the client's timeout    | The drill holds the answer for 120 seconds, on purpose                                               |
| The one finding marked high: a cancelled distribution with a paid line frees a paid person | It needs a reply nobody has seen from the provider. I kept it as a three-line guard, not as a defect |
| The plugin's own summary: 42 duplicated functions                                          | Short names repeated in different files (`POST`, `sleep`, `create`). None was a duplicate            |

The reviewers had no search tool and ran nothing. Every finding was a reading, which is why none was accepted without a check.

**The mirror test.** I asked this service's own API the questions I had asked of Oncade: a repeated key, also six requests at the same moment; nineteen bad requests; unknown and odd paths; missing and wrong tokens; six bad signatures; calls in the wrong state; the money after a cancel. 70 checks on an isolated instance. It found five failures: the three of the row above, the funded run that could not be cancelled, and three cancels at the same moment, which got one `202` and two `409`. After the changes: 70 of 70.

The nine reports and the 70-check script are working files, and they are not in this repository. What they found is here: the rows above, and the tests those rows name.

## What worked as intended

- Next.js 16.4 writes a block into `AGENTS.md` when `next dev` runs under an AI agent, telling an agent that its training data is out of date and where the docs of this version are (`node_modules/next/dist/docs/`). That is the same idea as the rest of the file: a pointer, not a copy. I kept it.
- The lint rule that keeps `lib/core` free of I/O never fired. The split between rules and I/O held from the first file.

## The context experiment

One run, on 2026-11-16. The question: is what this repository gives an agent enough, and not too much, for a small real task?

**Setup.** A fresh agent with no history of this project, working on a copy of the repository without `.env`. The instruction was to read `AGENTS.md` first, stay inside the folder and not use the web. The task: _"the statement of one run as CSV, built from the ledger"_, with the rest left to what the repository says. The agent was not sealed off from the machine, so the list of files it opened is its own report. The result I checked myself: the diff, `npm run check` and the flow tests, run again in its copy.

**Result.** It worked. Three new files (86 lines): the rule in `lib/core`, a read in `lib/flows`, a thin route with the token check. Amounts in whole cents, ids only, simulated funding visible. 99 unit tests and 25 flow tests passed when I ran them, with `lib/core` still at 100%. It also found a trap I had not written down: ledger entry ids sort wrongly as text from the eleventh entry of a transaction.

It opened 19 project files before writing. Of the four context files it read three, and skipped the Oncade contract, which the task did not need. That is the pointer table working.

**What the context got wrong.** Its report listed twelve gaps. The ones I fixed, in `AGENTS.md`, `TESTING.md` and `domain.md`:

| Gap it reported                                                                                               | Fix                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The token rule was one code comment, not in `AGENTS.md`                                                       | Now a hard limit, with the function to call      |
| "Where things are" put telemetry in the wrong folder and left out `lib/http`                                  | Corrected                                        |
| `npm run check` was described without the format check, and it does not run the flow tests                    | The table now says so                            |
| "Dollars exist only in `lib/oncade/client.ts`" contradicted the code, and said nothing about files for people | The rule now names the two places dollars appear |
| The order of ledger entries was not documented                                                                | Written in `domain.md`, with the trap            |
| "Nothing personal" listed logs and metrics, not API answers or exports                                        | Added                                            |
| Read-only code was described as writing                                                                       | Corrected                                        |
| "No snapshot tests" and "one test of its failure" were ambiguous for a read                                   | Both now say what they mean                      |
| The test configuration named a folder that does not exist                                                     | Removed                                          |

One I did not fix: the block Next.js writes into `AGENTS.md` cost the agent about 700 lines of reading and changed nothing for this task. Next.js rewrites that block, so it stays.

**The budget held.** Those fixes pushed `AGENTS.md` four tokens over its limit and the check failed. Three phrases were cut; the limit stayed.

**Not merged.** The experiment was about the context, not about the feature.
