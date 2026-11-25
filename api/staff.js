// NEXY 運営メンバー取扱説明書のAPI（/api/staff?a=...）
// データはVercel Blob（private）に保存する。公開リポジトリなので、メンバーの情報はコードに書かない。
//   staff/roster.json      運営メンバー名簿（確定・保留）。代表だけが書き換える
//   staff/pages/<id>.json  一人ひとりの取扱説明書（最初から運営メンバーに公開。本人がいつでも書き換え・非公開にできる）
//   staff/photos/<id>.jpg  顔写真（必須。運営メンバーだけが見られる）
//   staff/auth/<hash>.json ログイン用の確認コード・失敗回数
//   staff/settings.json    証明書の発行を始めたか（代表が切り替える）
// ログイン：応募フォームに書いたメールアドレス＋自分で作るパスワード。
//   初回とパスワードを忘れたときは、そのアドレスに届く6桁のコードで本人確認してからパスワードを作る。
//   メールアドレスは名簿に「ハッシュ」でしか保存しない。代表も含めて、誰も画面やAPIでアドレスを見られない。
//   パスワードは scrypt でハッシュ化して保存。Cookie(nxs)にはメンバーIDとパスワードの版だけを入れて署名する。
// 権限は3つ：代表（rep）／管理職＝統括・サブ統括（mgr）／メンバー（mem）。見せる範囲の判定はすべてサーバーで行う。
// 環境変数：AUTH_SECRET（必須・一度決めたら変えない。メールのハッシュにも使う）、OWNER_EMAILS（代表のアドレス）、
//   RESEND_API_KEY・MAIL_FROM（コードのメール送信）、ANTHROPIC_API_KEY・ANTHROPIC_MODEL（1on1の下書き。任意）
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
const TEAMS = ["a", "b", "perm", "media", "rec", "guide", "hq"]; // hq＝代表
const ROLES = ["統括", "サブ統括", "メンバー", "代表"];
const STATUS = ["confirmed", "pending"]; // 確定／保留。保留の人はログインできず、ページも代表にしか見えない
const SCOPES = ["all", "team", "lead"];   // 全員／チーム内／管理職まで
// key → 公開範囲の初期設定
// 見られる範囲は項目ごとに固定（本人も代表も変えられない）
const FIELDS = { dream: "all", reason: "all", gain: "all", future: "all", strength: "all", weak: "lead", challenge: "lead", history: "all",
  please: "all", ng: "all", before: "all", after: "all" };
const SKILLS = ["企画", "段取り", "デザイン", "写真・動画", "SNS発信", "文章", "人前で話す", "話を聞く", "数字・お金", "IT・ツール"];
const ROSTER = "staff/roster.json", EMPTY_ROSTER = { members: {} };
const SETTINGS = "staff/settings.json", EMPTY_SETTINGS = { certOpen: false };
const pageKey = (id) => `staff/pages/${id}.json`;
const EMPTY_PAGE = { status: "pub", cert: { duty: "", items: [], result: "", comment: "", by: null }, consent: "unknown", f: {}, x: { skills: {} }, kw: [], gkw: [], thanks: [], excluded: [], updated: 0 };
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

// メールアドレスは保存しない。秘密の鍵でハッシュにしたものだけを名簿に持つ
const emailHash = (email) => hmac("email:" + normEmail(email));
const validEmail = (e) => e.length <= 254 && /^[^\s@,;<>]{1,64}@[^\s@,;<>]+\.[a-z]{2,}$/i.test(e);
// パスワード（scrypt）
const PW_MIN = 8;
function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString("base64") + "." + crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64"); }
function checkPw(pw, stored) {
  const [salt, h] = String(stored || "").split(".");
  if (!salt || !h) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), 32, { N: 16384, r: 8, p: 1 }), b = Buffer.from(h, "base64");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function pwProblem(pw) {
  pw = String(pw || "");
  if (pw.length < PW_MIN) return `パスワードは${PW_MIN}文字以上にしてください`;
  if (pw.length > 200) return "パスワードが長すぎます";
  if (/^(.)\1+$/.test(pw) || /^(0123|1234|abcd|pass)/i.test(pw)) return "推測されやすいパスワードです。別のものにしてください";
  return "";
}
// メール送信（summit.js と同じ Resend）。ローカル検証ではファイルに書く
async function sendMail(to, subject, text) {
  if (process.env.SUMMIT_FS_DIR && !process.env.RESEND_API_KEY) { await (await getStore()).write(`mail/${emailHash(to)}.txt`, subject + "\n" + text); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM || "NEXY <noreply@nexyhub.jp>", to: [to], subject, text }),
  });
  if (!r.ok) throw Object.assign(new Error("mail"), { status: 502, msg: "メールを送れませんでした。少し待ってもう一度お試しください" });
}
const mailReady = () => !!(process.env.RESEND_API_KEY || process.env.SUMMIT_FS_DIR);
const authKey = (eh) => `staff/auth/${eh.slice(0, 40)}.json`;
const LOCK = { max: 8, ms: 15 * 60000 };

// 名簿からメールアドレスの人を探す。代表（OWNER_EMAILS）は名簿にいなければここで作る
async function findByEmail(email) {
  const eh = emailHash(email);
  let roster = await readJSON(ROSTER, EMPTY_ROSTER);
  let m = Object.values(roster.members).find((x) => x.eh === eh);
  if (!m && owners().includes(normEmail(email))) {
    roster = await updateJSON(ROSTER, (d) => {
      if (Object.values(d.members).some((x) => x.eh === eh)) return false;
      const rep = Object.values(d.members).find((x) => x.role === "代表" && !x.eh);
      if (rep) { rep.eh = eh; return; }
      const id = newId();
      d.members[id] = { id, name: "代表", team: "hq", role: "代表", status: "confirmed", eh, updated: Date.now() };
    }, EMPTY_ROSTER);
    m = Object.values(roster.members).find((x) => x.eh === eh);
  }
  return { m, eh };
}
const cookieFor = (m) => setCookie(sign({ i: m.id, pv: m.pwv || 0, x: Date.now() + AGE * 1000 }));
// ログイン中の人。名簿から毎回引き直す（保留に戻された・外された・パスワードを変えた場合は、その場で無効）
async function viewerOf(req, roster) {
  const o = verifyCookie(cookies(req).nxs);
  if (!o) return null;
  const m = roster.members[o.i];
  if (!m || m.status !== "confirmed" || (m.pwv || 0) !== o.pv) return null;
  return { k: m.role === "代表" ? "rep" : isMgr(m.role) ? "mgr" : "mem", id: m.id, team: m.team, name: m.name };
}
const NOPE = "このメールアドレスでは入れません。応募フォームに書いたメールアドレスか確かめてください。わからないときは代表に連絡してください";

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
  out.x = { skills: see("strength") ? (page.x && page.x.skills) || {} : {} };
  out.kw = see("strength") ? page.kw || [] : [];
  out.gkw = see("gain") ? page.gkw || [] : [];
  out.thanks = (page.thanks || []).filter((t) => me || t.pub).map((t) => ({ t: t.t, from: t.from, pub: !!t.pub }));
  if (me || (v.k === "mgr" && v.team === m.team)) out.consent = page.consent;
  if (v.k === "rep") out.excluded = page.excluded || [];
  const c = page.cert || {};
  if (me) out.cert = { duty: c.duty || "", items: c.items || [], result: c.result || "", comment: c.comment || "", by: c.by || null };
  // 証明書の所見を書く人（代表・同じチームの管理職）には、本人が書いた活動内容と所見を見せる
  else if (m.status === "confirmed" && (v.k === "rep" || (v.k === "mgr" && v.team === m.team))) out.cert = { duty: c.duty || "", items: c.items || [], result: c.result || "", comment: c.comment || "", by: c.by || null };
  return out;
}
// 名簿の見せ方：保留の人とGmailは代表だけ
function viewRoster(v, roster) {
  return Object.values(roster.members)
    .filter((m) => v.k === "rep" || m.status === "confirmed")
    .map((m) => ({ id: m.id, name: m.name, kana: m.kana || "", kanaOk: !!m.kanaOk, nick: m.nick || "", pv: m.pv || 0, team: m.team, role: m.role, ret: !!m.ret, status: m.status, ...(v.k === "rep" ? { hasEmail: !!m.eh, hasPassword: !!m.pw } : {}) }));
}

/* ---------------- 入力のチェック ---------------- */
function cleanField(k, x, prev) {
  const v = str(x && x.v, 300);
  const s = (prev && prev.s) || FIELDS[k]; // 見られる範囲は変えさせない
  const out = { v, s };
  if (prev && prev.v === v) { if (prev.q) out.q = prev.q; if (prev.src) out.src = prev.src; if (prev.chk) out.chk = prev.chk; }
  return out;
}
function cleanX(x) {
  const out = { skills: {} };
  if (x && typeof x.skills === "object") for (const [k, val] of Object.entries(x.skills)) if (SKILLS.includes(k) && (val === "good" || val === "try")) out.skills[k] = val;
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

  if (req.method === "POST" && a === "dev_login") {
    // ローカル検証専用。本番（Blob保存）では使えない
    if (!process.env.SUMMIT_FS_DIR || process.env.STAFF_DEV_LOGIN !== "1") return err("not found", 404);
    const { m } = await findByEmail((await body(req, 10000)).email);
    if (!m || m.status !== "confirmed") return err(NOPE, 403);
    return json({ ok: true }, 200, { "set-cookie": cookieFor(m) });
  }
  // ① メールアドレスを入れる → パスワードがあれば「パスワード」、まだなら「確認コード」へ
  if (req.method === "POST" && (a === "login_start" || a === "reset_start")) {
    const email = normEmail((await body(req, 10000)).email);
    if (!validEmail(email)) return err("メールアドレスの形を確かめてください");
    const { m, eh } = await findByEmail(email);
    if (!m || m.status !== "confirmed") { await new Promise((r) => setTimeout(r, 500)); return err(NOPE, 403); }
    if (a === "login_start" && m.pw) return json({ next: "password" });
    if (!mailReady()) return err("メール送信の設定がまだです。代表に連絡してください", 503);
    const cur = await s.read(authKey(eh));
    const old = cur ? JSON.parse(cur.body.toString("utf8")) : {};
    if (old.sentAt && Date.now() - old.sentAt < 60000) return json({ next: "code", resent: false });
    const c = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await s.write(authKey(eh), JSON.stringify({ ...old, h: hmac("code:" + eh + ":" + c), exp: Date.now() + 10 * 60000, tries: 0, sentAt: Date.now() }));
    await sendMail(email, `NEXY 運営ログインの確認コード ${c}`,
      `NEXY 運営メンバーの確認コードです。\n\n${c}\n\n画面にこの6桁を入れて、パスワードを作ってください。10分間有効です。\n心当たりがない場合は、このメールは無視してください。\n\n学生団体NEXY`);
    return json({ next: "code" });
  }
  // ② 確認コード → パスワードを作るための15分だけ有効な札を返す
  if (req.method === "POST" && a === "code_verify") {
    const b = await body(req, 10000);
    const email = normEmail(b.email), c = String(b.code || "").replace(/\D/g, "");
    const { m, eh } = await findByEmail(email);
    if (!m || m.status !== "confirmed") return err(NOPE, 403);
    const cur = await s.read(authKey(eh));
    const st = cur ? JSON.parse(cur.body.toString("utf8")) : null;
    if (!st || !st.h || st.exp < Date.now()) return err("コードの期限が切れました。もう一度送ってください", 400);
    if (st.tries >= 5) return err("間違いが多すぎます。コードを送り直してください", 429);
    const ok = st.h === hmac("code:" + eh + ":" + c);
    await s.write(authKey(eh), JSON.stringify(ok ? { ...st, h: null } : { ...st, tries: st.tries + 1 }));
    if (!ok) return err("コードが違います", 400);
    return json({ setup: sign({ k: "setup", i: m.id, x: Date.now() + 15 * 60000 }) });
  }
  // ③ パスワードを作る（初回・忘れたとき）→ ログイン
  if (req.method === "POST" && a === "password_set") {
    const b = await body(req, 10000);
    const t = verifyCookie(b.setup);
    if (!t || t.k !== "setup") return err("時間が経ちすぎました。最初からやり直してください", 400);
    const bad = pwProblem(b.password);
    if (bad) return err(bad);
    const h = hashPw(String(b.password));
    const r = await updateJSON(ROSTER, (d) => { const m = d.members[t.i]; if (!m || m.status !== "confirmed") return false; m.pw = h; m.pwv = (m.pwv || 0) + 1; }, EMPTY_ROSTER);
    const m = r.members[t.i];
    if (!m || m.pw !== h) return err(NOPE, 403);
    if (m.eh) await s.del(authKey(m.eh));
    return json({ ok: true }, 200, { "set-cookie": cookieFor(m) });
  }
  // ④ 2回目からはメールアドレス＋パスワード。8回続けて間違えたら15分止める
  if (req.method === "POST" && a === "login_password") {
    const b = await body(req, 10000);
    const { m, eh } = await findByEmail(b.email);
    if (!m || m.status !== "confirmed" || !m.pw) { await new Promise((r) => setTimeout(r, 500)); return err("メールアドレスかパスワードが違います", 401); }
    const cur = await s.read(authKey(eh));
    const st = cur ? JSON.parse(cur.body.toString("utf8")) : {};
    if (st.lockUntil && st.lockUntil > Date.now()) return err("間違いが続いたため、15分ほど入れません。パスワードを忘れたときは「パスワードを忘れた」から作り直してください", 429);
    if (!checkPw(b.password, m.pw)) {
      const fails = (st.fails || 0) + 1;
      await s.write(authKey(eh), JSON.stringify({ ...st, fails: fails >= LOCK.max ? 0 : fails, lockUntil: fails >= LOCK.max ? Date.now() + LOCK.ms : 0 }));
      return err("メールアドレスかパスワードが違います", 401);
    }
    if (st.fails || st.lockUntil) await s.write(authKey(eh), JSON.stringify({ ...st, fails: 0, lockUntil: 0 }));
    return json({ ok: true }, 200, { "set-cookie": cookieFor(m) });
  }
  if (a === "logout") return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });

  const roster = await readJSON(ROSTER, EMPTY_ROSTER);
  const v = await viewerOf(req, roster);
  if (!v) return err("ログインしてください", 401);

  if (req.method === "GET") {
    if (a === "me") return json({ viewer: v, needsPhoto: !(roster.members[v.id] || {}).pv });
    if (a === "all") {
      // 名簿と、見てよい範囲に削った全員分のページ
      const list = viewRoster(v, roster);
      const pages = {};
      await Promise.all(list.map(async (m) => { pages[m.id] = viewPage(v, roster.members[m.id], await readJSON(pageKey(m.id), EMPTY_PAGE)); }));
      return json({ viewer: v, roster: list, pages });
    }
    if (a === "photo") {
      const m = roster.members[url.searchParams.get("id") || ""];
      if (!m || (m.status !== "confirmed" && v.k !== "rep")) return err("見つかりません", 404);
      const f = await s.read(`staff/photos/${m.id}.jpg`);
      if (!f) return err("見つかりません", 404);
      return new Response(f.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=300" } });
    }
    if (a === "settings") return json(await readJSON(SETTINGS, EMPTY_SETTINGS));
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
      if (Array.isArray(b.thanksPub)) p.thanks.forEach((t, i) => { t.pub = !!b.thanksPub[i]; });
      if (b.cert) p.cert = { ...(p.cert || {}), duty: str(b.cert.duty, 160), items: strList(b.cert.items, 5, 60), result: str(b.cert.result, 120) };
      if (b.publish) {
        p.status = "pub";
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
      // 公開の状態は変えない。本人がいつでも書き換えられる
      p.updated = Date.now();
    }, EMPTY_PAGE);
    return json(viewPage(v, m, page));
  }

  // 本人：名前・ふりがな・呼び名・顔写真
  if (a === "profile_save") {
    const name = str(b.name, 20);
    if (!name) return err("名前を入れてください");
    let photo = null;
    if (b.photo === null) photo = "";
    else if (typeof b.photo === "string") {
      const mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.photo);
      if (!mm) return err("この画像は使えません");
      photo = Buffer.from(mm[2], "base64");
      if (photo.length > 300000) return err("画像が大きすぎます");
    }
    if (photo && photo.length) await s.write(`staff/photos/${v.id}.jpg`, photo);
    if (photo === "") await s.del(`staff/photos/${v.id}.jpg`);
    const r = await updateJSON(ROSTER, (d) => {
      const m = d.members[v.id]; if (!m) return false;
      m.name = name; m.kana = str(b.kana, 30); m.kanaOk = !!m.kana; m.nick = str(b.nick, 20);
      if (photo !== null) m.pv = photo.length ? (m.pv || 0) + 1 : 0;
      m.updated = Date.now();
    }, EMPTY_ROSTER);
    return json({ ok: true, member: r.members[v.id] ? viewRoster(v, { members: { [v.id]: r.members[v.id] } })[0] : null });
  }
  // 本人：運営参加証明書の中身（発行は代表が始めたあとだけ）
  // 証明書の所見：代表か、同じチームの統括・サブ統括が書く（本人は書けない）
  if (a === "cert_comment") {
    const m = roster.members[b.id];
    if (!canDraft(m)) return err("この人の所見は書けません", 403);
    const w = roster.members[v.id];
    await updateJSON(pageKey(m.id), (p) => {
      const t = str(b.comment, 300);
      p.cert = { ...(p.cert || {}), comment: t, by: t ? { name: w ? w.name : "", role: w ? w.role : "", team: w ? w.team : "" } : null };
    }, EMPTY_PAGE);
    return json({ ok: true });
  }

  if (a === "certificate") {
    const m = roster.members[v.id];
    if (!m || v.k === "rep") return err("証明書は運営メンバー本人が発行します", 403);
    const st = await readJSON(SETTINGS, EMPTY_SETTINGS);
    const page = await readJSON(pageKey(m.id), EMPTY_PAGE);
    const no = "NEXY27-" + String(parseInt(crypto.createHash("sha256").update("cert:" + m.id).digest("hex").slice(0, 8), 16) % 100000).padStart(5, "0");
    const c = page.cert || {};
    const good = Object.entries((page.x && page.x.skills) || {}).filter(([, l]) => l === "good").map(([k]) => k);
    return json({ sample: !st.certOpen, no, name: m.name, kana: m.kana || "", team: m.team, role: m.role, ret: !!m.ret,
      duty: c.duty || "", items: c.items || [], result: c.result || "", comment: c.comment || "", by: c.by || null,
      skills: good, kw: page.kw || [], strength: (page.f && page.f.strength && page.f.strength.v) || "", issuedAt: Date.now() });
  }

  // ここから下は代表だけ
  if (v.k !== "rep") return err("代表だけが使えます", 403);

  if (a === "settings") {
    const st = await updateJSON(SETTINGS, (d) => { if (typeof b.certOpen === "boolean") d.certOpen = b.certOpen; }, EMPTY_SETTINGS);
    return json(st);
  }

  // 名簿の追加・変更（確定⇄保留、チーム・役職・Gmail）
  if (a === "roster_upsert") {
    const id = b.id && roster.members[b.id] ? b.id : newId();
    const name = str(b.name, 20);
    if (!name) return err("名前を入れてください");
    if (!TEAMS.includes(b.team)) return err("チームを選んでください");
    const role = ROLES.includes(b.role) ? b.role : "メンバー";
    const status = STATUS.includes(b.status) ? b.status : "pending";
    const email = normEmail(b.email); // 入れたときだけ更新。保存するのはハッシュだけ
    if (email && !validEmail(email)) return err("メールアドレスの形が正しくありません");
    const eh = email ? emailHash(email) : null;
    let warn = "";
    const r = await updateJSON(ROSTER, (d) => {
      if (eh && Object.values(d.members).some((x) => x.id !== id && x.eh === eh)) throw Object.assign(new Error("dup"), { status: 409, msg: "このメールアドレスは、もう別の人に登録されています" });
      if (status === "confirmed" && isMgr(role) && Object.values(d.members).some((x) => x.id !== id && x.status === "confirmed" && x.team === b.team && x.role === role)) warn = `${role}がすでにいます。2人にする場合はこのままで大丈夫です`;
      const prev = d.members[id] || {};
      d.members[id] = { ...prev, id, name, kana: b.kana !== undefined ? str(b.kana, 30) : prev.kana || "", team: b.team, role, status, ret: !!b.ret, updated: Date.now() };
      delete d.members[id].email;
      if (eh) { if (d.members[id].eh !== eh) { delete d.members[id].pw; d.members[id].pwv = (prev.pwv || 0) + 1; } d.members[id].eh = eh; }
    }, EMPTY_ROSTER);
    return json({ ok: true, member: viewRoster(v, { members: { [id]: r.members[id] } })[0], warn });
  }
  // 名簿から外す（運営を抜けた）：ページも消す
  if (a === "roster_remove") {
    if (!roster.members[b.id]) return err("見つかりません", 404);
    await updateJSON(ROSTER, (d) => { delete d.members[b.id]; }, EMPTY_ROSTER);
    await s.del(pageKey(b.id));
    return json({ ok: true });
  }
  // 取り込み：応募フォームとチーム編成から作ったファイルを入れる。何度でも使える（週1などで追加分を入れる）。
  // ・同じ人（メールアドレス、なければ名前で照合）は名簿の項目（チーム・役職・確定/保留）だけ更新し、重複させない
  // ・取扱説明書は、本人がまだ書いていない項目だけを埋める。本人が書いた文章は上書きしない
  if (a === "bootstrap") {
    const list = Array.isArray(b.members) ? b.members.slice(0, 300) : [];
    const ids = {}, made = new Set();
    let added = 0, updated = 0;
    await updateJSON(ROSTER, (d) => {
      const all = Object.values(d.members);
      for (const x of list) {
        const name = str(x.name, 20);
        if (!name || !TEAMS.includes(x.team)) continue;
        const key = x.ref || name;
        const email = normEmail(x.email), eh = validEmail(email) ? emailHash(email) : "";
        let m = x.role === "代表" ? all.find((q) => q.role === "代表") : null;
        if (!m && eh) m = all.find((q) => q.eh === eh);
        // メールで見つからないときは名前で照合する（前回の取り込みでメールがつながらなかった人も、ここで付け直せる）
        if (!m) m = all.find((q) => q.name === name && q.role !== "代表");
        if (m) {
          if (x.role !== "代表") Object.assign(m, { team: x.team, role: ROLES.includes(x.role) && x.role !== "代表" ? x.role : "メンバー", status: STATUS.includes(x.status) ? x.status : m.status });
          if (str(x.kana, 30)) Object.assign(m, { kana: str(x.kana, 30), kanaOk: !!x.kanaOk });
          if (str(x.nick, 20) && !m.nick) m.nick = str(x.nick, 20);
          if (eh && m.eh !== eh && !all.some((q) => q !== m && q.eh === eh)) { m.eh = eh; delete m.pw; }
          m.ret = !!x.ret; m.name = name; m.updated = Date.now();
          ids[key] = m.id; updated++;
          continue;
        }
        if (eh && all.some((q) => q.eh === eh)) continue;
        const id = newId(); ids[key] = id; made.add(id); added++;
        m = { id, name, kana: str(x.kana, 30), kanaOk: !!x.kanaOk, nick: str(x.nick, 20), team: x.team, role: ROLES.includes(x.role) && x.role !== "代表" ? x.role : "メンバー", status: STATUS.includes(x.status) ? x.status : "pending", ...(eh ? { eh } : {}), ret: !!x.ret, updated: Date.now() };
        d.members[id] = m; all.push(m);
      }
    }, EMPTY_ROSTER);
    for (const x of list) {
      const id = ids[x.ref || str(x.name, 20)];
      if (!id || !x.page) continue;
      const fresh = made.has(id);
      await updateJSON(pageKey(id), (p) => {
        for (const [k, fx] of Object.entries(x.page.f || {})) {
          if (!(k in FIELDS) || !str(fx && fx.v, 300) || (p.f[k] && p.f[k].v)) continue;
          p.f[k] = { v: str(fx.v, 300), s: FIELDS[k], src: fx.src === "1on1" ? "1on1" : "form" };
        }
        if (fresh || !Object.keys((p.x && p.x.skills) || {}).length) p.x = cleanX(x.page.x || {});
        if (!(p.kw || []).length) p.kw = strList(x.page.kw, 8, 30);
        if (!(p.gkw || []).length) p.gkw = strList(x.page.gkw, 8, 30);
        if (!(p.thanks || []).length) p.thanks = (Array.isArray(x.page.thanks) ? x.page.thanks : []).slice(0, 12).map((t) => ({ t: str(t.t || t, 400), from: "2026 運営の仲間より", pub: true })).filter((t) => t.t);
        if (!(p.excluded || []).length) p.excluded = strList(x.page.excluded, 10, 80);
        p.updated = Date.now();
      }, EMPTY_PAGE);
    }
    return json({ ok: true, count: added + updated, added, updated });
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
