// Pay-per-call API on NEAR testnet with an x402-style handshake:
//   1. GET without payment     -> 402 + payment requirements (price, token, payTo, one-time nonce)
//   2. the agent sends ft_transfer of test USDC on NEAR with memo "mihenk-x402:<nonce>"
//   3. GET again with X-PAYMENT -> the server reads the transaction from NEAR RPC, checks it, answers 200 + X-PAYMENT-RESPONSE
// The 402 is a 5-minute quote. A transfer that carries an issued nonce but lands after the quote expired is still
// served at the quoted price (for up to 24 hours), so an agent that paid never ends up with nothing.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { config, rpc, NETWORK, priceFor, clampHours, txLink, b64, unb64, units } from "./lib.mjs";
import { coinCalls, source } from "./data.mjs";

const PORT = Number(process.env.PORT || 8403);
const HOST = process.env.HOST || "127.0.0.1"; // set HOST=0.0.0.0 to serve other machines
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const cfg = config();
const DEC = cfg.decimals;
const QUOTE_MS = Number(process.env.QUOTE_SECONDS || 300) * 1000; // how long a 402 quote is valid
const KEEP_MS = 24 * 3600e3; // how long an issued nonce can still be settled by a late payment
const NONCES = "data/nonces.json";
// nonce -> { resource, price, issued, exp }; kept on disk so a late payment is honoured after a restart too
const nonces = new Map(fs.existsSync(NONCES)
  ? Object.entries(JSON.parse(fs.readFileSync(NONCES, "utf8"))).map(([k, v]) => [k, { ...v, price: BigInt(v.price) }])
  : []);
function saveNonces() {
  const now = Date.now();
  for (const [k, v] of nonces) if (now - v.issued > KEEP_MS) nonces.delete(k);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(NONCES, JSON.stringify(Object.fromEntries([...nonces].map(([k, v]) => [k, { ...v, price: v.price.toString() }]))));
}
const USED = "data/used.json";
const used = new Set(fs.existsSync(USED) ? JSON.parse(fs.readFileSync(USED, "utf8")) : []);
const pending = new Set(); // tx hashes being verified right now (blocks two parallel requests with one payment)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function requirements(resource, hours) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const price = priceFor(hours);
  const issued = Date.now();
  nonces.set(nonce, { resource, price, issued, exp: issued + QUOTE_MS });
  saveNonces();
  const extra = { decimals: DEC, token: "test USDC", method: "ft_transfer", memo: `mihenk-x402:${nonce}`, nonce };
  // Tell the agent about a cheaper, narrower request it can make instead.
  if (hours > 6) extra.cheaper_option = { hours: 6, maxAmountRequired: priceFor(6).toString() };
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [{
      scheme: "exact", network: NETWORK, maxAmountRequired: price.toString(), asset: cfg.token, payTo: cfg.seller,
      resource, description: `Measured crypto-KOL calls for one coin over the last ${hours}h (Mihenk AI)`,
      mimeType: "application/json", maxTimeoutSeconds: QUOTE_MS / 1000, extra,
    }],
  };
}

async function readTx(tx_hash, sender) {
  for (let i = 0; i < 10; i++) {
    try { return await rpc("tx", { tx_hash, sender_account_id: sender, wait_until: "FINAL" }); }
    catch (e) { if (!/UNKNOWN_TRANSACTION|TIMEOUT/i.test(e.message) || i === 9) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}

async function verify(payment, resource) {
  const { tx_hash, sender_id, nonce } = payment?.payload || {};
  if (payment?.network !== NETWORK || !tx_hash || !sender_id || !nonce) return "malformed X-PAYMENT";
  const n = nonces.get(nonce);
  if (!n || Date.now() - n.issued > KEEP_MS) return "unknown nonce";
  const late = Date.now() > n.exp; // paid after the quote expired: still served at the quoted price
  if (n.resource !== resource) return "nonce was issued for a different resource";
  if (used.has(tx_hash) || pending.has(tx_hash)) return "payment already used";
  // Reserve the nonce and the transaction before any await, so a parallel request can't reuse them.
  nonces.delete(nonce);
  pending.add(tx_hash);
  const fail = (reason) => { pending.delete(tx_hash); nonces.set(nonce, n); saveNonces(); return reason; };
  let r;
  try { r = await readTx(tx_hash, sender_id); } catch (e) { return fail(`could not read the transaction (${e.message})`); }
  if (!r?.status || !("SuccessValue" in r.status)) return fail("transaction failed on-chain");
  const tx = r.transaction;
  if (tx.signer_id !== sender_id) return fail("sender does not match the transaction signer");
  if (tx.receiver_id !== cfg.token) return fail("transaction is not a call to the payment token");
  const call = tx.actions.map((a) => a.FunctionCall).find((f) => f?.method_name === "ft_transfer");
  if (!call) return fail("no ft_transfer in the transaction");
  let args;
  try { args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8")); } catch { return fail("unreadable ft_transfer arguments"); }
  const memo = `mihenk-x402:${nonce}`;
  if (args.receiver_id !== cfg.seller) return fail("payment went to another account");
  if (args.memo !== memo) return fail("memo with the nonce is missing");
  if (BigInt(args.amount) < n.price) return fail(`paid ${args.amount} units, ${n.price} required`);
  const outcomes = [r.transaction_outcome, ...r.receipts_outcome];
  if (outcomes.some((o) => o.outcome.status?.Failure)) return fail("a receipt of the transaction failed");
  // Require the token contract's own log of this transfer: a NEP-141 event (current contracts)
  // or the "Transfer <amount> from <a> to <b>" + "Memo: ..." lines older NEP-141 contracts such as usdc.fakes.testnet write.
  const tokenLogs = r.receipts_outcome.filter((o) => o.outcome.executor_id === cfg.token).flatMap((o) => o.outcome.logs);
  const event = tokenLogs.filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => { try { return JSON.parse(l.slice(11)); } catch { return null; } })
    .some((e) => e?.standard === "nep141" && e.event === "ft_transfer" &&
      e.data?.some((d) => d.old_owner_id === sender_id && d.new_owner_id === cfg.seller && BigInt(d.amount) >= n.price && d.memo === memo));
  const legacy = tokenLogs.includes(`Memo: ${memo}`) && tokenLogs.some((l) => {
    const t = l.match(/^Transfer (\d+) from (\S+) to (\S+)$/);
    return t && t[2] === sender_id && t[3] === cfg.seller && BigInt(t[1]) >= n.price;
  });
  if (!event && !legacy) return fail("the token contract did not log this transfer");
  const block = await rpc("block", { block_id: r.transaction_outcome.block_hash }).catch(() => null);
  if (!block) return fail("could not read the block of the payment");
  // The transfer must have been made for this quote: after the nonce was issued (1 minute clock tolerance).
  if (Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) < n.issued - 60e3) return fail("payment was made before this nonce was issued");
  pending.delete(tx_hash);
  used.add(tx_hash);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(USED, JSON.stringify([...used]));
  saveNonces();
  return { ok: true, tx_hash, payer: sender_id, paid: BigInt(args.amount), late };
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*",
    "access-control-expose-headers": "X-PAYMENT-RESPONSE", ...headers });
  res.end(JSON.stringify(body, null, 2));
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    if (url.pathname === "/") {
      return send(res, 200, {
        name: "Mihenk AI - pay per call on NEAR",
        description: `Measured crypto-KOL data for AI agents, paid per call in test USDC on ${NETWORK} with an x402-style 402 handshake.`,
        endpoints: { "GET /v1/coin/{symbol}/calls?hours=24": "0.005 test USDC up to 6h, 0.01 up to 24h, 0.03 up to 7 days" },
        network: NETWORK, asset: cfg.token, payTo: cfg.seller, data_source: source,
      });
    }
    const m = url.pathname.match(/^\/v1\/coin\/([A-Za-z0-9$]{1,16})\/calls$/);
    if (!m) return send(res, 404, { error: "not_found" });
    const hours = clampHours(url.searchParams.get("hours"));
    const resource = `${PUBLIC_URL}${url.pathname}?hours=${hours}`;
    const header = req.headers["x-payment"];
    if (!header) {
      log("402", url.pathname, `${hours}h`, `price ${units(priceFor(hours), DEC)}`);
      return send(res, 402, requirements(resource, hours));
    }
    let payment;
    try { payment = unb64(header); } catch { return send(res, 402, { ...requirements(resource, hours), error: "X-PAYMENT is not valid base64 JSON" }); }
    const v = await verify(payment, resource);
    if (v?.ok !== true) {
      log("402 rejected:", v);
      return send(res, 402, { ...requirements(resource, hours), error: v });
    }
    const data = coinCalls(m[1], hours);
    log("200 paid", units(v.paid, DEC), "by", v.payer, txLink(v.tx_hash), v.late ? "(paid after the quote expired; served at the quoted price)" : "");
    return send(res, 200, data, { "X-PAYMENT-RESPONSE": b64({ success: true, transaction: v.tx_hash, network: NETWORK, payer: v.payer }) });
  } catch (e) {
    log("error", e.message);
    return send(res, 500, { error: "internal_error" });
  }
}).listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT} (${source}); token ${cfg.token}; payTo ${cfg.seller}; quote ${QUOTE_MS / 1000}s`));
