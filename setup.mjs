// One-time setup on NEAR testnet: two accounts (seller and buyer agent) funded by the public testnet faucet,
// storage registration on the test USDC contract, and 5 test USDC minted to the agent.
// usage: npm run setup
// Mainnet (real USDC): SELLER=<account>.near npm run setup:mainnet. The first run creates the agent account for you to fund;
// the second registers the agent and the seller on the USDC contract.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { RPC, KEYS, TOKEN, TOKEN_LABEL, NEAR_ENV, NETWORK, TGAS, rpc, saveKey, readKey, account, view, balance, units } from "./lib.mjs";

const FAUCET = process.env.FAUCET || "https://helper.nearprotocol.com/account";
const say = (...a) => console.log("[setup]", ...a);
const exists = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id }).then(() => true, () => false);

async function ensureAccount(name) {
  const k = readKey(name);
  if (k && (await exists(k.account_id))) { say(`${name}: ${k.account_id} (exists)`); return k.account_id; }
  const id = `mihenk-${name}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`faucet refused ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  saveKey(name, id, kp);
  for (let i = 0; i < 20 && !(await exists(id)); i++) await new Promise((s) => setTimeout(s, 1500));
  say(`${name}: ${id} (created by the testnet faucet)`);
  return id;
}

if (NEAR_ENV === "mainnet") {
  // Mainnet: no faucet and no mint. The agent is an account you fund yourself (a little NEAR for gas and some USDC),
  // with its key in keys-mainnet/agent.json ({"account_id", "private_key"}). The seller only receives, so it needs no key:
  // pass it as SELLER=<your account>.near. The agent registers both accounts on the USDC contract if needed.
  const seller = process.env.SELLER;
  if (!seller) throw new Error("mainnet setup needs SELLER=<the account that receives payments>.near");
  const k = readKey("agent");
  if (!k) {
    // First run: make the agent a NEAR implicit account (its name is the hex of its public key; it exists once it receives NEAR).
    const kp = KeyPair.fromRandom("ed25519");
    const id = Buffer.from(kp.getPublicKey().data).toString("hex");
    saveKey("agent", id, kp);
    say(`new agent account ${id} (key in ${KEYS}/agent.json, never commit it)`);
    say(`send it about 0.3 NEAR for gas and storage, and some USDC on NEAR, then run this again`);
    process.exit(0);
  }
  if (!(await exists(k.account_id))) throw new Error(`${k.account_id} does not exist yet: send it some NEAR first`);
  const meta = await view(TOKEN, "ft_metadata");
  const agent = await account("agent");
  const bounds = await view(TOKEN, "storage_balance_bounds");
  for (const id of [k.account_id, seller]) {
    if (await view(TOKEN, "storage_balance_of", { account_id: id })) continue;
    await agent.functionCall({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: id, registration_only: true },
      gas: 30n * TGAS, attachedDeposit: BigInt(bounds.min) });
    say(`${id}: registered on ${meta.symbol} (${TOKEN})`);
  }
  fs.mkdirSync(KEYS, { recursive: true });
  fs.writeFileSync(path.join(KEYS, "config.json"), JSON.stringify({ network: NETWORK, rpc: RPC, token: TOKEN, decimals: meta.decimals, seller, agent: k.account_id }, null, 2));
  say(`${NETWORK}: agent ${k.account_id} holds ${units(await balance(k.account_id), meta.decimals)} ${TOKEN_LABEL}; seller ${seller}`);
  process.exit(0);
}

const seller = await ensureAccount("seller");
const agentId = await ensureAccount("agent");
const meta = await view(TOKEN, "ft_metadata");
say(`token ${TOKEN}: ${meta.symbol}, ${meta.decimals} decimals`);

for (const name of ["seller", "agent"]) {
  const acc = await account(name);
  const reg = await view(TOKEN, "storage_balance_of", { account_id: acc.accountId });
  if (reg) continue;
  const bounds = await view(TOKEN, "storage_balance_bounds");
  await acc.functionCall({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: acc.accountId, registration_only: true },
    gas: 30n * TGAS, attachedDeposit: BigInt(bounds.min) });
  say(`${name}: registered on ${TOKEN}`);
}

const agent = await account("agent");
if ((await balance(agentId)) < 1_000_000n) {
  // usdc.fakes.testnet exposes a public mint for testing; another token would need its own faucet.
  await agent.functionCall({ contractId: TOKEN, methodName: "mint", args: { account_id: agentId, amount: "5000000" }, gas: 30n * TGAS, attachedDeposit: 0n });
  say(`minted 5 test USDC to the agent`);
}
fs.mkdirSync(KEYS, { recursive: true });
fs.writeFileSync(path.join(KEYS, "config.json"), JSON.stringify({ network: "near-testnet", rpc: RPC, token: TOKEN, decimals: meta.decimals, seller, agent: agentId }, null, 2));
say(`agent holds ${units(await balance(agentId), meta.decimals)} test USDC; seller holds ${units(await balance(seller), meta.decimals)}`);
say(`done: keys and config in ${KEYS}/ (never commit this folder)`);
