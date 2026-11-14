// One-tap trade on NEAR: after the agent has bought a coin's KOL calls (agent.mjs), it can act on them through
// NEAR Intents. It reads the calls it paid for, buys only if most measured KOLs called the coin long, asks the
// NEAR Intents 1Click API for a quote (USDC on NEAR -> the coin) and, with --execute, sends the USDC to the
// quote's deposit address; NEAR Intents solvers deliver the coin. A hard cap keeps every trade small.
// It only uses data bought on the same network within the last 6 hours.
// usage: NEAR_ENV=mainnet node trade.mjs NEAR --usdc 0.5             # decision + quote only, nothing is sent
//        NEAR_ENV=mainnet node trade.mjs NEAR --usdc 0.5 --execute   # sends the USDC (run it yourself)
//        other coins need a destination address: node trade.mjs SOL --usdc 0.5 --to <solana address>
import fs from "node:fs";
import { account, config, balance, view, NETWORK, TOKEN, TOKEN_LABEL, TGAS, ONE_YOCTO, txLink, units } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
const ONECLICK = process.env.ONECLICK || "https://1click.chaindefuser.com/v0";
const MAX_USDC = Number(process.env.MAX_TRADE_USDC || 1); // hard cap per trade, whatever --usdc says
const usdc = Number(opt("--usdc", "0.5"));
const to = opt("--to", "");
const execute = flag("--execute");
const coin = (args[0] || "NEAR").replace(/^\$/, "").toUpperCase();
const cfg = config();
const agent = await account("agent");
const say = (...a) => console.log(`[trade ${new Date().toISOString().slice(11, 19)}]`, ...a);
// Where the bought coin goes. NEAR stays on NEAR (wNEAR to the agent's own account); other chains need --to.
const DEST = { NEAR: { asset: "nep141:wrap.near", recipient: agent.accountId, chain: "NEAR" },
  SOL: { asset: "nep141:sol.omft.near", chain: "Solana" }, ETH: { asset: "nep141:eth.omft.near", chain: "Ethereum" },
  BTC: { asset: "nep141:btc.omft.near", chain: "Bitcoin" } }[coin];

if (!NETWORK.endsWith("mainnet")) { say("NEAR Intents runs on mainnet: set NEAR_ENV=mainnet"); process.exit(1); }
if (!DEST) { say(`no route set up for ${coin}`); process.exit(1); }
const recipient = DEST.recipient || to;
if (!recipient) { say(`${coin} is delivered on ${DEST.chain}: pass --to <address>`); process.exit(1); }
if (!(usdc > 0) || usdc > MAX_USDC) { say(`trade size ${usdc} ${TOKEN_LABEL} is outside the cap (0 to ${MAX_USDC})`); process.exit(1); }

// 1. The decision comes from the data the agent paid for, not from a tip.
const file = `data/bought-${coin}.json`;
if (!fs.existsSync(file)) { say(`no paid data for ${coin} yet: run agent.mjs ${coin} first`); process.exit(1); }
const d = JSON.parse(fs.readFileSync(file, "utf8"));
if (d.network !== NETWORK) { say(`the saved ${coin} data was bought on ${d.network || "another network"}: run agent.mjs ${coin} on ${NETWORK} first`); process.exit(1); }
if (!(Date.now() - Date.parse(d.bought_at) < 6 * 3600e3)) { say(`the saved ${coin} data is more than 6 hours old: buy it again first`); process.exit(1); }
const s = d.summary;
say(`paid data: $${coin} calls, last ${d.hours}h, bought ${d.bought_at || "earlier"}: ${s.calls} calls from ${s.kols} KOLs (${s.long} long, ${s.short} short)`);
for (const x of d.calls.slice(0, 3)) say(`  @${x.kol} ${x.direction} at ${x.posted_at}`);
if (!(s.long > s.short)) { say("most measured KOLs are not long on this coin: no trade"); process.exit(0); }
say(`most measured KOLs are long: buying $${coin} with ${usdc} ${TOKEN_LABEL} through NEAR Intents`);

// 2. Quote from the NEAR Intents 1Click API.
const amount = String(Math.round(usdc * 10 ** cfg.decimals));
const body = { dry: !execute, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: `nep141:${TOKEN}`, depositType: "ORIGIN_CHAIN",
  destinationAsset: DEST.asset, amount, recipient, recipientType: "DESTINATION_CHAIN", refundTo: agent.accountId, refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 15 * 60e3).toISOString() };
const r = await fetch(`${ONECLICK}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const q = await r.json();
if (!r.ok || !q.quote) { say(`no quote: HTTP ${r.status} ${JSON.stringify(q).slice(0, 300)}`); process.exit(1); }
const Q = q.quote;
say(`quote: ${Q.amountInFormatted} ${TOKEN_LABEL} -> ${Q.amountOutFormatted} ${coin} on ${DEST.chain} (about $${Q.amountOutUsd}), to ${recipient}`);
if (!execute) { say("dry run: nothing was sent. Add --execute to send the USDC."); process.exit(0); }

// 3. Pay the deposit address. It must be registered on the USDC contract to receive it.
const dep = Q.depositAddress;
if ((await balance(agent.accountId)) < BigInt(amount)) { say(`not enough ${TOKEN_LABEL} in ${agent.accountId}`); process.exit(1); }
if (!(await view(TOKEN, "storage_balance_of", { account_id: dep }))) {
  const bounds = await view(TOKEN, "storage_balance_bounds");
  await agent.functionCall({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: dep, registration_only: true },
    gas: 30n * TGAS, attachedDeposit: BigInt(bounds.min) });
}
const out = await agent.functionCall({ contractId: TOKEN, methodName: "ft_transfer", args: { receiver_id: dep, amount: Q.amountIn },
  gas: 30n * TGAS, attachedDeposit: ONE_YOCTO });
const tx = out.transaction.hash;
say(`sent ${Q.amountInFormatted} ${TOKEN_LABEL} to the NEAR Intents deposit address: ${txLink(tx)}`);
await fetch(`${ONECLICK}/deposit/submit`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ txHash: tx, depositAddress: dep }) }).catch(() => null);

// 4. Wait for the solvers.
let st = "";
for (let i = 0; i < 40; i++) {
  await new Promise((w) => setTimeout(w, 6000));
  const j = await (await fetch(`${ONECLICK}/status?depositAddress=${dep}`)).json().catch(() => ({}));
  if (j.status !== st) { st = j.status; say(`status: ${st}`); }
  if (["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(st)) {
    const det = j.swapDetails || {};
    if (st === "SUCCESS") say(`done: ${det.amountOutFormatted || Q.amountOutFormatted} ${coin} delivered to ${recipient}`);
    fs.appendFileSync("trades.jsonl", JSON.stringify({ at: new Date().toISOString(), coin, usdc: Q.amountInFormatted, out: det.amountOutFormatted || Q.amountOutFormatted,
      status: st, deposit_tx: tx, deposit_address: dep, recipient }) + "\n");
    break;
  }
}
say(`agent wallet now holds ${units(await balance(agent.accountId), cfg.decimals)} ${TOKEN_LABEL}`);
