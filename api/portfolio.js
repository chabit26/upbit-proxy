import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

export default async function handler(req, res) {
  // CORS (Softr 호출 대비)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { access_key, secret_key, user_id } = req.body || {};
    if (!access_key || !secret_key) {
      return res.status(400).json({ error: "access_key and secret_key are required" });
    }

    // Upbit /v1/accounts (query 없음 → query_hash 불필요)
    const payload = { access_key, nonce: uuidv4() };
    const token = jwt.sign(payload, secret_key);

    const accountsResp = await fetch("https://api.upbit.com/v1/accounts", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" }
    });

    if (!accountsResp.ok) {
      const text = await accountsResp.text();
      return res.status(accountsResp.status).json({ error: "Upbit accounts error", detail: text });
    }

    const accounts = await accountsResp.json();

    // 현재가 ticker (공개 API)
    const markets = accounts
      .filter((a) => a.currency !== "KRW" && a.unit_currency === "KRW")
      .map((a) => `KRW-${a.currency}`);

    const tickerMap = new Map();
    if (markets.length > 0) {
      const tickerResp = await fetch(
        `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(markets.join(","))}`,
        { headers: { accept: "application/json" } }
      );
      if (tickerResp.ok) {
        const tickers = await tickerResp.json();
        for (const t of tickers) tickerMap.set(t.market, t.trade_price);
      }
    }

    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    let total_value_krw = 0;
    let total_cost_krw = 0;
    let total_pnl_krw = 0;

    const krw = accounts.find((a) => a.currency === "KRW");
    const krw_balance = toNum(krw?.balance) + toNum(krw?.locked);
    total_value_krw += krw_balance;

    const assets = accounts
      .filter((a) => a.currency !== "KRW" && a.unit_currency === "KRW")
      .map((a) => {
        const amount = toNum(a.balance) + toNum(a.locked);
        const avg_buy = toNum(a.avg_buy_price);
        const market = `KRW-${a.currency}`;
        const price = toNum(tickerMap.get(market));

        const cost = amount * avg_buy;
        const value = amount * price;
        const pnl = value - cost;
        const return_pct = cost > 0 ? (pnl / cost) * 100 : 0;

        total_value_krw += value;
        total_cost_krw += cost;
        total_pnl_krw += pnl;

        return {
          user_id: user_id ?? null,
          currency: a.currency,
          market,
          amount,
          avg_buy_price: avg_buy,
          price,
          value_krw: value,
          pnl_krw: pnl,
          return_pct
        };
      });

    const total_return_pct = total_cost_krw > 0 ? (total_pnl_krw / total_cost_krw) * 100 : 0;

    return res.status(200).json({
      user_id: user_id ?? null,
      totals: { krw_balance, total_value_krw, total_cost_krw, total_pnl_krw, total_return_pct },
      assets,
      ts: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
}
