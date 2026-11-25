// 運営メンバー取扱説明書API（api/staff.js）のテスト：node tests/staff.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.SUMMIT_FS_DIR = "/tmp/stafftest" + Date.now(); process.env.STAFF_DEV_LOGIN = "1";
process.env.OWNER_EMAILS = "rep@example.com"; process.env.AUTH_SECRET = "test-secret"; process.env.STAFF_SYNC_TOKEN = "sync-token-for-tests-0123456789";
const mod = await import(process.argv[2] || new URL("../api/staff.js", import.meta.url).href);
const B = "https://x/api/staff?a=";
const call = async (m, a, body, ck) => {
  const r = await mod[m]({ url: B + a, method: m, headers: { get: (n) => (n === "cookie" ? ck || "" : null) }, text: async () => (m === "GET" ? "" : JSON.stringify(body || {})) });
  return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get("set-cookie") || "").split(";")[0] };
};
const GET = "GET", POST = "POST";
const dev = async (email) => { const r = await call(POST, "dev_login", { email }); return r.s === 200 ? r.c : r; };
const allFiles = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(d + "/" + f).isFile()).map((f) => fs.readFileSync(d + "/" + f, "utf8")).join("\n");

assert.equal((await call(GET, "all")).s, 401);
const rep = await dev("rep@example.com");
const boot = await call(POST, "bootstrap", { members: [
  { ref: "L", name: "統括A", team: "media", role: "統括", status: "confirmed", email: "Lead@Example.com", page: { f: { strength: { v: "段取り" }, weak: { v: "人前で話す" } }, kw: ["段取り"], thanks: [{ t: "ありがとう1" }, { t: "ありがとう2" }] } },
  { ref: "M", name: "メンバーB", team: "media", role: "メンバー", status: "confirmed", email: "mem@example.com", page: { f: { strength: { v: "編集" }, weak: { v: "朝" } } } },
  { ref: "O", name: "別チームC", team: "a", role: "メンバー", status: "confirmed", email: "other@example.com", page: { f: { strength: { v: "企画" } } } },
  { ref: "P", name: "保留D", team: "media", role: "メンバー", status: "pending", email: "pend@example.com" },
  { ref: "rep", name: "代表太郎", kana: "だいひょう たろう", team: "hq", role: "代表", status: "confirmed", page: { f: { dream: { v: "夢" } } } }] }, rep);
assert.equal(boot.j.count, 5);
// メールアドレスは保存されない（ハッシュだけ）。代表にも返さない
assert.ok(!allFiles(process.env.SUMMIT_FS_DIR).includes("example.com"), "メールアドレスが保存されている");
let r = await call(GET, "all", null, rep);
assert.equal(r.j.roster.length, 5);
assert.equal(r.j.roster.filter((m) => m.role === "代表").length, 1);
assert.equal(r.j.roster.find((m) => m.role === "代表").name, "代表太郎");
assert.ok(r.j.roster.every((m) => !("email" in m)) && r.j.roster.find((m) => m.name === "統括A").hasEmail === true);

// 初回ログイン：メール → 確認コード → パスワード作成
r = await call(POST, "login_start", { email: "mem@example.com" }); assert.equal(r.j.next, "code");
const mail = fs.readdirSync(process.env.SUMMIT_FS_DIR + "/mail").map((f) => fs.readFileSync(process.env.SUMMIT_FS_DIR + "/mail/" + f, "utf8")).join();
const code = mail.match(/\b(\d{6})\b/)[1];
assert.equal((await call(POST, "code_verify", { email: "mem@example.com", code: code === "000000" ? "111111" : "000000" })).s, 400);
r = await call(POST, "code_verify", { email: "MEM@example.com ", code }); assert.ok(r.j.setup);
assert.equal((await call(POST, "password_set", { setup: r.j.setup, password: "1234" })).s, 400);
assert.equal((await call(POST, "password_set", { setup: r.j.setup, password: "aaaaaaaaa" })).s, 400);
r = await call(POST, "password_set", { setup: r.j.setup, password: "nexy-summit-27" }); assert.equal(r.s, 200);
const mem = r.c;
// 2回目からはパスワード
assert.equal((await call(POST, "login_start", { email: "mem@example.com" })).j.next, "password");
assert.equal((await call(POST, "login_password", { email: "mem@example.com", password: "wrong-pass" })).s, 401);
r = await call(POST, "login_password", { email: "mem@example.com", password: "nexy-summit-27" }); assert.equal(r.s, 200);
// 8回続けて間違えたら止まる
for (let i = 0; i < 8; i++) await call(POST, "login_password", { email: "mem@example.com", password: "x" + i + "xxxxxxx" });
assert.equal((await call(POST, "login_password", { email: "mem@example.com", password: "nexy-summit-27" })).s, 429);
// 保留・未登録は入れない
assert.equal((await call(POST, "login_start", { email: "pend@example.com" })).s, 403);
assert.equal((await call(POST, "login_start", { email: "nobody@example.com" })).s, 403);
// 写真がない人は needsPhoto
assert.equal((await call(GET, "me", null, mem)).j.needsPhoto, true);

const lead = await dev("lead@example.com"), oth = await dev("other@example.com");
r = await call(GET, "all", null, mem);
assert.equal(r.j.roster.length, 4); // 保留の人は見えない（代表を含む確定4人）
assert.ok(r.j.roster.every((m) => !("hasEmail" in m)));
const R0 = r.j.roster, id = (n) => R0.find((m) => m.name === n).id, L = id("統括A"), M = id("メンバーB");
// 最初から公開：同じチームのメンバーにすぐ見える。管理職までの項目は見えない
r = await call(GET, "page&id=" + L, null, mem);
assert.equal(r.j.open, true); assert.equal(r.j.f.strength.v, "段取り"); assert.ok(!r.j.f.weak); assert.equal(r.j.thanks.length, 2);
assert.ok(!r.j.excluded && !r.j.consent && !r.j.cert);
// 本人以外は編集できない
assert.equal((await call(POST, "page_save", { id: L, f: { strength: { v: "x" } } }, mem)).s, 403);
// 見られる範囲は本人が送っても変わらない
r = await call(POST, "page_save", { id: L, f: { weak: { v: "人前で話す", s: "all" } }, thanksPub: [true, false], x: { skills: { "段取り": "good", "ハッキング": "good" } } }, lead);
assert.equal(r.j.f.weak.s, "lead"); assert.deepEqual(r.j.x.skills, { "段取り": "good" });
r = await call(GET, "page&id=" + L, null, mem); assert.ok(!r.j.f.weak); assert.equal(r.j.thanks.length, 1);
r = await call(GET, "page&id=" + L, null, oth); assert.ok(r.j.f.strength && !r.j.f.weak);
// 管理職：自分のチームのメンバーの「管理職まで」は見える
r = await call(GET, "page&id=" + M, null, lead); assert.equal(r.j.f.weak.v, "朝");
// 1on1の下書き：管理職は自分のチームのほかの人だけ
assert.equal((await call(POST, "draft_save", { id: id("別チームC"), fields: { dream: { text: "x" } } }, lead)).s, 403);
assert.equal((await call(POST, "draft_save", { id: L, fields: { dream: { text: "x" } } }, lead)).s, 403);
r = await call(POST, "draft_save", { id: M, fields: { dream: { text: "映像の仕事", quote: "映像の仕事がしたい", check: true } }, consent: "yes" }, lead);
assert.equal(r.s, 200); assert.equal(r.j.status, "pub");
// 非公開にすると本人と代表だけ
await call(POST, "page_save", { id: M, unpublish: true }, mem); assert.equal((await call(GET, "page&id=" + M, null, lead)).j.open, false);
await call(POST, "page_save", { id: M, publish: true }, mem);
// プロフィール・写真・証明書
const png = "data:image/jpeg;base64," + Buffer.from("fakejpeg").toString("base64");
r = await call(POST, "profile_save", { name: "メンバーB", kana: "めんばー びー", nick: "びー", photo: png }, mem); assert.equal(r.j.member.kana, "めんばー びー");
assert.equal((await call(GET, "me", null, mem)).j.needsPhoto, false);
await call(POST, "page_save", { id: M, cert: { duty: "撮影を担当" } }, mem);
r = await call(POST, "certificate", {}, mem); assert.equal(r.j.sample, true); assert.equal(r.j.duty, "撮影を担当");
assert.equal((await call(POST, "settings", { certOpen: true }, mem)).s, 403);
await call(POST, "settings", { certOpen: true }, rep); assert.equal((await call(POST, "certificate", {}, mem)).j.sample, false);
// 代表：保留→確定。メールを入れ直すとパスワードは消える
const P = (await call(GET, "all", null, rep)).j.roster.find((m) => m.name === "保留D");
assert.equal((await call(POST, "roster_upsert", { ...P, status: "confirmed" }, mem)).s, 403);
assert.equal((await call(POST, "roster_upsert", { ...P, status: "confirmed" }, rep)).s, 200);
assert.equal((await call(POST, "login_start", { email: "pend@example.com" })).j.next, "code");
// 確定→保留に戻すと、その場で入れなくなる
const Mrow = (await call(GET, "all", null, rep)).j.roster.find((m) => m.id === M);
await call(POST, "roster_upsert", { ...Mrow, status: "pending" }, rep);
assert.equal((await call(GET, "all", null, mem)).s, 401);
// 同じメールアドレスは2人に登録できない
assert.equal((await call(POST, "roster_upsert", { name: "重複", team: "a", email: "lead@example.com" }, rep)).s, 409);
// 外すとページも消える
await call(POST, "roster_remove", { id: id("別チームC") }, rep);
assert.equal((await call(GET, "page&id=" + id("別チームC"), null, rep)).s, 404);
assert.ok(!allFiles(process.env.SUMMIT_FS_DIR).replace(/mail\/[^\n]*/g, "").includes("@example.com"), "メールアドレスが保存されている");
// 追加の取り込み（週1など）：同じ人は重複せず更新、本人が書いた文章は上書きしない、新しい人は追加
{
  const before = (await call(GET, "all", null, rep)).j.roster;
  const lead = before.find((m) => m.name === "統括A");
  const leadCk = await dev("lead@example.com");
  await call(POST, "page_save", { id: lead.id, f: { strength: { v: "本人が書いた強み" } } }, leadCk);
  const r2 = await call(POST, "bootstrap", { members: [
    { name: "統括A", team: "media", role: "統括", status: "confirmed", email: "LEAD@example.com", page: { f: { strength: { v: "フォームの強み" }, dream: { v: "フォームの夢" } } } },
    { name: "新人E", team: "b", role: "メンバー", status: "confirmed", email: "new@example.com", page: { f: { reason: { v: "参加理由" } } } }] }, rep);
  assert.equal(r2.s, 200); assert.equal(r2.j.added, 1); assert.equal(r2.j.updated, 1);
  const after = (await call(GET, "all", null, rep)).j.roster;
  assert.equal(after.length, before.length + 1);
  const pg = (await call(GET, "page&id=" + lead.id, null, rep)).j;
  assert.equal(pg.f.strength.v, "本人が書いた強み");
  assert.equal(pg.f.dream.v, "フォームの夢");
  const nc = await dev("new@example.com"); assert.equal(typeof nc, "string", "新人Eがログインできない");
  // 保留→確定も取り込みで反映
  await call(POST, "bootstrap", { members: [{ name: "新人E", team: "b", role: "メンバー", status: "pending", email: "new@example.com" }] }, rep);
  assert.equal((await call(GET, "all", null, rep)).j.roster.find((m) => m.name === "新人E").status, "pending");
}
// 証明書の所見：代表か同じチームの管理職だけが書ける。本人の証明書に載る
{
  const ros = (await call(GET, "all", null, rep)).j.roster;
  const L2 = ros.find((m) => m.name === "統括A");
  const leadCk2 = await dev("lead@example.com");
  assert.equal((await call(POST, "cert_comment", { id: L2.id, comment: "自分で書く" }, leadCk2)).s, 403);
  assert.equal((await call(POST, "cert_comment", { id: L2.id, comment: "毎週の定例に参加した" }, rep)).s, 200);
  await call(POST, "page_save", { id: L2.id, cert: { duty: "広報", items: ["投稿を企画", "", "撮影"], result: "表示4万回", comment: "書き換え" } }, leadCk2);
  const c = (await call(POST, "certificate", {}, leadCk2)).j;
  assert.equal(c.comment, "毎週の定例に参加した");
  assert.deepEqual(c.items, ["投稿を企画", "撮影"]);
  assert.equal(c.result, "表示4万回");
}
// メールが正しくつながっていない人も、もう一度取り込むと名前で照合して付け直せる（重複しない）
{
  const ros = (await call(GET, "all", null, rep)).j.roster;
  const e = ros.find((m) => m.name === "新人E");
  await call(POST, "roster_upsert", { id: e.id, name: e.name, team: e.team, role: e.role, status: "confirmed", email: "wrong@example.com" }, rep);
  assert.notEqual(typeof (await dev("new@example.com")), "string");
  await call(POST, "bootstrap", { members: [{ name: "新人E", team: "b", role: "メンバー", status: "confirmed", email: "new@example.com" }] }, rep);
  assert.equal(typeof (await dev("new@example.com")), "string", "付け直しても入れない");
  assert.equal((await call(GET, "all", null, rep)).j.roster.length, ros.length);
}
// 応募フォームからの自動連携：合言葉が必要。チーム・確定は変えず、メールを付け直し、新しい人は保留で入る
{
  const sync = async (tok, body) => { const r = await mod.POST({ url: B + "sync", method: "POST", headers: { get: (n) => (n === "authorization" ? "Bearer " + tok : null) }, text: async () => JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  assert.equal((await sync("wrong", { members: [] })).s, 401);
  const ros = (await call(GET, "all", null, rep)).j.roster;
  const lead = ros.find((m) => m.name === "統括A");
  await call(POST, "roster_upsert", { id: lead.id, name: lead.name, team: lead.team, role: lead.role, status: "confirmed", email: "old-lead@example.com" }, rep);
  const r = await sync("sync-token-for-tests-0123456789", { members: [
    { name: "統括 A", team: "a", role: "メンバー", status: "pending", email: "lead2@example.com", page: { f: { reason: { v: "志望動機" } } } },
    { name: "応募F", team: "rec", email: "f@example.com", page: { f: { strength: { v: "笑顔" } } } }] });
  assert.equal(r.s, 200); assert.equal(r.j.added, 1); assert.equal(r.j.updated, 1);
  const after = (await call(GET, "all", null, rep)).j.roster;
  const l2 = after.find((m) => m.id === lead.id);
  assert.equal(l2.team, lead.team); assert.equal(l2.role, lead.role); assert.equal(l2.status, "confirmed");
  assert.equal(typeof (await dev("lead2@example.com")), "string", "フォームのメールで入れない");
  assert.equal(after.find((m) => m.name === "応募F").status, "pending");
  assert.notEqual(typeof (await dev("f@example.com")), "string");
  assert.ok((await call(GET, "settings", null, rep)).j.lastSync > 0);
  // 「メンバー」になった人は確定に上がり、ログインできる。確定の人は「検討中」でも保留に戻さない
  await sync("sync-token-for-tests-0123456789", { members: [{ name: "応募F", team: "rec", status: "confirmed", email: "f@example.com" }, { name: "統括A", team: "a", status: "pending", email: "lead2@example.com" }, { name: "新人G", team: "a", status: "confirmed", email: "g@example.com" }] });
  const r3 = (await call(GET, "all", null, rep)).j.roster;
  assert.equal(r3.find((m) => m.name === "応募F").status, "confirmed");
  assert.equal(r3.find((m) => m.id === lead.id).status, "confirmed");
  assert.equal(r3.find((m) => m.name === "新人G").status, "confirmed");
  assert.equal(typeof (await dev("g@example.com")), "string");
  // フォームから入った人は「チーム未選択」。本人がマイページで選ぶ。管理職は自分でチームを変えられない
  const g = r3.find((m) => m.name === "新人G");
  assert.equal(g.teamSet, false);
  const gck = await dev("g@example.com");
  await call(POST, "profile_save", { name: "新人G", team: "media" }, gck);
  const g2 = (await call(GET, "all", null, rep)).j.roster.find((m) => m.id === g.id);
  assert.equal(g2.team, "media"); assert.equal(g2.teamSet, true);
  await call(POST, "profile_save", { name: "新人G", team: "hq" }, gck);
  assert.equal((await call(GET, "all", null, rep)).j.roster.find((m) => m.id === g.id).team, "media");
  const lck = await dev("lead2@example.com");
  await call(POST, "profile_save", { name: "統括A", team: "rec" }, lck);
  assert.equal((await call(GET, "all", null, rep)).j.roster.find((m) => m.id === lead.id).team, lead.team);
  // 連携スクリプトに書いた統括・サブ統括は、最初から管理職になる
  await sync("sync-token-for-tests-0123456789", { members: [{ name: "新人G", team: "guide", role: "サブ統括", status: "confirmed", email: "g@example.com" }] });
  const g3 = (await call(GET, "all", null, rep)).j.roster.find((m) => m.id === g.id);
  assert.equal(g3.role, "サブ統括"); assert.equal(g3.team, "guide");
}
// 本番（Blob）では dev_login は使えない
delete process.env.STAFF_DEV_LOGIN; assert.equal((await call(POST, "dev_login", { email: "rep@example.com" })).s, 404);
console.log("all tests passed");
