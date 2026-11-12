// Shared helpers: config, keys, NEAR connection, raw RPC and formatting.
import { connect, keyStores, KeyPair } from "near-api-js";
import fs from "node:fs";
import path from "node:path";

export const RPC = process.env.RPC || "https://rpc.testnet.near.org";
export const NETWORK = "near-testnet";
export const KEYS = process.env.KEYS || "keys";
// Test USDC on NEAR testnet (NEP-141). usdc.fakes.testnet has a public mint, so anyone can reproduce the demo.
export const TOKEN = process.env.TOKEN || "usdc.fakes.testnet";
export const ONE_YOCTO = 1n; // ft_transfer requires exactly 1 yoctoNEAR attached
export const TGAS = 1_000_000_000_000n;

// Price list in token units (6 decimals): 24h of calls costs 0.01 test USDC; a narrower 6h window costs half.
export const PRICES = [
  { maxHours: 6, units: 5_000n },
  { maxHours: 24, units: 10_000n },
  { maxHours: 168, units: 30_000n },
];
export const priceFor = (hours) => (PRICES.find((p) => hours <= p.maxHours) || PRICES.at(-1)).units;
export const clampHours = (h) => Math.max(1, Math.min(168, Number(h) || 24));

export async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "mihenk", method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error?.cause?.name || j.error?.message || JSON.stringify(j.error));
  return j.result;
}

export function saveKey(name, accountId, keyPair) {
  fs.mkdirSync(KEYS, { recursive: true });
  fs.writeFileSync(path.join(KEYS, `${name}.json`), JSON.stringify({ account_id: accountId, private_key: keyPair.toString() }), { mode: 0o600 });
}

export function readKey(name) {
  const p = path.join(KEYS, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Returns a near-api-js Account for keys/<name>.json.
export async function account(name) {
  const k = readKey(name);
  if (!k) throw new Error(`missing ${path.join(KEYS, name + ".json")} - run "npm run setup" first`);
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("testnet", k.account_id, KeyPair.fromString(k.private_key));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks, logger: false });
  return near.account(k.account_id);
}

export function config() {
  const p = path.join(KEYS, "config.json");
  if (!fs.existsSync(p)) throw new Error(`missing ${p} - run "npm run setup" first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export const view = (contractId, methodName, args = {}) =>
  rpc("query", { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
    .then((r) => JSON.parse(Buffer.from(r.result).toString("utf8")));

export const balance = async (accountId) => BigInt(await view(TOKEN, "ft_balance_of", { account_id: accountId }));
export const txLink = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const units = (n, decimals = 6) => String(Number((Number(n) / 10 ** decimals).toFixed(4)));
export const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
export const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
