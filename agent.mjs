// A small buyer agent with its own NEAR testnet wallet. For each coin it asks the API, reads the 402 price,
// checks it against its budget and its list of trusted sellers, narrows the request once if the price is too high,
// pays in test USDC (ft_transfer with the nonce as memo), retries with proof and keeps a receipt of what it bought.
// usage: node agent.mjs NEAR [SOL ...] [--budget 0.05] [--hours 24] [--api http://localhost:8403]
import fs from "node:fs";
import { account, config, balance, NETWORK, TGAS, ONE_YOCTO, txLink, b64, unb64, units } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const API = opt("--api", process.env.API || "http://localhost:8403");
let budget = BigInt(Math.round(Number(opt("--budget", "0.05")) * 1e6));
const hours = opt("--hours", "24");
const coins = args.length ? args : ["NEAR"];
const cfg = config();
const DEC = cfg.decimals;
const agent = await account("agent");
// The agent only pays sellers and tokens it trusts, whatever a 402 response asks for.
const trustedSellers = new Set([cfg.seller, ...(process.env.TRUSTED_SELLERS || "").split(",").filter(Boolean)]);
const say = (...a) => console.log(`[agent ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function quote(url) {
  const r = await fetch(url);
  if (r.status !== 402) return { response: r };
  const body = await r.json();
  return { req: body.accepts.find((a) => a.network === NETWORK && a.scheme === "exact") };
}

async function pay(req) {
  const out = await agent.functionCall({
    contractId: req.asset, methodName: "ft_transfer",
    args: { receiver_id: req.payTo, amount: req.maxAmountRequired, memo: req.extra.memo },
    gas: 30n * TGAS, attachedDeposit: ONE_YOCTO,
  });
  return out.transaction.hash;
}

say(`wallet ${agent.accountId} holds ${units(await balance(agent.accountId), DEC)} test USDC; budget ${units(budget, DEC)}`);

for (const coin of coins) {
  let url = `${API}/v1/coin/${encodeURIComponent(coin)}/calls?hours=${hours}`;
  say(`GET ${url}`);
  let { req, response } = await quote(url);
  if (req) {
    let price = BigInt(req.maxAmountRequired);
    say(`402 Payment Required: ${units(price, DEC)} ${req.extra.token} to ${req.payTo}`);
    if (price > budget && req.extra.cheaper_option && BigInt(req.extra.cheaper_option.maxAmountRequired) <= budget) {
      url = `${API}/v1/coin/${encodeURIComponent(coin)}/calls?hours=${req.extra.cheaper_option.hours}`;
      say(`over my remaining budget (${units(budget, DEC)}); asking for the narrower ${req.extra.cheaper_option.hours}h window instead`);
      ({ req } = await quote(url));
      price = BigInt(req.maxAmountRequired);
      say(`402 Payment Required: ${units(price, DEC)} ${req.extra.token} for the ${url.split("hours=")[1]}h window`);
    }
    if (price > budget) { say(`price is above my remaining budget (${units(budget, DEC)}), not paying`); continue; }
    if (!trustedSellers.has(req.payTo) || req.asset !== cfg.token) { say(`untrusted seller or token (${req.payTo}, ${req.asset}), not paying`); continue; }
    const tx = await pay(req);
    budget -= price;
    say(`paid on ${NETWORK}: ${txLink(tx)}`);
    response = await fetch(url, { headers: { "X-PAYMENT": b64({ x402Version: 1, scheme: "exact", network: NETWORK,
      payload: { tx_hash: tx, sender_id: agent.accountId, nonce: req.extra.nonce } }) } });
    req.tx = tx;
    req.price = price;
  }
  if (response.status !== 200) { say(`failed: HTTP ${response.status}`, JSON.stringify(await response.json()).slice(0, 200)); continue; }
  const receipt = response.headers.get("x-payment-response");
  if (receipt) say(`receipt: ${JSON.stringify(unb64(receipt))}`);
  const d = await response.json();
  // Check what was delivered before recording the purchase as good.
  const passed = d?.symbol === String(coin).replace(/^\$/, "").toUpperCase() && Array.isArray(d.calls) && d.summary?.calls === d.calls.length;
  fs.appendFileSync("receipts.jsonl", JSON.stringify({ at: new Date().toISOString(), bought: `${d.symbol} calls, last ${d.hours}h`,
    from: req?.payTo, price: req ? units(req.price, DEC) : "0", token: req?.asset, tx: req?.tx, check: passed ? "passed" : "failed" }) + "\n");
  const s = d.summary;
  say(`bought $${d.symbol} calls, last ${d.hours}h; check ${passed ? "passed" : "FAILED"}`);
  say(`  ${s.calls} calls from ${s.kols} KOLs (${s.long} long, ${s.short} short)`);
  for (const x of d.calls.slice(0, 5)) {
    const mv = Object.entries(x.price_move_pct).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}%`).join(", ");
    say(`  @${x.kol} (${x.followers.toLocaleString("en-US")} followers) ${x.direction} at ${x.posted_at} -> ${mv ? `${mv} (${x.price_source || "price feed n/a"})` : "not measured yet"}`);
  }
}
say(`done; remaining budget ${units(budget, DEC)} test USDC, wallet ${units(await balance(agent.accountId), DEC)}; receipts in receipts.jsonl`);
