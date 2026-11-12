# Mihenk AI: pay per call on NEAR

AI agents buy measured crypto-influencer (KOL) data one call at a time and pay for it in USDC on NEAR. There is no account and no API key. The API answers `402 Payment Required`, the agent pays with a NEP-141 `ft_transfer` on NEAR, and the data comes back with a receipt.

Built at **NEAR HACKATHON (1–14 November 2026)** for the **Agent Economy** track. Demo video: [demo/mihenk-near-pay-per-call.mp4](demo/mihenk-near-pay-per-call.mp4)

## Why

When a crypto influencer calls a coin, traders and trading agents act on it within minutes. Before an agent follows, it needs two answers: who else called this coin, and what happened after their earlier calls. [Mihenk AI](https://mihenkai.com) already measures that for 15,800+ KOLs on X, Telegram and YouTube. This project lets an agent with its own NEAR wallet buy the answer for one cent per call, with nothing to sign up for.

## How it works

```
agent (own NEAR testnet account)        API (server.mjs)                          NEAR testnet
  | GET /v1/coin/NEAR/calls?hours=24        |                                          |
  |---------------------------------------->|                                          |
  | 402 {price, token, payTo, nonce}        |                                          |
  |<----------------------------------------|                                          |
  | ft_transfer(payTo, price, memo "mihenk-x402:<nonce>") on the test USDC contract     |
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
- the payment is less than 10 minutes old and its transaction hash was never used before.

The nonce and the transaction hash are reserved before the server waits on RPC, so two parallel requests can't share one payment. The messages follow x402 v1 (`accepts`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`, scheme `exact`); on NEAR this repo uses a pay-then-prove variant without a facilitator: the agent submits the transfer itself and the server verifies it on-chain.

## What the agent does

`agent.mjs` is a small buyer with its own NEAR testnet account and a spending budget:

- it reads the price from the 402 and pays only if the price fits its remaining budget;
- if the 24-hour window costs more than it has left, it asks once for the cheaper 6-hour window the server offers, and walks away if that is still too much;
- it pays only sellers and tokens it trusts (the seller in `keys/config.json`, plus any in `TRUSTED_SELLERS`), whatever a 402 response asks for;
- after each purchase it checks what it received (right coin, consistent counts) and appends a receipt to `receipts.jsonl`: what it bought, from whom, the price, the NEAR transaction and whether the delivery passed its check.

Prices: 0.005 test USDC for up to 6 hours of calls, 0.01 for up to 24 hours, 0.03 for up to 7 days.

## Run it

Requires Node 22.13 or newer. Everything runs on NEAR testnet; nothing needs real funds.

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

Without Mihenk's database the server answers from `data/sample.json`, a snapshot of the last 24 hours of Mihenk data for NEAR, SOL, BTC and ETH taken on 12 November 2026 (07:25 UTC); a 6-hour request returns that same 24-hour snapshot. With `MIHENK_DB` pointing to Mihenk's SQLite dataset it answers with live data. Keys and account names are written to `keys/` (git-ignored).

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

A reused or underpaid payment is refused:

```
[test] paid once: AfHPQvxWkyeR2zsk3jjHtjAiQcisgveNBJxThFu1p2z7
[test] first call with the payment  -> 200
[test] same payment, new request    -> 402 payment already used
[test] same payment, made-up nonce  -> 402 unknown or expired nonce
[test] underpaid transfer (1/10)    -> 402 paid 1000 units, 10000 required
[test] PASS: one payment buys exactly one call; underpayment is refused
```

## Files

| File | What it does |
|---|---|
| `server.mjs` | The pay-per-call API: 402 with payment requirements, verification on NEAR RPC, data with a receipt |
| `agent.mjs` | Buyer agent: budget, trusted sellers, one narrower request when over budget, pays with `ft_transfer`, keeps receipts |
| `setup.mjs` | Testnet accounts from the faucet, storage registration and test USDC for the agent |
| `test.mjs` | Payment checks: one payment buys exactly one call; underpayment is refused |
| `lib.mjs` | Shared config, NEAR connection, RPC and prices |
| `data.mjs` | Read-only access to Mihenk's measured KOL calls, or the offline sample |
| `mksample.mjs` | Maintainer script that writes `data/sample.json` from Mihenk's dataset |

## NEAR's role

NEAR is the payment and identity layer: the agent and the seller are NEAR accounts, each call is paid with a NEP-141 `ft_transfer` whose memo binds the payment to one request, and the server proves the payment by reading the finalized transaction and the token contract's own logs from NEAR RPC. Human-readable accounts make receipts easy to audit, and because `ft_transfer` requires a 1 yoctoNEAR deposit, a payment can only be signed with the account's full-access key.

## What's next

- The same flow with Circle's native USDC on NEAR mainnet.
- NEAR Intents, so an agent can pay from any chain it holds funds on.
- NEAR as a payment option in Mihenk's live x402 Agent API, which already takes USDC on Base, Arc and Polygon.

## How this was built

All code in this repository was written inside the hackathon window: `data.mjs` comes from our Solana prototype of 8 November 2026, and everything else was written on 12 November 2026. The 402 handshake follows the design of our earlier Solana prototype ([MihenkAI/solana-pay-per-call](https://github.com/MihenkAI/solana-pay-per-call), November 2026); everything NEAR-specific (accounts, `ft_transfer` payments, RPC verification) and the agent's narrower-request, trusted-seller and receipt logic are new here. The code was written with AI assistance (Claude). Libraries: [near-api-js](https://github.com/near/near-api-js) 5.1.1 and Node's built-in `node:sqlite`. Test USDC: `usdc.fakes.testnet`, a public test token on NEAR testnet.

## About Mihenk AI

Mihenk AI measures crypto influencers by what their posts actually do and runs five products on that engine: KOL intelligence, KOL marketing for agencies and token projects, social trading with a one-tap trade from the user's own wallet, Mihenk Pay (USDC that reaches a KOL only after verified delivery) and the x402 Agent API.

https://mihenkai.com

Data is measurement, not investment advice.

## License

MIT
