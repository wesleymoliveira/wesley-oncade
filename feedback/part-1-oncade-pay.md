# Part 1 feedback: using Oncade Pay

The Pay app at `pay.oncade.xyz`, in its Portuguese version, on Chrome on Linux, on 2026-11-16 and 2026-11-17. I am in Brazil, so my bank side is Pix. Docs as read at `pay.oncade.xyz/docs` on 2026-11-17.

## Where Part 1 stands

As of 2026-11-17:

| Step                            | State                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up, business, verification | Done                                                                                                                                                            |
| Link a bank account             | Done, with a Pix key                                                                                                                                            |
| Support ticket                  | Not filed. I could not find where to submit it: [item 2](#2-i-could-not-find-where-to-submit-a-support-ticket). I asked for the funds by direct message instead |
| Receive the $30                 | Waiting                                                                                                                                                         |
| Withdraw                        | Not done yet. [What I will check then](#to-check-when-the-funds-arrive) is at the end                                                                           |

**How to read an item.** Where it happened, what I did, what I expected, what happened, and a tag: broken, feels broken or confusing. Each item names its screenshots.

**Two sources.** Items 2, 6, 7 and 8 are from the steps of Part 1. The others are from Pay app screens I used on the way: the dashboard, "Add funds", and the pages where I paid the test invoice and the test payout of Part 2. They are about the app and not about the API, so they are here.

**The screenshots are in Portuguese.** Where an item quotes a screen, the English is my translation. My name, e-mail address, bank and Pix key are covered.

## Summary

12 items: 1 broken, 4 feels broken, 7 confusing.

| #   | Tag          | Item                                                                                                                                                          |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | broken       | [With test mode off, the dashboard still lists my test invoices and payouts](#1-with-test-mode-off-the-dashboard-still-lists-my-test-invoices-and-payouts)    |
| 2   | feels broken | [I could not find where to submit a support ticket](#2-i-could-not-find-where-to-submit-a-support-ticket)                                                     |
| 3   | feels broken | [The Pix deposit instructions show nothing to send the Pix to](#3-the-pix-deposit-instructions-show-nothing-to-send-the-pix-to)                               |
| 4   | feels broken | ["Do not close this window": a payout depends on my browser staying open](#4-do-not-close-this-window-a-payout-depends-on-my-browser-staying-open)            |
| 5   | feels broken | [A test invoice offers real bank transfers as ways to pay](#5-a-test-invoice-offers-real-bank-transfers-as-ways-to-pay)                                       |
| 6   | confusing    | [To receive money, my bank account goes under "Pay people"](#6-to-receive-money-my-bank-account-goes-under-pay-people)                                        |
| 7   | confusing    | ["Link a bank account" for Brazil asks for a Pix key](#7-link-a-bank-account-for-brazil-asks-for-a-pix-key)                                                   |
| 8   | confusing    | [A card says "Approved" and asks me to complete a verification](#8-a-card-says-approved-and-asks-me-to-complete-a-verification)                               |
| 9   | confusing    | [The Pix deposit screen labels the exchange rate as a fee](#9-the-pix-deposit-screen-labels-the-exchange-rate-as-a-fee)                                       |
| 10  | confusing    | [Cancelled payouts are listed under "Money sent"](#10-cancelled-payouts-are-listed-under-money-sent)                                                          |
| 11  | confusing    | ["Custody links expire in 7 days", and nothing says what happens to the money](#11-custody-links-expire-in-7-days-and-nothing-says-what-happens-to-the-money) |
| 12  | confusing    | [English and Portuguese are mixed on the same screen](#12-english-and-portuguese-are-mixed-on-the-same-screen)                                                |

## The four I would look at first

### 1. With test mode off, the dashboard still lists my test invoices and payouts

**Tag:** broken

- **Where:** the dashboard ("Painel"). The switch "Modo de teste" (test mode) is in the menu under my e-mail address, bottom left.
- **What I did:** for Part 2 I created invoices and payouts on the test API, with a test key. Then I opened the dashboard with test mode on, and again with test mode off.
- **What I expected:** with test mode off, the menu says "Mostrando dados reais" (showing real data). I have moved no real money on this account, so I expected two empty lists.
- **What happened:** the two lists are the same in both modes. "Faturas e transferências" (invoices and transfers) shows my test invoices, one of them as "Pago" (paid), $6.00. "Dinheiro enviado" (money sent) shows my test payouts, one of them as "Concluído" (completed), $6.00. Only the balance, the buttons beside it and a "Teste" badge change: $2.87 in test, $0.00 in real.
- **How I know they are test items:** they are the runs of Part 2. `REAL-2026-11-17-UPXT` is the paid run in [`docs/test-api-run.md`](../docs/test-api-run.md). The names say REAL because my code calls the Oncade test API "real", next to my local stand-in.
- **My reaction at the time:** "even with test mode off, the data does not change." I saw it on the morning of 2026-11-17, and again at night.
- **Why it matters:** the next thing I did was link my own bank account, and I had to stop and check which mode I was in. And a user who reads "paid, $6.00" above a balance of $0.00 will ask where the money went.
- **Screenshots:** [`part-1-01-dashboard-test-mode-on.png`](screenshots/part-1-01-dashboard-test-mode-on.png), [`part-1-02-dashboard-test-mode-off.png`](screenshots/part-1-02-dashboard-test-mode-off.png).

### 2. I could not find where to submit a support ticket

**Tag:** feels broken

- **Where:** the path in the exercise: Profile > Advanced > Submit a Support Ticket.
- **What I did:** looked for it in five places.
  1. The menu under my e-mail address. It has "Modo de teste" (test mode), "Pagando com" (paying with) and "Sair" (sign out).
  2. "Configurações → Perfil da empresa" (Settings → Business profile), to the end of the page, with the business details open. It has the address, the account, the business id, the integration goal and "leave this business".
  3. The business switcher, top left. It has "Selecionar negócio" (select a business) and "Criar negócio" (create a business).
  4. The rest of the side bar. After the settings come "Indicar uma empresa" (refer a business), "Documentação" (docs) and "Agende uma chamada com a equipe" (book a call with the team).
  5. The docs.
- **What I expected:** an entry called Profile, a section called Advanced inside it, and the ticket form.
- **What happened:** I found no profile other than the business profile, no "Advanced", and no ticket form.
- **What the docs say:** they mention a support ticket once, on the Visa Debit Card page: "The Support tab lets you send a support ticket or file a formal complaint". My side bar has no card entry and no Support tab. The FAQ says "contact support" three times and does not say how. The FAQ also says that Ask Oncade opens "from the button in the bottom right corner" of the dashboard. My dashboard shows no such button: see the two screenshots of item 1.
- **A guess I did not test:** the business profile says that the integration goal decides "which tools appear in the side bar". Mine is "I have a platform and want to build payments into my product". The ticket may belong to another goal.
- **My reaction at the time:** "I did not even find the place to open the ticket."
- **What I did meanwhile:** I asked for the funds by direct message.
- **Screenshots:** [`part-1-03-linked-accounts-empty-and-user-menu.png`](screenshots/part-1-03-linked-accounts-empty-and-user-menu.png), [`part-1-04-business-profile.png`](screenshots/part-1-04-business-profile.png), [`part-1-05-business-switcher.png`](screenshots/part-1-05-business-switcher.png), [`part-1-06-docs-landing-page.png`](screenshots/part-1-06-docs-landing-page.png).

### 3. The Pix deposit instructions show nothing to send the Pix to

**Tag:** feels broken

- **Where:** "Receber → Adicionar fundos" (Receive → Add funds), bank transfer, "PIX (Brasil)", then "Obter instruções de depósito" (get deposit instructions).
- **What I did:** asked for the instructions to deposit 175 BRL by Pix. I did not send the money.
- **What I expected:** a Pix key, a QR code, a "copia e cola" (copy and paste) code, or a branch and an account number. A Pix needs one of them.
- **What happened:** the instructions give the name of the beneficiary ("Oncade Inc."), the name of the bank and the exact amount. Then step 2 says "send a transfer to the account details above". There are no account details above.
- **Screenshot:** [`part-1-12-pix-deposit-instructions.png`](screenshots/part-1-12-pix-deposit-instructions.png).

### 4. "Do not close this window": a payout depends on my browser staying open

**Tag:** feels broken

- **Where:** a pending payment, "Confirmar pagamento" (confirm the payment), then "Confirmar e enviar" (confirm and send).
- **What I did:** confirmed a test payout to three people. It was one of the two test runs I paid for Part 2.
- **What I expected:** to be able to close the tab once I had confirmed.
- **What happened:** a red box: "Não feche esta janela. Sua transação está sendo processada. Fechar o navegador pode causar falha nas transferências." In English: do not close this window, your transaction is being processed, closing the browser may make the transfers fail. Under it: "Criando registros de transferência…" (creating transfer records).
- **Why it matters:** with 20 recipients, or a weak connection, what is the state if the tab closes halfway? Some people paid and some not? I did not try it.
- **Screenshot:** [`part-1-14-payout-do-not-close.png`](screenshots/part-1-14-payout-do-not-close.png).

## The rest

### 5. A test invoice offers real bank transfers as ways to pay

**Tag:** feels broken

- **Where:** the hosted page of a test invoice, "Pagar agora" (pay now), then "Selecione a forma de pagamento" (select the payment method).
- **What I did:** opened the ways to pay an invoice that the page itself labels "Fatura de teste" (test invoice).
- **What I expected:** only test ways to pay.
- **What happened:** ACH, Fedwire, SEPA and PIX are listed, above "Saldo Oncade" (Oncade balance). I did not choose one, so I do not know whether it would have given me real transfer instructions.
- **Why it matters:** someone rehearsing in test could send real money without meaning to. [Item 4 of the Part 2 note](part-2-platform-api.md#4-in-test-money-comes-from-a-public-faucet-and-nothing-says-so) is the same doubt on "Add funds".
- **Screenshots:** [`part-1-15-test-invoice-hosted-page.png`](screenshots/part-1-15-test-invoice-hosted-page.png), [`part-1-16-test-invoice-payment-methods.png`](screenshots/part-1-16-test-invoice-payment-methods.png).

### 6. To receive money, my bank account goes under "Pay people"

**Tag:** confusing

- **Where:** the side bar. "Receber → Contas de recebimento" (Receive → Receiving accounts) and "Pagar pessoas → Contas bancárias vinculadas" (Pay people → Linked bank accounts).
- **What I did:** I wanted to link my bank, to receive the $30 and withdraw it. I opened "Receber → Contas de recebimento".
- **What I expected:** my bank account to go under "Receber", because I want to receive.
- **What happened:** that page lists two active accounts, USD and PIX-BR, and a button to add a receiving account. Its text says they receive "revenue from sales platforms" and invoice payments. It is not the place. My bank account goes under "Pagar pessoas", next to "Sacar" (withdraw). A withdrawal to my own bank is not paying people.
- **My reaction at the time:** "is it really under Pay? I want to receive."
- **Screenshot:** [`part-1-07-receiving-accounts.png`](screenshots/part-1-07-receiving-accounts.png).

### 7. "Link a bank account" for Brazil asks for a Pix key

**Tag:** confusing

- **Where:** "Pagar pessoas → Contas bancárias vinculadas", then "Vincular uma conta bancária" (link a bank account).
- **What I did:** chose Brazil under "Onde fica seu banco?" (where is your bank?).
- **What I expected:** to enter a bank, a branch and an account number.
- **What happened:** the only option is "Transferência bancária (PIX)". The form asks for the name of the bank as free text, a Pix key or a BR Code, a CPF or CNPJ, and the name of the holder. Pix is the transfer system and not an account: the key points to one. The Funding page of the docs explains it ("the bank account is identified by a Pix key"). The form does not.
- **My reaction at the time:** "Brazil only has Pix to choose, but Pix is a way to pay, not a bank account, right?"
- **Screenshot:** [`part-1-08-link-bank-account-form.png`](screenshots/part-1-08-link-bank-account-form.png).

### 8. A card says "Approved" and asks me to complete a verification

**Tag:** confusing

- **Where:** "Pagar pessoas → Contas bancárias vinculadas", the card "Pagamentos locais PIX" (local PIX payments).
- **What I did:** opened the page to link my account, before I had one.
- **What I expected:** to see whether I already had a Pix account ready or not.
- **What happened:** the top of the page says "Nenhuma conta bancária vinculada ainda" (no linked bank account yet). Under it, the card has a green badge "Aprovado" (approved), and its text says "Ative transferências PIX diretas concluindo a verificação regional desta empresa": activate direct PIX transfers by completing the regional verification of this business. The badge says it is done, and the text asks me to do it. I read the badge as "my Pix account is approved", and "Sacar" had no account to send to. After I linked the account, the card stayed the same.
- **My reaction at the time:** "it does not let me withdraw because I have no linked account, but it shows the Pix account as approved."
- **Screenshots:** [`part-1-03-linked-accounts-empty-and-user-menu.png`](screenshots/part-1-03-linked-accounts-empty-and-user-menu.png), [`part-1-09-bank-account-linked.png`](screenshots/part-1-09-bank-account-linked.png).

### 9. The Pix deposit screen labels the exchange rate as a fee

**Tag:** confusing

- **Where:** "Receber → Adicionar fundos", bank transfer, "PIX (Brasil)", under the amount field.
- **What I did:** typed 175 BRL.
- **What I expected:** the exchange rate and the fee, each with its own label. The FAQ says the Add funds page "shows rates and any fees before you send".
- **What happened:** one line: "Taxa: $1.00 ≈ 5.81 BRL · Mínimo 11.62 BRL". In Portuguese, "taxa" alone reads as "fee", so the line reads as a fee of one dollar. The numbers show that it is the exchange rate: 175 ÷ 5.81 ≈ 30.12. "Câmbio" or "cotação" would say it.
- **Two small things on the same screens:** the estimate is "$30.13 USD" on this screen and "$30.14" on the next one. The amount is written "175.0 BRL"; in Brazil it would be "R$ 175,00".
- **Screenshots:** [`part-1-11-pix-deposit-amount.png`](screenshots/part-1-11-pix-deposit-amount.png), [`part-1-12-pix-deposit-instructions.png`](screenshots/part-1-12-pix-deposit-instructions.png).

### 10. Cancelled payouts are listed under "Money sent"

**Tag:** confusing

- **Where:** the dashboard, the list "Dinheiro enviado" (money sent).
- **What I did:** created payouts through the API and cancelled them before any payment.
- **What I expected:** nothing under "money sent" for them, since nothing was sent.
- **What happened:** each cancelled payout is listed there with its amount, $6.00, and the status "Cancelado".
- **Screenshot:** [`part-1-01-dashboard-test-mode-on.png`](screenshots/part-1-01-dashboard-test-mode-on.png).

### 11. "Custody links expire in 7 days", and nothing says what happens to the money

**Tag:** confusing

- **Where:** the window "Confirmar pagamento", before I confirm a payout.
- **What I did:** read the notice about recipients with no Oncade account.
- **What I expected:** one more sentence: what happens to the money when a link expires.
- **What happened:** the notice says that those recipients get an e-mail with a link to create an account and claim their funds, and that "os links de custódia expiram em 7 dias" (custody links expire in 7 days). It stops there. The Payouts page and the FAQ describe the claim link, and mention neither the seven days nor what comes after them.
- **Screenshot:** [`part-1-13-payout-confirm.png`](screenshots/part-1-13-payout-confirm.png).

### 12. English and Portuguese are mixed on the same screen

**Tag:** confusing

- **Where:** several screens of the Portuguese version.
- **What I expected:** every line in Portuguese.
- **What happened:**
  - the dashboard rows say "Invoice INV-… cancelled" and "Payment … completed", next to the status in Portuguese, "Cancelado" and "Concluído" ([`part-1-01-dashboard-test-mode-on.png`](screenshots/part-1-01-dashboard-test-mode-on.png));
  - "Business account" under "Pagando com", and again in the payment window ([`part-1-13-payout-confirm.png`](screenshots/part-1-13-payout-confirm.png));
  - the linked account is "Brazil (PIX)" in the list and on the withdraw page, and the form that created it says "Brasil" ([`part-1-09-bank-account-linked.png`](screenshots/part-1-09-bank-account-linked.png), [`part-1-08-link-bank-account-form.png`](screenshots/part-1-08-link-bank-account-form.png));
  - the business profile writes dates as "Nov 16, 2026", and the dashboard as "17 de nov." ([`part-1-04-business-profile.png`](screenshots/part-1-04-business-profile.png));
  - the receipt of a payout has a "Completed" badge and the date "Nov 17, 2026, 11:40 AM", beside "Pagamento enviado" ([`part-1-17-payout-receipt.png`](screenshots/part-1-17-payout-receipt.png));
  - the docs have the title and the cards in Portuguese and the whole side menu in English ([`part-1-06-docs-landing-page.png`](screenshots/part-1-06-docs-landing-page.png)).
- **One more, about words and not language:** on the withdraw page, the empty "Histórico de transferências" (transfer history) says "Nenhum pagamento disponível" (no payment available) ([`part-1-10-withdraw-zero-balance.png`](screenshots/part-1-10-withdraw-zero-balance.png)).

## What worked well

- **The form to link a Pix account.** It is in Portuguese, it names the four kinds of key (e-mail, phone, CPF, random key) and the BR Code, it shows the format of the CPF or CNPJ with an example, and it fills in the name of the holder. The account was linked ([`part-1-08-link-bank-account-form.png`](screenshots/part-1-08-link-bank-account-form.png), [`part-1-09-bank-account-linked.png`](screenshots/part-1-09-bank-account-linked.png)).
- **The withdraw page.** My linked account is already selected, with the key masked. I type the amount I want to receive, in reais. The page shows an estimate of the dollars that will leave, and says "Você aprova o valor exato antes de qualquer envio": you approve the exact amount before anything is sent ([`part-1-10-withdraw-zero-balance.png`](screenshots/part-1-10-withdraw-zero-balance.png)).
- **The payout confirmation.** It says who receives money directly and who receives a claim link, and it shows the wallet with its network and a "Teste" badge ([`part-1-13-payout-confirm.png`](screenshots/part-1-13-payout-confirm.png)). The receipt then counts direct transfers, gift links and claimed ones, and links to the transaction ([`part-1-17-payout-receipt.png`](screenshots/part-1-17-payout-receipt.png)).
- **The hosted invoice says that it is a test.** A badge "Fatura de teste" sits beside its status ([`part-1-15-test-invoice-hosted-page.png`](screenshots/part-1-15-test-invoice-hosted-page.png)).
- **The "Teste" badge** beside my e-mail address when test mode is on ([`part-1-01-dashboard-test-mode-on.png`](screenshots/part-1-01-dashboard-test-mode-on.png)).

## To check when the funds arrive

With a balance of $0.00 the withdraw page shows no fee and no rate, so these are still open:

- how I learn that the $30 arrived: an e-mail, or only by looking;
- the fee and the exchange rate, and whether I see both before I confirm;
- the time promised on the screen, and the real time. The docs say "usually 0–3 business days";
- the amount that reaches my bank, in reais.
