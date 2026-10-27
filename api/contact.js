// 株式会社NEXY お問い合わせフォームのAPI（/api/contact）
// POST：問い合わせを受け付ける。
//   1. Vercel Blob（private）の contact/ 以下に1件1ファイルで保存する
//   2. 環境変数 CONTACT_WEBHOOK_URL（Discord / Slack の Incoming Webhook）があれば通知する
//   どちらか一方でも成功すれば受付完了とする。
// GET：保存済みの問い合わせ一覧を返す（ヘッダ Authorization: Bearer <ADMIN_PASSWORD> が必要）。
import crypto from "node:crypto";

const TYPES = ["協賛のご相談", "NEXY AIのご相談", "自治体・教育機関", "取材・講演のご依頼", "メンバー・参加について", "その他"];
const LIMIT = { org: 100, name: 60, email: 200, tel: 30, message: 4000 };

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

function blobReady() { return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }

async function save(entry) {
  if (!blobReady()) return false;
  const blob = await import("@vercel/blob");
  const d = new Date(entry.receivedAt);
  const key = `contact/${d.toISOString().slice(0, 7)}/${entry.receivedAt.replace(/[:.]/g, "-")}-${entry.id}.json`;
  await blob.put(key, JSON.stringify(entry, null, 2), { access: "private", addRandomSuffix: false, contentType: "application/json" });
  return true;
}

async function notify(entry) {
  const url = process.env.CONTACT_WEBHOOK_URL;
  if (!url) return false;
  const lines = [
    `【お問い合わせ】${entry.type}`,
    `会社・団体名：${entry.org || "（なし）"}`,
    `お名前：${entry.name}`,
    `メール：${entry.email}`,
    `電話：${entry.tel || "（なし）"}`,
    "―――",
    entry.message,
  ];
  let text = lines.join("\n");
  if (text.length > 1900) text = text.slice(0, 1900) + "…（続きは保存データを確認）";
  const body = url.includes("hooks.slack.com") ? { text } : { content: text, allowed_mentions: { parse: [] } };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.ok;
}

async function list(req, res) {
  const pw = process.env.ADMIN_PASSWORD;
  const auth = String(req.headers.authorization || "");
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const ok = pw && given.length === pw.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pw));
  if (!ok) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!blobReady()) return res.status(200).json({ ok: true, items: [] });
  const blob = await import("@vercel/blob");
  const { blobs } = await blob.list({ prefix: "contact/", limit: 1000 });
  const latest = blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1)).slice(0, 100);
  const items = [];
  for (const b of latest) {
    const r = await blob.get(b.pathname, { access: "private", useCache: false }).catch(() => null);
    if (!r || r.statusCode !== 200) continue;
    try { items.push(JSON.parse(Buffer.from(await new Response(r.stream).arrayBuffer()).toString("utf8"))); } catch {}
  }
  return res.status(200).json({ ok: true, items });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return list(req, res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

  const b = await readBody(req);
  // スパム対策：人には見えない欄（website）に入力があれば、成功したふりをして捨てる
  if (clean(b.website, 200)) return res.status(200).json({ ok: true });
  // 表示から3秒未満の送信は機械とみなす
  const elapsed = Number(b.elapsed || 0);
  if (elapsed && elapsed < 3000) return res.status(200).json({ ok: true });

  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    receivedAt: new Date().toISOString(),
    type: TYPES.includes(b.type) ? b.type : "その他",
    org: clean(b.org, LIMIT.org),
    name: clean(b.name, LIMIT.name),
    email: clean(b.email, LIMIT.email),
    tel: clean(b.tel, LIMIT.tel),
    message: clean(b.message, LIMIT.message),
    page: clean(b.page, 200),
    ua: clean(req.headers["user-agent"], 200),
  };
  const errors = {};
  if (!entry.name) errors.name = "お名前を入力してください";
  if (!isEmail(entry.email)) errors.email = "メールアドレスを正しく入力してください";
  if (entry.message.length < 5) errors.message = "お問い合わせ内容を入力してください";
  if (!b.agree) errors.agree = "個人情報の取り扱いへの同意が必要です";
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

  const results = await Promise.allSettled([save(entry), notify(entry)]);
  const delivered = results.some((r) => r.status === "fulfilled" && r.value === true);
  if (!delivered) {
    console.error("contact: not delivered", results.map((r) => (r.status === "rejected" ? String(r.reason) : r.value)));
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  return res.status(200).json({ ok: true, id: entry.id });
}
