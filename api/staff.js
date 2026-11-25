// NEXY 運営メンバー取扱説明書のAPI（/api/staff?a=...）
// データはVercel Blob（private）に保存する。公開リポジトリなので、メンバーの情報はコードに書かない。
//   staff/roster.json      運営メンバー名簿（確定・保留）。代表だけが書き換える
//   staff/pages/<id>.json  一人ひとりの取扱説明書（下書き・公開）
// ログイン：Googleアカウント（Gmail）。名簿で「確定」になっている人と、OWNER_EMAILS の代表だけが入れる。
//   ログイン後は署名付きCookie(nxs)を30日保存。権限は毎回名簿から引き直すので、名簿を変えるとすぐ反映される。
// 権限は3つ：代表（rep）／管理職＝統括・サブ統括（mgr）／メンバー（mem）。
// 見せる範囲の判定はすべてサーバーで行う。画面に送るのは、その人が見てよい項目だけ。
// 環境変数：GOOGLE_CLIENT_ID（必須）、OWNER_EMAILS（代表のGmail、カンマ区切り）、AUTH_SECRET（Cookieの署名）、
//   ANTHROPIC_API_KEY（1on1の文字起こしから下書きを作るときだけ）、ANTHROPIC_MODEL（任意）
import crypto from "node:crypto";

/* ---------------- 保存先（summit.js と同じ仕組み） ---------------- */
let store;
async function getStore() {
  if (store) return store;
  if (process.env.SUMMIT_FS_DIR) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const p = (k) => path.join(process.env.SUMMIT_FS_DIR, k);
    const etagOf = (b) => crypto.createHash("md5").update(b).digest("hex");
    store = {
      ready: true,
      async read(k) { try { const b = await fs.readFile(p(k)); return { body: b, etag: etagOf(b) }; } catch { return null; } },
      async write(k, body, { ifMatch } = {}) {
        if (ifMatch !== undefined) { const c = await this.read(k); if ((c ? c.etag : "") !== ifMatch) throw Object.assign(new Error("precondition"), { precondition: true }); }
        await fs.mkdir(path.dirname(p(k)), { recursive: true }); await fs.writeFile(p(k), body);
      },
      async del(k) { try { await fs.unlink(p(k)); } catch {} },
    };
    return store;
  }
  const blob = await import("@vercel/blob");
  store = {
    ready: !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID),
    async read(k) {
      const r = await blob.get(k, { access: "private", useCache: false }).catch((e) => { if (e instanceof blob.BlobNotFoundError) return null; throw e; });
      if (!r || r.statusCode !== 200) return null;
      return { body: Buffer.from(await new Response(r.stream).arrayBuffer()), etag: r.blob.etag };
    },
    async write(k, body, { ifMatch } = {}) {
      const opt = { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 };
      if (ifMatch) opt.ifMatch = ifMatch;
      try { await blob.put(k, body, opt); } catch (e) { if (e instanceof blob.BlobPreconditionFailedError) throw Object.assign(new Error("precondition"), { precondition: true }); throw e; }
    },
    async del(k) { try { await blob.del(k); } catch {} },
  };
  return store;
}
async function readJSON(key, empty) {
  const cur = await (await getStore()).read(key);
  return cur ? JSON.parse(cur.body.toString("utf8")) : structuredClone(empty);
}
async function updateJSON(key, fn, empty) {
  const s = await getStore();
  for (let i = 0; i < 6; i++) {
    const cur = await s.read(key);
    const data = cur ? JSON.parse(cur.body.toString("utf8")) : structuredClone(empty);
    const out = fn(data);
    if (out === false) return data;
    try { await s.write(key, JSON.stringify(data), { ifMatch: cur ? cur.etag : undefined }); return data; }
    catch (e) { if (!e.precondition) throw e; await new Promise((r) => setTimeout(r, 40 + Math.random() * 120)); }
  }
  throw new Error("busy");
}

/* ---------------- 決まりごと ---------------- */
const TEAMS = ["a", "b", "perm", "media", "rec", "guide"];
const ROLES = ["統括", "サブ統括", "メンバー"];
const STATUS = ["confirmed", "pending"]; // 確定／保留。保留の人はログインできず、ページも代表にしか見えない
const SCOPES = ["all", "team", "lead"];   // 全員／チーム内／管理職まで
// key → 公開範囲の初期設定
const FIELDS = { dream: "all", reason: "all", gain: "all", future: "all", strength: "all", weak: "lead", challenge: "lead", history: "all",
  contact: "team", talkstyle: "team", moves: "team", busy: "team", please: "all", ng: "all", praise: "all", before: "all", after: "all" };
const SKILLS = ["企画", "段取り", "デザイン", "写真・動画", "SNS発信", "文章", "人前で話す", "話を聞く", "数字・お金", "IT・ツール"];
const MONTHS = ["12", "1", "2", "3", "4"];
const REPLY = ["h1", "half", "day", "slow"], PRAISE = ["pub", "dm", "text"];
const ROSTER = "staff/roster.json", EMPTY_ROSTER = { members: {} };
const pageKey = (id) => `staff/pages/${id}.json`;
const EMPTY_PAGE = { status: "draft", consent: "unknown", f: {}, x: { skills: {}, busy: [] }, kw: [], gkw: [], tips: { v: ["", "", ""], pub: false }, thanks: [], excluded: [], updated: 0 };
const isMgr = (r) => r === "統括" || r === "サブ統括";
const str = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, (c) => (c === "\n" ? c : "")).trim().slice(0, n);
const newId = () => crypto.randomBytes(6).toString("base64url");

/* ---------------- HTTP ---------------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);
function cookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const AGE = 30 * 24 * 3600;
const setCookie = (v, age = AGE) => `nxs=${encodeURIComponent(v)}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
async function body(req, max = 200000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("too large"), { status: 413 });
  try { return JSON.parse(t || "{}"); } catch { return {}; }
}

/* ---------------- ログイン ---------------- */
const key = () => crypto.createHash("sha256").update("nx-staff:" + (process.env.AUTH_SECRET || process.env.BLOB_READ_WRITE_TOKEN || process.env.SUMMIT_FS_DIR || "")).digest();
const hmac = (t) => crypto.createHmac("sha256", key()).update(t).digest("base64url");
const sign = (o) => { const t = Buffer.from(JSON.stringify(o)).toString("base64url"); return t + "." + hmac(t); };
function verifyCookie(tok) {
  const [t, sig] = String(tok || "").split(".");
  if (!t || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(t));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(t, "base64url").toString("utf8")); return o.x > Date.now() ? o : null; } catch { return null; }
}
const normEmail = (e) => String(e || "").trim().toLowerCase();
const owners = () => (process.env.OWNER_EMAILS || "").split(",").map(normEmail).filter(Boolean);

// GoogleのIDトークン（JWT）を、Googleの公開鍵で検証する
let jwks = { t: 0, keys: [] };
async function googleKeys() {
  if (Date.now() - jwks.t < 3600e3 && jwks.keys.length) return jwks.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("jwks");
  jwks = { t: Date.now(), keys: (await r.json()).keys || [] };
  return jwks.keys;
}
async function verifyGoogle(cred) {
  const [h, p, s] = String(cred || "").split(".");
  if (!h || !p || !s) return null;
  const head = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (head.alg !== "RS256") return null;
  const jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) return null;
  const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const now = Date.now() / 1000;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(c.iss)) return null;
  if (!process.env.GOOGLE_CLIENT_ID || c.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (!(c.exp > now) || !c.email || c.email_verified !== true) return null;
  return normEmail(c.email);
}

// ログイン中の人。名簿から毎回引き直す（保留に戻された人・外された人はその場で入れなくなる）
async function viewerOf(req, roster) {
  const o = verifyCookie(cookies(req).nxs);
  if (!o) return null;
  return resolve(normEmail(o.e), roster);
}
function resolve(email, roster) {
  if (!email) return null;
  if (owners().includes(email)) return { k: "rep", id: "rep", email, name: "代表" };
  const m = Object.values(roster.members).find((x) => x.email && normEmail(x.email) === email);
  if (!m) return { none: "notfound" };
  if (m.status !== "confirmed") return { none: "pending" };
  return { k: isMgr(m.role) ? "mgr" : "mem", id: m.id, team: m.team, email, name: m.name };
}

/* ---------------- 見せる範囲（サーバーで判定） ---------------- */
const own = (v, m) => v.k === "rep" || v.id === m.id;
function canSee(v, m, page, scope) {
  if (own(v, m)) return true;
  if (m.status !== "confirmed" || page.status !== "pub") return false;
  if (scope === "all") return true;
  if (scope === "team") return v.team === m.team;
  if (scope === "lead") return v.k === "mgr" && v.team === m.team;
  return false;
}
const scopeOf = (page, k) => (page.f[k] && page.f[k].s) || FIELDS[k];
// その人に見せてよい形に削る。ownでない人には、元の発言・出どころ・同意・除外メモを渡さない
function viewPage(v, m, page) {
  const me = own(v, m);
  const open = me || (m.status === "confirmed" && page.status === "pub");
  const out = { id: m.id, status: page.status, updated: page.updated, open };
  if (!open) return out;
  const see = (k) => canSee(v, m, page, scopeOf(page, k));
  out.f = {};
  for (const [k, x] of Object.entries(page.f || {})) {
    if (!x || !x.v || !see(k)) continue;
    out.f[k] = me ? { v: x.v, s: x.s, q: x.q, src: x.src, chk: !!x.chk } : { v: x.v, s: x.s };
  }
  const x = page.x || {};
  out.x = {};
  if (see("strength")) out.x.skills = x.skills || {};
  if (see("contact")) Object.assign(out.x, { from: x.from, to: x.to, reply: x.reply });
  if (see("talkstyle")) out.x.style = x.style;
  if (see("praise")) out.x.praise = x.praise;
  if (see("busy")) out.x.busy = x.busy || [];
  out.kw = see("strength") ? page.kw || [] : [];
  out.gkw = see("gain") ? page.gkw || [] : [];
  out.tips = me || page.tips.pub ? page.tips : { v: [], pub: false };
  out.thanks = (page.thanks || []).filter((t) => me || t.pub).map((t) => ({ t: t.t, from: t.from, pub: !!t.pub }));
  if (me || (v.k === "mgr" && v.team === m.team)) out.consent = page.consent;
  if (v.k === "rep") out.excluded = page.excluded || [];
  return out;
}
// 名簿の見せ方：保留の人とGmailは代表だけ
function viewRoster(v, roster) {
  return Object.values(roster.members)
    .filter((m) => v.k === "rep" || m.status === "confirmed")
    .map((m) => ({ id: m.id, name: m.name, team: m.team, role: m.role, ret: !!m.ret, status: m.status, ...(v.k === "rep" ? { email: m.email || "" } : {}) }));
}

/* ---------------- 入力のチェック ---------------- */
function cleanField(k, x, prev) {
  const v = str(x && x.v, 300);
  const s = SCOPES.includes(x && x.s) ? x.s : (prev && prev.s) || FIELDS[k];
  const out = { v, s };
  if (prev && prev.v === v) { if (prev.q) out.q = prev.q; if (prev.src) out.src = prev.src; if (prev.chk) out.chk = prev.chk; }
  return out;
}
function cleanX(x) {
  const out = { skills: {}, busy: [] };
  if (x && typeof x.skills === "object") for (const [s, val] of Object.entries(x.skills)) if (SKILLS.includes(s) && (val === "good" || val === "try")) out.skills[s] = val;
  const h = (n) => (Number.isInteger(n) && n >= 6 && n <= 24 ? n : undefined);
  out.from = h(x && x.from); out.to = h(x && x.to);
  if (out.from !== undefined && out.to !== undefined && out.to <= out.from) out.to = Math.min(24, out.from + 1);
  if (REPLY.includes(x && x.reply)) out.reply = x.reply;
  if ([1, 2, 3, 4, 5].includes(x && x.style)) out.style = x.style;
  if (PRAISE.includes(x && x.praise)) out.praise = x.praise;
  if (x && Array.isArray(x.busy)) out.busy = [...new Set(x.busy.filter((b) => MONTHS.includes(b)))];
  return out;
}
const strList = (a, n, len) => (Array.isArray(a) ? a.map((t) => str(t, len)).filter(Boolean).slice(0, n) : []);

/* ---------------- 1on1の文字起こし → 下書き（AI） ---------------- */
const AI_KEYS = Object.keys(FIELDS).filter((k) => k !== "before" && k !== "after");
async function aiDraft(name, transcript) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error("ai off"), { status: 503, msg: "AIの設定（ANTHROPIC_API_KEY）がまだです" });
  const prompt = `あなたは学生団体NEXYの運営メンバー「取扱説明書」の下書きを作る係です。下の1on1の文字起こしから、本人（${name}さん）が自分について話したことだけを、決まった項目に振り分けてください。
ルール：話者の名前は当てにならないので、質問している側か答えている側かを文脈で判断する（自信がない項目は check を true）。質問している側の自己開示は使わない。本人の言い回しを残す。quote には根拠の元の発言を1文入れる。
外すもの：恋愛や交友、その場にいない人の名前と噂、家庭のこと、体調や健康、学校名、外見、他のメンバーについての話、受験の志望校や合否。外したものは excluded に何を外したかだけ短く書く。話していない項目は出さない。推測で埋めない。
「運営チーム内に載せて大丈夫？」への答えを consent（yes/no/unknown）に入れる。
項目：${AI_KEYS.join(", ")}
出力はJSONだけ：{"fields":{"key":{"text":"...","quote":"...","check":false}},"excluded":["..."],"consent":"unknown","note":"..."}

【文字起こし】
${transcript}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw Object.assign(new Error("ai"), { status: 502, msg: "AIの呼び出しに失敗しました" });
  const text = ((await r.json()).content || []).map((c) => c.text || "").join("");
  const o = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const fields = {};
  for (const [k, v] of Object.entries(o.fields || {})) if (AI_KEYS.includes(k) && v && str(v.text, 300)) fields[k] = { text: str(v.text, 300), quote: str(v.quote, 200), check: !!v.check };
  return { fields, excluded: strList(o.excluded, 10, 80), consent: ["yes", "no"].includes(o.consent) ? o.consent : "unknown", note: str(o.note, 200) };
}

/* ---------------- routes ---------------- */
async function route(req) {
  const url = new URL(req.url);
  const a = url.searchParams.get("a") || "";
  const s = await getStore();
  if (!s.ready) return err("保存先がまだ設定されていません", 503);

  if (a === "config") return json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "" });

  if (req.method === "POST" && (a === "login" || a === "dev_login")) {
    const b = await body(req, 10000);
    let email = null;
    if (a === "dev_login") {
      // ローカル検証専用。本番（Blob保存）では使えない
      if (!process.env.SUMMIT_FS_DIR || process.env.STAFF_DEV_LOGIN !== "1") return err("not found", 404);
      email = normEmail(b.email);
    } else email = await verifyGoogle(b.credential).catch(() => null);
    if (!email) return err("Googleアカウントを確認できませんでした", 401);
    const v = resolve(email, await readJSON(ROSTER, EMPTY_ROSTER));
    if (!v || v.none === "notfound") return err("このGmailは運営メンバーに登録されていません。運営に応募したときのGmailでログインするか、代表に連絡してください", 403);
    if (v.none === "pending") return err("まだ運営メンバーとして確定していません。確定したら入れるようになります", 403);
    return json({ ok: true, viewer: v }, 200, { "set-cookie": setCookie(sign({ e: email, x: Date.now() + AGE * 1000 })) });
  }
  if (a === "logout") return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });

  const roster = await readJSON(ROSTER, EMPTY_ROSTER);
  const v = await viewerOf(req, roster);
  if (!v || v.none) return err("ログインしてください", 401);

  if (req.method === "GET") {
    if (a === "me") return json({ viewer: v });
    if (a === "all") {
      // 名簿と、見てよい範囲に削った全員分のページ
      const list = viewRoster(v, roster);
      const pages = {};
      await Promise.all(list.map(async (m) => { pages[m.id] = viewPage(v, roster.members[m.id], await readJSON(pageKey(m.id), EMPTY_PAGE)); }));
      return json({ viewer: v, roster: list, pages });
    }
    if (a === "page") {
      const m = roster.members[url.searchParams.get("id") || ""];
      if (!m || (m.status !== "confirmed" && v.k !== "rep")) return err("見つかりません", 404);
      return json(viewPage(v, m, await readJSON(pageKey(m.id), EMPTY_PAGE)));
    }
    return err("not found", 404);
  }

  const b = await body(req);

  // 本人：自分のページを直す・公開する・非公開にする
  if (a === "page_save") {
    const m = roster.members[b.id];
    if (!m || v.id !== m.id) return err("編集できるのは本人だけです", 403);
    const page = await updateJSON(pageKey(m.id), (p) => {
      const f = {};
      for (const k of Object.keys(FIELDS)) {
        const prev = p.f[k];
        if (b.f && k in b.f) { const c = cleanField(k, b.f[k], prev); if (c.v) f[k] = c; }
        else if (prev) f[k] = prev;
      }
      p.f = f;
      if (b.x) p.x = cleanX(b.x);
      if (b.tips) p.tips = { v: [0, 1, 2].map((i) => str(b.tips.v && b.tips.v[i], 50)), pub: p.tips.pub };
      if (Array.isArray(b.thanksPub)) p.thanks.forEach((t, i) => { t.pub = !!b.thanksPub[i]; });
      if (b.publish) {
        if (b.consent !== true) throw Object.assign(new Error("consent"), { status: 400, msg: "公開するには、運営チーム内に載せることへの同意が必要です" });
        p.consent = "yes"; p.status = "pub"; p.tips.pub = p.tips.v.some(Boolean);
        Object.values(p.f).forEach((x) => { delete x.chk; delete x.src; });
      }
      if (b.unpublish) p.status = "draft";
      p.updated = Date.now();
    }, EMPTY_PAGE);
    return json(viewPage(v, m, page));
  }

  // 代表・管理職（自分のチームのほかの人）：1on1の文字起こしから下書きを作る。文字起こしは保存しない
  const canDraft = (m) => m && m.status === "confirmed" && (v.k === "rep" || (v.k === "mgr" && v.team === m.team && v.id !== m.id));
  if (a === "draft_ai") {
    const m = roster.members[b.id];
    if (!canDraft(m)) return err("この人の下書きは作れません", 403);
    const t = str(b.transcript, 60000);
    if (!t) return err("文字起こしを貼り付けてください");
    return json(await aiDraft(m.name, t));
  }
  if (a === "draft_save") {
    const m = roster.members[b.id];
    if (!canDraft(m)) return err("この人の下書きは作れません", 403);
    const page = await updateJSON(pageKey(m.id), (p) => {
      for (const [k, x] of Object.entries(b.fields || {})) {
        if (!(k in FIELDS) || !str(x && x.text, 300)) continue;
        p.f[k] = { v: str(x.text, 300), s: (p.f[k] && p.f[k].s) || FIELDS[k], q: str(x.quote, 200), src: "1on1", chk: !!x.check };
      }
      if (["yes", "no", "unknown"].includes(b.consent)) p.consent = b.consent;
      p.excluded = strList(b.excluded, 10, 80);
      p.status = "draft"; // 本人がもう一度確認して公開する
      p.updated = Date.now();
    }, EMPTY_PAGE);
    return json(viewPage(v, m, page));
  }

  // ここから下は代表だけ
  if (v.k !== "rep") return err("代表だけが使えます", 403);

  // 名簿の追加・変更（確定⇄保留、チーム・役職・Gmail）
  if (a === "roster_upsert") {
    const id = b.id && roster.members[b.id] ? b.id : newId();
    const name = str(b.name, 20);
    if (!name) return err("名前を入れてください");
    if (!TEAMS.includes(b.team)) return err("チームを選んでください");
    const role = ROLES.includes(b.role) ? b.role : "メンバー";
    const status = STATUS.includes(b.status) ? b.status : "pending";
    const email = normEmail(b.email);
    if (email && !/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i.test(email)) return err("Gmailの形が正しくありません");
    let warn = "";
    const r = await updateJSON(ROSTER, (d) => {
      if (email && Object.values(d.members).some((x) => x.id !== id && normEmail(x.email) === email)) throw Object.assign(new Error("dup"), { status: 409, msg: "このGmailは、もう別の人に登録されています" });
      if (status === "confirmed" && isMgr(role) && Object.values(d.members).some((x) => x.id !== id && x.status === "confirmed" && x.team === b.team && x.role === role)) warn = `${role}がすでにいます。2人にする場合はこのままで大丈夫です`;
      d.members[id] = { id, name, team: b.team, role, status, email, ret: !!b.ret, updated: Date.now() };
    }, EMPTY_ROSTER);
    return json({ ok: true, member: r.members[id], warn });
  }
  // 名簿から外す（運営を抜けた）：ページも消す
  if (a === "roster_remove") {
    if (!roster.members[b.id]) return err("見つかりません", 404);
    await updateJSON(ROSTER, (d) => { delete d.members[b.id]; }, EMPTY_ROSTER);
    await s.del(pageKey(b.id));
    return json({ ok: true });
  }
  // 最初の取り込み：応募フォームなどから作った下書きを、名簿が空のときに一度だけ入れる
  if (a === "bootstrap") {
    if (Object.keys(roster.members).length) return err("名簿がすでにあります。1人ずつ追加してください", 409);
    const list = Array.isArray(b.members) ? b.members.slice(0, 200) : [];
    const ids = {};
    await updateJSON(ROSTER, (d) => {
      for (const x of list) {
        const name = str(x.name, 20);
        if (!name || !TEAMS.includes(x.team)) continue;
        const id = newId(); ids[x.ref || name] = id;
        d.members[id] = { id, name, team: x.team, role: ROLES.includes(x.role) ? x.role : "メンバー", status: STATUS.includes(x.status) ? x.status : "pending", email: normEmail(x.email), ret: !!x.ret, updated: Date.now() };
      }
    }, EMPTY_ROSTER);
    for (const x of list) {
      const id = ids[x.ref || str(x.name, 20)];
      if (!id || !x.page) continue;
      const p = structuredClone(EMPTY_PAGE);
      for (const [k, fx] of Object.entries(x.page.f || {})) if (k in FIELDS && str(fx && fx.v, 300)) p.f[k] = { v: str(fx.v, 300), s: SCOPES.includes(fx.s) ? fx.s : FIELDS[k], src: fx.src === "1on1" ? "1on1" : "form" };
      p.x = cleanX(x.page.x || {});
      p.kw = strList(x.page.kw, 8, 30); p.gkw = strList(x.page.gkw, 8, 30);
      p.thanks = (Array.isArray(x.page.thanks) ? x.page.thanks : []).slice(0, 12).map((t) => ({ t: str(t.t || t, 400), from: "2026 運営の仲間より", pub: false })).filter((t) => t.t);
      p.excluded = strList(x.page.excluded, 10, 80);
      p.updated = Date.now();
      await s.write(pageKey(id), JSON.stringify(p));
    }
    return json({ ok: true, count: Object.keys(ids).length });
  }
  return err("not found", 404);
}

async function safe(req) {
  try { return await route(req); } catch (e) {
    if (e.msg) return err(e.msg, e.status || 400);
    console.error("staff api", e && e.message);
    return err(e.status === 413 ? "データが大きすぎます" : "うまく処理できませんでした。少し待ってもう一度お試しください", e.status || 500);
  }
}
export const GET = safe;
export const POST = safe;
