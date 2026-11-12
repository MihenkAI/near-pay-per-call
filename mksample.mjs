// Maintainer script: writes data/sample.json from Mihenk's dataset (needs MIHENK_DB), so the repo runs without the database.
// usage: MIHENK_DB=/path/to/db node mksample.mjs NEAR SOL BTC ETH
import fs from "node:fs";
import { coinCalls } from "./data.mjs";
const out = {};
const at = new Date().toISOString().slice(0, 16) + "Z";
for (const s of process.argv.slice(2)) {
  const d = coinCalls(s, 24);
  out[d.symbol] = { ...d, source: undefined, snapshot: `Mihenk AI dataset, last 24h as of ${at}` };
}
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/sample.json", JSON.stringify(out, null, 1));
console.log("wrote data/sample.json:", Object.entries(out).map(([k, v]) => `${k} ${v.summary.calls} calls`).join(", "));
