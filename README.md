# Mihenk AI: pay per call on NEAR

AI agents buy measured crypto-influencer (KOL) data one call at a time and pay for it in USDC on NEAR. There is no account and no API key. The API answers `402 Payment Required`, the agent pays with a NEP-141 `ft_transfer` on NEAR, and the data comes back with a receipt.

Built at **NEAR HACKATHON (1–14 November 2026)** for the **Agent Economy**, **AI Security & Defense**, **Unstoppable DeFi** and **Open Innovation** tracks. Demo video: [demo/mihenk-near-pay-per-call.mp4](demo/mihenk-near-pay-per-call.mp4)

It runs on NEAR testnet with test USDC and on NEAR mainnet with Circle's native USDC: [try it live](#try-it-live), or see [a real paid call on mainnet](#on-near-mainnet). The agent can then act on the data it paid for with a small, capped swap through NEAR Intents: see [one-tap trade](#one-tap-trade-through-near-intents).

## Try it live

The API runs at two public addresses through at least 25 November 2026:

| Network | Address | Payment |
|---|---|---|
| NEAR mainnet | https://app.mihenkai.com/near | Circle's native USDC on NEAR, paid to `mihenkai.near` |
| NEAR testnet | https://app.mihenkai.com/near-testnet | test USDC (`usdc.fakes.testnet`) |

See the 402 without installing anything:

```bash
curl -i "https://app.mihenkai.com/near/v1/coin/NEAR/calls?hours=24"
# HTTP/2 402 with "network": "near-mainnet", "maxAmountRequired": "10000" (0.01 USDC), "payTo": "mihenkai.near"
# and a one-time "memo": "mihenk-x402:<nonce>" that the payment must carry
```

Run the buyer agent against the hosted testnet API, with free test USDC and no server to start:

```bash
npm install
npm run setup   # your own agent and seller on testnet, 5 test USDC for the agent
TRUSTED_SELLERS=mihenk-seller-mwd7gisu9305.testnet node agent.mjs NEAR --budget 0.02 --api https://app.mihenkai.com/near-testnet
```

You should see `402 Payment Required: 0.01 test USDC to mihenk-seller-mwd7gisu9305.testnet`, then `paid on near-testnet: https://testnet.nearblocks.io/txns/…` and `bought $NEAR calls, last 24h; check passed`. `TRUSTED_SELLERS` adds the hosted seller to the agent's allow-list; without it the agent refuses to pay, which is the allow-list doing its job. A run against the hosted API on 14 November 2026, 22:29 UTC: [2ttpPRZj…](https://testnet.nearblocks.io/txns/2ttpPRZj3rc4ppaCoh4skCu1MeFpV7BcHe1WNvBpWkSH).

The one-tap trade (`trade.mjs`) moves the agent's own funds, so it is not a public endpoint; the recorded mainnet swap is [below](#one-tap-trade-through-near-intents). With your own funded mainnet agent (`SELLER=mihenkai.near npm run setup:mainnet`), `NEAR_ENV=mainnet node agent.mjs NEAR --api https://app.mihenkai.com/near` buys a call for 0.01 USDC, and `NEAR_ENV=mainnet node trade.mjs NEAR --usdc 0.5` then shows the decision and a live NEAR Intents quote without sending anything.

## Why

When a crypto influencer calls a coin, traders and trading agents act on it within minutes. Before an agent follows, it needs two answers: who else called this coin, and what happened after their earlier calls. [Mihenk AI](https://mihenkai.com) already measures that for 15,800+ KOLs on X, Telegram and YouTube. This project lets an agent with its own NEAR wallet buy the answer for one cent per call, with nothing to sign up for.

## How it works

```
agent (own NEAR account)                API (server.mjs)                          NEAR
  | GET /v1/coin/NEAR/calls?hours=24        |                                          |
  |---------------------------------------->|                                          |
  | 402 {price, token, payTo, nonce}        |                                          |
  |<----------------------------------------|                                          |
  | ft_transfer(payTo, price, memo "mihenk-x402:<nonce>") on the USDC contract          |
  |------------------------------------------------------------------------------------>|
  | GET again, X-PAYMENT: {tx_hash, sender_id, nonce}                                   |
  |---------------------------------------->| RPC tx(tx_hash, sender_id, wait FINAL)   |
  |                                         |----------------------------------------->|
  |                                         | success? memo = nonce? amount >= price?  |
  |                                         | token contract logged the transfer?      |
  | 200 data + X-PAYMENT-RESPONSE receipt   |                                          |
  |<----------------------------------------|                                          |
```

Before it answers, the server reads the transaction from NEAR RPC and checks that:

- the transaction succeeded and none of its receipts failed;
- it was signed by the account named in `X-PAYMENT` and calls `ft_transfer` on the expected token contract;
- the transfer goes to the seller, for at least the quoted price, with the memo `mihenk-x402:<nonce>` the server issued for this exact request;
- the token contract itself logged the transfer (a NEP-141 event, or the `Transfer … / Memo …` log lines older NEP-141 contracts such as `usdc.fakes.testnet` write);
- the transfer was made after that nonce was issued, and its transaction hash was never used before.

The nonce and the transaction hash are reserved before the server waits on RPC, so two parallel requests can't share one payment. The messages follow x402 v1 (`accepts`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`, scheme `exact`); on NEAR this repo uses a pay-then-prove variant without a facilitator: the agent submits the transfer itself and the server verifies it on-chain.

The 402 is a quote that lasts 5 minutes (`maxTimeoutSeconds: 300`); in our test runs the agent's transfer landed 10–18 seconds after the 402. If a transfer that carries an issued nonce lands after the quote has expired, the server still serves the data at the quoted price, for up to 24 hours, so an agent that paid never ends up with nothing. Issued nonces are kept in `data/nonces.json`, so this also holds after a restart, and each nonce and transaction hash still buys exactly one call.

## What the agent does

`agent.mjs` is a small buyer with its own NEAR account and a spending budget:

- it reads the price from the 402 and pays only if the price fits its remaining budget;
- if the 24-hour window costs more than it has left, it asks once for the cheaper 6-hour window the server offers, and walks away if that is still too much;
- it pays only sellers and tokens it trusts (the seller in its `config.json`, plus any in `TRUSTED_SELLERS`), whatever a 402 response asks for;
- after each purchase it checks what it received (right coin, consistent counts) and appends a receipt to `receipts.jsonl`: what it bought, from whom, the price, the NEAR transaction and whether the delivery passed its check. Data that passed the check is saved to `data/bought-<COIN>.json`, where `trade.mjs` can act on it.

Prices: 0.005 USDC for up to 6 hours of calls, 0.01 for up to 24 hours, 0.03 for up to 7 days (test USDC on testnet).

## Guardrails

An agent that holds money needs limits it can't talk itself out of, and a seller needs payments that can't be faked or reused. Both are enforced in code, not in a prompt.

The agent (`agent.mjs`, `trade.mjs`):

- **Budget:** it pays only if the quoted price fits what is left of its budget; over budget, it asks once for the narrower, cheaper request the server offers, then stops.
- **Allow-list:** it pays only the seller and token in its own config, so a spoofed or malicious 402 can't send its money elsewhere.
- **Delivery check and receipts:** it checks what it received and keeps a receipt with the NEAR transaction for every purchase.
- **Capped trades:** `trade.mjs` acts only on data the agent paid for on the same network in the last 6 hours, never on a tip; each swap is capped (`MAX_TRADE_USDC`, 1 USDC by default), a refund goes back to the agent's own account, and nothing is sent without `--execute`.

The seller (`server.mjs`):

- **One payment, one call:** each 402 carries a one-time nonce bound to that exact request, and the transfer must carry it in its memo. The nonce and the transaction hash are reserved before any network wait and burned after use, so a payment can't be replayed or shared by parallel requests.
- **Proof from the chain, not from the client:** the server reads the finalized transaction and the token contract's own log. Underpaid, failed, wrong-token, wrong-recipient and earlier transfers are refused (`npm test` checks the replay and underpayment cases).
- **Fair to the payer:** a late payment for an issued nonce is still served, for up to 24 hours.

The data is a reputation check in itself: for each call the agent sees who made it and how the price moved after it, measured from market data rather than claimed.

## Run it

Requires Node 22.13 or newer. The steps below run on NEAR testnet and need no real funds; for real USDC, see [On NEAR mainnet](#on-near-mainnet).

```bash
npm install
npm run setup     # creates a seller and an agent account through the public testnet faucet,
                  # registers both on usdc.fakes.testnet and mints 5 test USDC to the agent
npm run server &  # API on http://127.0.0.1:8403
node agent.mjs NEAR SOL --budget 0.05
```

You should see, for each coin: `402 Payment Required: 0.01 test USDC`, then `paid on near-testnet: https://testnet.nearblocks.io/txns/…`, then a receipt and `bought $NEAR calls, last 24h; check passed`. Open the nearblocks link to see the transfer and its memo.

```bash
node agent.mjs ETH --budget 0.007   # 24h costs 0.01: the agent asks for the 6h window and pays 0.005
node agent.mjs BTC --budget 0.003   # still above budget: the agent does not pay
npm test                            # PASS: one payment buys exactly one call; underpayment is refused
cat receipts.jsonl                  # the agent's record of what it bought
```

To also check a late payment, restart the server with a short quote and run the tests again:

```bash
QUOTE_SECONDS=5 npm run server &
npm test   # ... the agent pays 7 seconds after a 5-second quote and still gets the data; the same payment again is refused
```

Without Mihenk's database the server answers from `data/sample.json`, a snapshot of the last 24 hours of Mihenk data for NEAR, SOL, BTC and ETH taken on 12 November 2026 (07:25 UTC); a 6-hour request returns that same 24-hour snapshot. With `MIHENK_DB` pointing to Mihenk's SQLite dataset it answers with live data. Keys and account names are written to `keys/` (`keys-mainnet/` on mainnet), both git-ignored.

## Example run

Recorded on 12 November 2026, 07:25–07:28 UTC, on NEAR testnet, with the server on Mihenk's live dataset (times in the logs are UTC). Price moves come from the feed each call is tagged with, shown in brackets. The transaction links are public.

The agent buys two calls:

```
[agent 07:25:51] wallet mihenk-agent-mwd7gnh65379.testnet holds 4.934 test USDC; budget 0.05
[agent 07:25:51] GET http://localhost:8403/v1/coin/NEAR/calls?hours=24
[agent 07:25:51] 402 Payment Required: 0.01 test USDC to mihenk-seller-mwd7gisu9305.testnet
[agent 07:26:02] paid on near-testnet: https://testnet.nearblocks.io/txns/DM7oT8YD7rifT7qjUsT9egfd5tcZg2MvL4w1Ekd71T86
[agent 07:26:09] receipt: {"success":true,"transaction":"DM7oT8YD7rifT7qjUsT9egfd5tcZg2MvL4w1Ekd71T86","network":"near-testnet","payer":"mihenk-agent-mwd7gnh65379.testnet"}
[agent 07:26:09] bought $NEAR calls, last 24h; check passed
[agent 07:26:09]   9 calls from 9 KOLs (7 long, 2 short)
[agent 07:26:09]   @KazTheShadow (17,432 followers) long at 2026-11-11T19:24:00Z -> 5m +0.4%, 1h -0.3% (Binance)
[agent 07:26:09]   @CryptoMichNL (822,607 followers) long at 2026-11-11T18:47:00Z -> 5m -0.8% (Binance)
[agent 07:26:09] GET http://localhost:8403/v1/coin/SOL/calls?hours=24
[agent 07:26:09] 402 Payment Required: 0.01 test USDC to mihenk-seller-mwd7gisu9305.testnet
[agent 07:26:26] paid on near-testnet: https://testnet.nearblocks.io/txns/3h7FWTqqXpoVfxNhao7DJE5jDDJcxUV2kR3L2hg5YhDY
[agent 07:26:33] bought $SOL calls, last 24h; check passed
[agent 07:26:33]   33 calls from 32 KOLs (30 long, 3 short)
[agent 07:26:36] done; remaining budget 0.03 test USDC, wallet 4.914; receipts in receipts.jsonl
```

Over budget, it narrows the request once, then refuses:

```
[agent 07:26:40] 402 Payment Required: 0.01 test USDC to mihenk-seller-mwd7gisu9305.testnet
[agent 07:26:40] over my remaining budget (0.007); asking for the narrower 6h window instead
[agent 07:26:40] 402 Payment Required: 0.005 test USDC for the 6h window
[agent 07:26:51] paid on near-testnet: https://testnet.nearblocks.io/txns/J4w9BDHjxm1BJkhoAyEpp67aLN4vgrhkT6LB2rJUJf73
[agent 07:26:57] bought $ETH calls, last 6h; check passed

[agent 07:27:04] 402 Payment Required: 0.01 test USDC to mihenk-seller-mwd7gisu9305.testnet
[agent 07:27:04] price is above my remaining budget (0.003), not paying
```

A reused or underpaid payment is refused, and a late payment is still served (server started with `QUOTE_SECONDS=5`; recorded on 13 November 2026, 17:39–17:40 UTC):

```
[test] paid once: H76fbkokrauazE4rXtxSYFyxt1GGR5YJRcn82u4P1yCV
[test] first call with the payment  -> 200
[test] same payment, new request    -> 402 payment already used
[test] same payment, made-up nonce  -> 402 unknown nonce
[test] underpaid transfer (1/10)    -> 402 paid 1000 units, 10000 required
[test] paid 7s after a 5s quote -> 200
[test] same late payment again       -> 402 unknown nonce
[test] PASS: one payment buys exactly one call; underpayment is refused; a late payment is still served
```

## On NEAR mainnet

With `NEAR_ENV=mainnet` the same code runs on NEAR mainnet and takes Circle's native USDC on NEAR (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals). Payments go to the seller account you name; it only receives, so its key never touches the server. The agent is a NEAR implicit account whose key stays on the machine that runs it.

```bash
SELLER=<your account>.near npm run setup:mainnet   # 1st run: creates the agent account; send it ~0.3 NEAR and some USDC on NEAR
SELLER=<your account>.near npm run setup:mainnet   # 2nd run: registers the agent and the seller on the USDC contract
npm run server:mainnet &                           # API on http://127.0.0.1:8404, paid in USDC
npm run agent:mainnet                              # buys 24h of $NEAR calls for 0.01 USDC, budget 0.02
```

Recorded on 14 November 2026, 21:08–21:09 UTC, on NEAR mainnet, with the server on Mihenk's live dataset (times in the logs are UTC). The payment is a real 0.01 USDC transfer to `mihenkai.near`, the team's account; the transaction link is public.

```
[agent 21:08:49] wallet f90585d5069f3fe6d2c228866f6caf9843e596149b4c56bf219fdbbe44427bcf holds 2.943 USDC on near-mainnet; budget 0.02
[agent 21:08:49] GET http://localhost:8404/v1/coin/NEAR/calls?hours=24
[agent 21:08:49] 402 Payment Required: 0.01 USDC to mihenkai.near
[agent 21:09:00] paid on near-mainnet: https://nearblocks.io/txns/9EhcArnaa5CAhxmcfVZm42hPGHG4Uos45msjYa729Nmn
[agent 21:09:06] receipt: {"success":true,"transaction":"9EhcArnaa5CAhxmcfVZm42hPGHG4Uos45msjYa729Nmn","network":"near-mainnet","payer":"f90585d5069f3fe6d2c228866f6caf9843e596149b4c56bf219fdbbe44427bcf"}
[agent 21:09:06] bought $NEAR calls, last 24h; check passed
[agent 21:09:06]   5 calls from 5 KOLs (3 long, 2 short)
[agent 21:09:06]   @LSDinmycoffee (151,580 followers) short at 2026-11-14T16:38:00Z -> 5m +0.3%, 1h +0.6% (Binance)
[agent 21:09:06]   @CryptoTony__ (568,724 followers) short at 2026-11-14T13:56:00Z -> 5m -1.7%, 1h -2.7% (Binance)
[agent 21:09:06]   @Waleedahmed234 (19,402 followers) long at 2026-11-14T10:31:00Z -> 5m 0%, 1h +0.1% (Binance)
[agent 21:09:06]   @CryptoMillionYT (68,215 followers) long at 2026-11-14T07:10:00Z -> 5m -0.5%, 1h -0.1% (Binance)
[agent 21:09:06]   @watchingmarkets (59,257 followers) long at 2026-11-13T23:58:00Z -> 5m +0.8%, 1h +0.1% (Binance)
[agent 21:09:09] done; remaining budget 0.01 USDC, wallet 2.933; receipts in receipts.jsonl
```

The server's side of the same call:

```
21:08:41 listening on 127.0.0.1:8404 (Mihenk AI measured dataset); token 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1; payTo mihenkai.near; quote 300s
21:08:49 402 /v1/coin/NEAR/calls 24h price 0.01
21:09:06 200 paid 0.01 by f90585d5069f3fe6d2c228866f6caf9843e596149b4c56bf219fdbbe44427bcf https://nearblocks.io/txns/9EhcArnaa5CAhxmcfVZm42hPGHG4Uos45msjYa729Nmn
```

The agent's USDC came from its own NEAR: before the run, 1 NEAR was swapped for 2.943 USDC on NEAR through the same NEAR Intents 1Click API.

## One-tap trade through NEAR Intents

Mihenk's social trading lets a person act on a KOL call with one tap from their own wallet. `trade.mjs` gives the agent the same step on NEAR mainnet:

1. it reads the calls it paid for (`data/bought-<COIN>.json`, written by `agent.mjs`), and only if they were bought on the same network within the last 6 hours;
2. it trades only if most measured KOLs called the coin long; otherwise it stops;
3. it asks the NEAR Intents [1Click API](https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api) for a quote: USDC on NEAR to NEAR, delivered to the agent's own account (SOL, ETH and BTC are delivered on their own chains with `--to <address>`);
4. with `--execute`, it sends the USDC to the quote's deposit address, NEAR Intents solvers deliver the coin, and the result is logged to `trades.jsonl`.

```bash
NEAR_ENV=mainnet node trade.mjs NEAR --usdc 0.5             # decision and quote only; nothing is sent
NEAR_ENV=mainnet node trade.mjs NEAR --usdc 0.5 --execute   # sends 0.5 USDC (capped by MAX_TRADE_USDC, 1 by default)
```

Recorded on 14 November 2026, 21:13–21:15 UTC, on NEAR mainnet, using the data the agent bought in the paid call above (the script prints the three latest of the five calls; all five are in the agent's log above):

```
[trade 21:13:52] paid data: $NEAR calls, last 24h, bought 2026-11-14T21:09:06.555Z: 5 calls from 5 KOLs (3 long, 2 short)
[trade 21:13:52]   @LSDinmycoffee short at 2026-11-14T16:38:00Z
[trade 21:13:52]   @CryptoTony__ short at 2026-11-14T13:56:00Z
[trade 21:13:52]   @Waleedahmed234 long at 2026-11-14T10:31:00Z
[trade 21:13:52] most measured KOLs are long: buying $NEAR with 0.5 USDC through NEAR Intents
[trade 21:13:53] quote: 0.5 USDC -> 0.170123 NEAR on NEAR (about $0.50), to f90585d5069f3fe6d2c228866f6caf9843e596149b4c56bf219fdbbe44427bcf
[trade 21:14:34] sent 0.5 USDC to the NEAR Intents deposit address: https://nearblocks.io/txns/8sAhvMfJhKEcBCQNMmKFS5Moe45Kjbztaad2ppU9nQvf
[trade 21:14:40] status: PENDING_DEPOSIT
[trade 21:14:58] status: PROCESSING
[trade 21:15:23] status: SUCCESS
[trade 21:15:23] done: 0.170751 NEAR delivered to f90585d5069f3fe6d2c228866f6caf9843e596149b4c56bf219fdbbe44427bcf
[trade 21:15:26] agent wallet now holds 2.433 USDC
```

The NEAR arrived in the agent's own account from `intents.near` 39 seconds after the deposit (block times 21:14:33 and 21:15:12 UTC; [delivery](https://nearblocks.io/txns/GsihQuwGMqHpVerR9J52ycG5GPuSgXQsqRm1FSznudL3)); the 1Click status API reported `SUCCESS` at the agent's next check.

This shows an agent acting on measured data inside hard limits; it is not a trading strategy.

## Files

| File | What it does |
|---|---|
| `server.mjs` | The pay-per-call API: 402 with payment requirements, verification on NEAR RPC, data with a receipt |
| `agent.mjs` | Buyer agent: budget, trusted sellers, one narrower request when over budget, pays with `ft_transfer`, keeps receipts and the data it bought |
| `trade.mjs` | Acts on the data the agent paid for: a capped swap through the NEAR Intents 1Click API (mainnet) |
| `setup.mjs` | Testnet: accounts from the faucet, storage registration and test USDC for the agent. Mainnet: the agent account and USDC registration |
| `test.mjs` | Payment checks: one payment buys exactly one call; underpayment is refused; a late payment is still served |
| `lib.mjs` | Shared config, network switch (testnet or mainnet), NEAR connection, RPC and prices |
| `data.mjs` | Read-only access to Mihenk's measured KOL calls, or the offline sample |
| `mksample.mjs` | Maintainer script that writes `data/sample.json` from Mihenk's dataset |

## NEAR's role

NEAR is the payment and identity layer: the agent and the seller are NEAR accounts, each call is paid with a NEP-141 `ft_transfer` whose memo binds the payment to one request, and the server proves the payment by reading the finalized transaction and the token contract's own logs from NEAR RPC. Human-readable accounts make receipts easy to audit, and because `ft_transfer` requires a 1 yoctoNEAR deposit, a payment can only be signed with the account's full-access key. On mainnet, NEAR Intents lets the same agent turn what it bought into a swap: it sends USDC to a deposit address and solvers deliver the coin, on NEAR or on another chain.

## Hackathon tracks

- **Agent Economy:** an agent with its own NEAR account buys data per call, with no sign-up and no API key, and keeps receipts.
- **AI Security & Defense:** the [guardrails](#guardrails): the agent's budget, seller allow-list, delivery check and trade cap, and payments bound to one request that the server proves on-chain.
- **Open Innovation:** an x402-style 402 handshake on NEAR without a facilitator, selling measured influencer data to agents.
- **Unstoppable DeFi:** the agent turns the data it paid for into a capped swap through NEAR Intents on mainnet, from its own account and with no exchange account (recorded [above](#one-tap-trade-through-near-intents)).

## What's next

- Agents paying from any chain they hold funds on, through NEAR Intents.
- NEAR as a payment option in Mihenk's live x402 Agent API, which already takes USDC on Base, Arc and Polygon.

## How this was built

All code in this repository was written inside the hackathon window: `data.mjs` comes from our Solana prototype of 8 November 2026, and everything else was written on 12 November 2026; the late-payment handling was added on 13 November 2026, and mainnet support with native USDC, the saved purchases and `trade.mjs` (NEAR Intents) on 14 November 2026, when the hosted demo also went live. The 402 handshake follows the design of our earlier Solana prototype ([MihenkAI/solana-pay-per-call](https://github.com/MihenkAI/solana-pay-per-call), November 2026); everything NEAR-specific (accounts, `ft_transfer` payments, RPC verification, NEAR Intents) and the agent's narrower-request, trusted-seller and receipt logic are new here. The code was written with AI assistance (Claude). Libraries: [near-api-js](https://github.com/near/near-api-js) 5.1.1 and Node's built-in `node:sqlite`; swaps use the NEAR Intents 1Click API. Test USDC: `usdc.fakes.testnet`, a public test token on NEAR testnet.

## About Mihenk AI

Mihenk AI measures crypto influencers by what their posts actually do and runs five products on that engine: KOL intelligence, KOL marketing for agencies and token projects, social trading with a one-tap trade from the user's own wallet, Mihenk Pay (USDC that reaches a KOL only after verified delivery) and the x402 Agent API.

https://mihenkai.com

Data is measurement, not investment advice.

## License

MIT
