// Payment checks against a running server: one payment buys exactly one call, an underpaid transfer is refused,
// and a transfer that lands after its quote expired is still served.
// usage (server running): node test.mjs [--api http://localhost:8403]
// The late-payment check waits for the quote to expire, so start the server with a short quote: QUOTE_SECONDS=5 npm run server
import { account, NETWORK, TGAS, ONE_YOCTO, b64 } from "./lib.mjs";

const i = process.argv.indexOf("--api");
const API = i > 0 ? process.argv[i + 1] : process.env.API || "http://localhost:8403";
const url = `${API}/v1/coin/NEAR/calls?hours=24`;
const agent = await account("agent");
const proof = (tx_hash, nonce) => ({ headers: { "X-PAYMENT": b64({ x402Version: 1, scheme: "exact", network: NETWORK, payload: { tx_hash, sender_id: agent.accountId, nonce } }) } });
const quote = async () => (await (await fetch(url)).json()).accepts[0];
const transfer = async (q, amount) => (await agent.functionCall({ contractId: q.asset, methodName: "ft_transfer",
  args: { receiver_id: q.payTo, amount, memo: q.extra.memo }, gas: 30n * TGAS, attachedDeposit: ONE_YOCTO })).transaction.hash;
const say = (...a) => console.log("[test]", ...a);

const q1 = await quote();
const tx = await transfer(q1, q1.maxAmountRequired);
say("paid once:", tx);
const r1 = await fetch(url, proof(tx, q1.extra.nonce));
say("first call with the payment  ->", r1.status);
const q2 = await quote();
const r2 = await fetch(url, proof(tx, q2.extra.nonce));
say("same payment, new request    ->", r2.status, (await r2.json()).error);
const r3 = await fetch(url, proof(tx, "0".repeat(24)));
say("same payment, made-up nonce  ->", r3.status, (await r3.json()).error);
const q4 = await quote();
const low = await transfer(q4, (BigInt(q4.maxAmountRequired) / 10n).toString());
const r4 = await fetch(url, proof(low, q4.extra.nonce));
say("underpaid transfer (1/10)    ->", r4.status, (await r4.json()).error);
let lateOk = true, lateRun = false;
const q5 = await quote();
if (q5.maxTimeoutSeconds <= 30) {
  await new Promise((r) => setTimeout(r, (q5.maxTimeoutSeconds + 2) * 1000));
  const late = await transfer(q5, q5.maxAmountRequired);
  const r5 = await fetch(url, proof(late, q5.extra.nonce));
  say(`paid ${q5.maxTimeoutSeconds + 2}s after a ${q5.maxTimeoutSeconds}s quote ->`, r5.status);
  const r6 = await fetch(url, proof(late, q5.extra.nonce));
  say("same late payment again       ->", r6.status, (await r6.json()).error);
  lateOk = r5.status === 200 && r6.status === 402;
  lateRun = true;
} else {
  say(`late-payment check skipped: the quote lasts ${q5.maxTimeoutSeconds}s (start the server with QUOTE_SECONDS=5 to run it)`);
}
const ok = r1.status === 200 && r2.status === 402 && r3.status === 402 && r4.status === 402 && lateOk;
say(ok ? `PASS: one payment buys exactly one call; underpayment is refused${lateRun ? "; a late payment is still served" : ""}` : "FAIL");
process.exit(ok ? 0 : 1);
