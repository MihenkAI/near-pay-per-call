// Read-only access to Mihenk AI's measured KOL dataset (SQLite).
// Without the database (e.g. when you run this repo locally) it serves data/sample.json instead.
import fs from "node:fs";

const DB = process.env.MIHENK_DB || ""; // path to Mihenk's SQLite dataset; empty = offline sample
let db = null;
if (DB && fs.existsSync(DB)) {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(DB, { readOnly: true });
}
export const source = db ? (process.env.DATA_LABEL || "Mihenk AI measured dataset") : "data/sample.json (offline sample)";

const WINDOWS = { "5dk": "5m", "1s": "1h", "4s": "4h", "24s": "24h" };
function priceMoves(impact) {
  const out = {};
  for (const m of String(impact || "").matchAll(/(5dk|1s|4s|24s):\s*F\s*([+-]?\d+(?:\.\d+)?)%/g)) out[WINDOWS[m[1]]] = Number(m[2]);
  return out;
}
// Each measured call is tagged with the price feed used for it.
const FEEDS = { BN: "Binance", GT: "GeckoTerminal", CG: "CoinGecko" };
const priceSource = (impact) => FEEDS[(String(impact || "").match(/\b(BN|GT|CG)\s*$/) || [])[1]] || null;
// Calls are stored in Istanbul time (UTC+3).
function toUtc(d, t) {
  const dt = new Date(`${d}T${(t || "00:00").slice(0, 5)}:00+03:00`);
  return isNaN(dt) ? null : dt.toISOString().replace(".000Z", "Z");
}

export function coinCalls(symbol, hours = 24) {
  const s = String(symbol || "").replace(/^\$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 15);
  if (!s) return null;
  hours = Math.max(1, Math.min(168, Number(hours) || 24));
  let rows;
  if (db) {
    const since = new Date(Date.now() + 3 * 3600e3 - hours * 3600e3).toISOString().slice(0, 16).replace("T", " ");
    rows = db.prepare(`
      SELECT c.cdate, c.ctime, lower(coalesce(c.yon, '')) AS yon, c.impact, c.tweet_url, k.handle, k.followers, k.puan2
      FROM kol_calls c JOIN kols k ON k.id = c.kol_id
      WHERE upper(ltrim(c.ticker, '$')) = ? AND (c.cdate || ' ' || coalesce(substr(c.ctime, 1, 5), '00:00')) >= ?
        AND k.platform = 'x' AND coalesce(k.followers, 0) >= ?
        AND coalesce(k.x_durum, 'aktif') NOT IN ('bulunamadi', 'askida')
      ORDER BY c.cdate DESC, c.ctime DESC LIMIT 50`).all(s, since, Number(process.env.MIN_FOLLOWERS || 0));
  } else {
    const sample = JSON.parse(fs.readFileSync(new URL("./data/sample.json", import.meta.url), "utf8"));
    return sample[s] ? { ...sample[s], source } : { symbol: s, hours, summary: { calls: 0, kols: 0, long: 0, short: 0 }, calls: [], source };
  }
  const calls = rows.map((r) => ({
    kol: String(r.handle || "").replace(/^@/, ""),
    followers: Number(r.followers || 0),
    mihenk_score: r.puan2 != null ? Math.round(Number(r.puan2) * 10) / 10 : null,
    direction: r.yon === "short" ? "short" : r.yon === "long" ? "long" : "spot/mention",
    posted_at: toUtc(r.cdate, r.ctime),
    post_url: r.tweet_url && String(r.tweet_url).startsWith("https://") ? r.tweet_url : null,
    price_move_pct: priceMoves(r.impact),
    price_source: priceSource(r.impact),
  }));
  return {
    symbol: s, hours,
    summary: {
      calls: calls.length,
      kols: new Set(calls.map((x) => x.kol)).size,
      long: calls.filter((x) => x.direction === "long").length,
      short: calls.filter((x) => x.direction === "short").length,
    },
    calls,
    price_move_note: "Price change after the post at 5m / 1h / 4h / 24h; a window appears once it has been measured.",
    source,
    note: "Independent measurement by Mihenk AI (mihenkai.com). Not investment advice.",
  };
}
