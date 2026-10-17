// NEXY SUMMIT 2027 当日ガイドのAPI（/api/summit?a=...）
// データはVercel Blob（private）に保存する。
//   db/people.json   参加者一覧（id → プロフィール。写真は別ファイル）
//   db/notices.json  お知らせ一覧
//   prefs/<id>.json  各参加者の予定・話したい人・既読
//   photos/<id>.jpg  顔写真
// 参加者の本人確認：登録時に発行する「引き継ぎコード」をCookie(nx)に保存。idはコードのハッシュ。
// 管理者：環境変数 ADMIN_PASSWORD でログインし、署名付きCookie(nxa)を保存。
import crypto from "node:crypto";

const COOKIE_AGE = 400 * 24 * 3600; // Chromeの上限
const TAGS = ["起業・ビジネス", "国際・留学", "地域・まちづくり", "教育・学び", "AI・テック", "アート・発信", "社会課題・環境", "その他"];
const KINDS = ["info", "change", "important"];
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字を除いた32文字

/* ---------------- storage ---------------- */
let store;
async function getStore() {
  if (store) return store;
  if (process.env.SUMMIT_FS_DIR) {
    // ローカル検証用：ファイルに保存する
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = process.env.SUMMIT_FS_DIR;
    const p = (k) => path.join(root, k);
    const etagOf = (buf) => crypto.createHash("md5").update(buf).digest("hex");
    store = {
      async read(key) {
        try { const b = await fs.readFile(p(key)); return { body: b, etag: etagOf(b) }; } catch { return null; }
      },
      async write(key, body, { ifMatch, contentType } = {}) {
        if (ifMatch !== undefined) {
          const cur = await this.read(key);
          if ((cur ? cur.etag : "") !== ifMatch) { const e = new Error("precondition"); e.precondition = true; throw e; }
        }
        await fs.mkdir(path.dirname(p(key)), { recursive: true });
        await fs.writeFile(p(key), body);
      },
      async del(key) { try { await fs.unlink(p(key)); } catch {} },
      ready: true,
    };
    return store;
  }
  const blob = await import("@vercel/blob");
  const ready = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
  store = {
    ready,
    async read(key) {
      const r = await blob.get(key, { access: "private", useCache: false }).catch((e) => {
        if (e instanceof blob.BlobNotFoundError) return null;
        throw e;
      });
      if (!r || r.statusCode !== 200) return null;
      const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
      return { body: buf, etag: r.blob.etag, contentType: r.blob.contentType };
    },
    async write(key, body, { ifMatch, contentType } = {}) {
      const opt = { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: contentType || "application/json", cacheControlMaxAge: 60 };
      if (ifMatch) opt.ifMatch = ifMatch;
      try { await blob.put(key, body, opt); } catch (e) {
        if (e instanceof blob.BlobPreconditionFailedError) { const x = new Error("precondition"); x.precondition = true; throw x; }
        throw e;
      }
    },
    async del(key) { try { await blob.del(key); } catch {} },
  };
  return store;
}

// JSONファイルを楽観ロックで更新する（同時に書き込まれても取りこぼさない）
async function updateJSON(key, fn, empty) {
  const s = await getStore();
  for (let i = 0; i < 6; i++) {
    const cur = await s.read(key);
    const data = cur ? JSON.parse(cur.body.toString("utf8")) : structuredClone(empty);
    const out = fn(data);
    if (out === false) return data; // 変更なし
    const body = JSON.stringify(data);
    try {
      await s.write(key, body, { ifMatch: cur ? cur.etag : undefined });
      cache.delete(key);
      return data;
    } catch (e) {
      if (!e.precondition) throw e;
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
    }
  }
  throw new Error("busy");
}

const cache = new Map(); // 同じ関数インスタンス内で数秒だけ使い回し、保存先への読み込み回数を減らす
async function readJSON(key, empty, ttl = 8000) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const s = await getStore();
  const cur = await s.read(key);
  const v = cur ? JSON.parse(cur.body.toString("utf8")) : structuredClone(empty);
  cache.set(key, { t: Date.now(), v });
  return v;
}

/* ---------------- helpers ---------------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);

function cookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const setCookie = (name, val, age = COOKIE_AGE) => `${name}=${encodeURIComponent(val)}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const validCode = (c) => c.length === 12 && [...c].every((ch) => ALPH.includes(ch));
const idOf = (code) => crypto.createHash("sha256").update("nexy27:" + code).digest("hex").slice(0, 24);
function newCode() {
  const b = crypto.randomBytes(12);
  return [...b].map((x) => ALPH[x % 32]).join("");
}
const fmtCode = (c) => c.match(/.{1,4}/g).join("-");
function secret() {
  return crypto.createHash("sha256").update("nx-admin:" + (process.env.ADMIN_PASSWORD || "") + ":" + (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || "")).digest();
}
const adminSig = () => crypto.createHmac("sha256", secret()).update("admin-v1").digest("hex");
function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const v = cookies(req).nxa || "";
  const a = Buffer.from(v), b = Buffer.from(adminSig());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function codeOf(req) {
  const c = normCode(cookies(req).nx || req.headers.get("x-nx-code") || "");
  return validCode(c) ? c : null;
}

const str = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const handle = (v) => {
  v = String(v || "").trim().replace(/^https?:\/\/(www\.)?(instagram\.com|x\.com|twitter\.com|tiktok\.com)\/@?/i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v : "";
};
const TAG_OLD = { 起業: "起業・ビジネス", 国際: "国際・留学", 地域: "地域・まちづくり", 教育: "教育・学び", AI: "AI・テック" };
function cleanProfile(b) {
  const p = {
    name: str(b.name, 20), title: str(b.title, 30), doing: str(b.doing, 100), want: str(b.want, 40),
    tags: [...new Set((Array.isArray(b.tags) ? b.tags : []).map((t) => TAG_OLD[t] || t).filter((t) => TAGS.includes(t)))].slice(0, 3),
    ig: handle(b.ig), x: handle(b.x), tt: handle(b.tt), open: b.open !== false,
  };
  if (!p.name || !p.title || !p.doing) return null;
  return p;
}
async function body(req, max = 400000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("too large"), { status: 413 });
  try { return JSON.parse(t || "{}"); } catch { return {}; }
}
const publicPerson = (id, p) => ({ id, name: p.name, title: p.title, doing: p.doing, want: p.want, tags: p.tags, ig: p.ig, x: p.x, tt: p.tt, open: !!p.open, pv: p.pv || 0, updatedAt: p.updatedAt });

const PEOPLE = "db/people.json", NOTICES = "db/notices.json";
const EMPTY_PEOPLE = { people: {} }, EMPTY_NOTICES = { notices: [] };

/* ---------------- routes ---------------- */
async function route(req) {
  const url = new URL(req.url);
  const a = url.searchParams.get("a") || "";
  const s = await getStore();
  if (!s.ready) return err("保存先がまだ設定されていません", 503);
  const admin = isAdmin(req);
  const code = codeOf(req);
  const id = code ? idOf(code) : null;

  if (req.method === "GET") {
    if (a === "me") {
      const db = await readJSON(PEOPLE, EMPTY_PEOPLE, 3000);
      const mine = id && db.people[id] ? publicPerson(id, db.people[id]) : null;
      let prefs = null;
      if (mine) { const r = await s.read(`prefs/${id}.json`); prefs = r ? JSON.parse(r.body.toString("utf8")) : null; }
      return json({ me: mine, code: mine ? fmtCode(code) : null, prefs, role: admin ? "admin" : mine ? "member" : "guest", count: Object.keys(db.people).length });
    }
    if (a === "people") {
      const db = await readJSON(PEOPLE, EMPTY_PEOPLE);
      const member = admin || (id && db.people[id]);
      const count = Object.keys(db.people).length;
      if (!member) {
        const wants = Object.values(db.people).map((p) => p.want).filter((w) => w && w.length <= 14).slice(0, 16);
        return json({ locked: true, count, wants });
      }
      const list = Object.entries(db.people).map(([k, p]) => publicPerson(k, p)).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
      return json({ locked: false, count, people: list });
    }
    if (a === "photo") {
      const pid = (url.searchParams.get("id") || "").replace(/[^a-f0-9]/g, "").slice(0, 24);
      const db = await readJSON(PEOPLE, EMPTY_PEOPLE);
      if (!(admin || (id && db.people[id]))) return new Response("", { status: 403 });
      const r = await s.read(`photos/${pid}.jpg`);
      if (!r) return new Response("", { status: 404 });
      return new Response(r.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=2592000, immutable", "x-content-type-options": "nosniff" } });
    }
    if (a === "notices") {
      const n = await readJSON(NOTICES, EMPTY_NOTICES);
      return json({ notices: n.notices }, 200, { "cache-control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30" });
    }
    return err("not found", 404);
  }

  if (req.method !== "POST") return err("method", 405);
  const b = await body(req);

  if (a === "register") {
    const prof = cleanProfile(b.profile || {});
    if (!prof) return err("名前・肩書・何をしているかを入力してください");
    let useCode = code, created = false;
    const dbNow = await readJSON(PEOPLE, EMPTY_PEOPLE, 0);
    if (!useCode || !dbNow.people[idOf(useCode)]) { if (!useCode) { useCode = newCode(); created = true; } }
    const pid = idOf(useCode);
    let pv;
    if (typeof b.photo === "string") {
      if (b.photo === "") { await s.del(`photos/${pid}.jpg`); pv = 0; }
      else {
        const m = b.photo.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return err("写真の形式が読み取れませんでした");
        const buf = Buffer.from(m[1], "base64");
        if (buf.length > 250000) return err("写真が大きすぎます");
        await s.write(`photos/${pid}.jpg`, buf, { contentType: "image/jpeg" });
        pv = Date.now();
      }
    }
    const now = Date.now();
    const db = await updateJSON(PEOPLE, (d) => {
      const old = d.people[pid] || {};
      d.people[pid] = { ...prof, open: old.createdAt ? (b.profile.open === undefined ? old.open : prof.open) : true, pv: pv === undefined ? old.pv || 0 : pv, createdAt: old.createdAt || now, updatedAt: now };
    }, EMPTY_PEOPLE);
    if (b.prefs && typeof b.prefs === "object") {
      const pr = { plan: (b.prefs.plan || []).map(String).slice(0, 60), talk: (b.prefs.talk || []).map(String).slice(0, 300), seen: +b.prefs.seen || 0 };
      await s.write(`prefs/${pid}.json`, JSON.stringify(pr));
    }
    return json({ me: publicPerson(pid, db.people[pid]), code: fmtCode(useCode), created, role: admin ? "admin" : "member" }, 200, { "set-cookie": setCookie("nx", useCode) });
  }

  if (a === "restore") {
    const c = normCode(b.code);
    if (!validCode(c)) return err("コードは12文字です。もう一度確認してください");
    const db = await readJSON(PEOPLE, EMPTY_PEOPLE, 0);
    const pid = idOf(c);
    if (!db.people[pid]) return err("このコードの登録が見つかりません");
    const r = await s.read(`prefs/${pid}.json`);
    return json({ me: publicPerson(pid, db.people[pid]), code: fmtCode(c), prefs: r ? JSON.parse(r.body.toString("utf8")) : null, role: admin ? "admin" : "member" }, 200, { "set-cookie": setCookie("nx", c) });
  }

  if (a === "admin_login") {
    const pw = String(b.password || "");
    const real = process.env.ADMIN_PASSWORD || "";
    const ok = real && pw.length === real.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(real));
    if (!ok) { await new Promise((r) => setTimeout(r, 800)); return err("パスワードが違います", 401); }
    return json({ role: "admin" }, 200, { "set-cookie": setCookie("nxa", adminSig(), 30 * 24 * 3600) });
  }
  if (a === "admin_logout") return json({ ok: true }, 200, { "set-cookie": setCookie("nxa", "", 0) });

  if (a === "prefs") {
    if (!id) return err("未登録です", 401);
    const pr = { plan: (b.plan || []).map(String).slice(0, 60), talk: (b.talk || []).map(String).slice(0, 300), seen: +b.seen || 0 };
    await s.write(`prefs/${id}.json`, JSON.stringify(pr));
    return json({ ok: true });
  }

  if (a === "patch") {
    if (!id) return err("未登録です", 401);
    const db = await updateJSON(PEOPLE, (d) => {
      if (!d.people[id]) return false;
      if (typeof b.open === "boolean") d.people[id].open = b.open;
      d.people[id].updatedAt = Date.now();
    }, EMPTY_PEOPLE);
    if (!db.people[id]) return err("未登録です", 404);
    return json({ me: publicPerson(id, db.people[id]) });
  }

  if (a === "delete_me") {
    if (!id) return err("未登録です", 401);
    await updateJSON(PEOPLE, (d) => { if (!d.people[id]) return false; delete d.people[id]; }, EMPTY_PEOPLE);
    await s.del(`photos/${id}.jpg`); await s.del(`prefs/${id}.json`);
    return json({ ok: true }, 200, { "set-cookie": setCookie("nx", "", 0) });
  }

  // ---- 管理者だけ ----
  if (!admin) return err("管理者だけが使えます", 403);
  if (a === "notice_send") {
    const n = { id: "n" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), title: str(b.title, 40), body: str(b.body, 300).replace(/ {2,}/g, " "), kind: KINDS.includes(b.kind) ? b.kind : "info", createdAt: Date.now() };
    if (!n.title) return err("タイトルを入力してください");
    const d = await updateJSON(NOTICES, (x) => { x.notices.unshift(n); x.notices = x.notices.slice(0, 100); }, EMPTY_NOTICES);
    return json({ notices: d.notices });
  }
  if (a === "notice_delete") {
    const d = await updateJSON(NOTICES, (x) => { const before = x.notices.length; x.notices = x.notices.filter((n) => n.id !== b.id); if (x.notices.length === before) return false; }, EMPTY_NOTICES);
    return json({ notices: d.notices });
  }
  if (a === "person_delete") {
    const pid = String(b.id || "").replace(/[^a-f0-9]/g, "").slice(0, 24);
    await updateJSON(PEOPLE, (d) => { if (!d.people[pid]) return false; delete d.people[pid]; }, EMPTY_PEOPLE);
    await s.del(`photos/${pid}.jpg`);
    return json({ ok: true });
  }
  return err("not found", 404);
}

async function safe(req) {
  try { return await route(req); } catch (e) {
    console.error("summit api", e && e.message);
    return err(e.status === 413 ? "データが大きすぎます" : "うまく処理できませんでした。少し待ってもう一度お試しください", e.status || 500);
  }
}
export const GET = safe;
export const POST = safe;
