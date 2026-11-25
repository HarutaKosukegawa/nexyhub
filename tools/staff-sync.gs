/**
 * NEXY 運営メンバー自動連携（Google Apps Script）
 *
 * 「NEXY SUMMIT2027フォーム一覧」スプレッドシートに貼り付けて使います。
 * 運営応募フォームの回答（名前・メールアドレス・志望動機・強み など）を、
 * 参加者アプリの「運営」タブに自動で送ります。
 *
 * ・毎日朝6時 と 回答が届いたとき に自動で送ります。メニューの「今すぐアプリに送る」でもすぐ送れます。
 * ・「フォームの回答 1」のB列（見出し「メンバー」）で、
 *     「メンバー」→ 確定（フォームのメールアドレスでログインできる）
 *     「検討中」・空欄 → 保留（名簿には入るが、ログインはできない）
 *     「NOTメンバー」→ 送らない
 * ・すでにいる人は重複しません。チーム・役職は変えません（アプリのメンバー管理で決めます）。
 *   確定の人を自動で保留に戻すことはしません。外すときはアプリのメンバー管理で外してください。
 * ・新しい人のチームは、「配属案」の第1候補を仮に入れます（なければ常設）。
 * ・本人が書いた取扱説明書は上書きしません。空欄だけを埋めます。
 * ・メールアドレスはアプリのサーバーで暗号化してから保存されます。
 *
 * 合言葉（STAFF_SYNC_TOKEN）は、初期設定のときにこのスクリプトが作ります。
 * スクリプトの中には書かないでください（スクリプトのプロパティに保存されます）。
 */

const API_URL = "https://www.nexyhub.jp/api/staff?a=sync";
const FORM_SHEET = "フォームの回答 1";
const TEAM_SHEET = "配属案"; // 「氏名」と「第1候補」の列。新しい人の仮のチームに使うだけ
const TEAM_KEYS = { "A会場": "a", "B会場": "b", "常設": "perm", "メディア": "media", "レセプション": "rec", "誘導": "guide" };

function onOpen() {
  SpreadsheetApp.getUi().createMenu("NEXY運営")
    .addItem("今すぐアプリに送る", "syncNow")
    .addItem("初期設定（最初に1回だけ）", "setup")
    .addToUi();
}

/** 最初に1回だけ実行：合言葉を作り、自動で送る設定をする */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty("STAFF_SYNC_TOKEN");
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    props.setProperty("STAFF_SYNC_TOKEN", token);
  }
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncNow").forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger("syncNow").timeBased().everyDays(1).atHour(6).create();
  const msg = "下の合言葉をコピーして、Vercel の環境変数 STAFF_SYNC_TOKEN に貼り付けてください（Production と Preview）。\n貼り付けたら Vercel で Redeploy し、メニューの「今すぐアプリに送る」を押してください。\n\n" + token;
  console.log(msg);
  try { SpreadsheetApp.getUi().alert("初期設定ができました", msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* エディタから実行したときは、下の「実行ログ」に出ます */ }
}

function syncNow() {
  const token = PropertiesService.getScriptProperties().getProperty("STAFF_SYNC_TOKEN");
  if (!token) throw new Error("先に「初期設定」を実行してください");
  const ss = SpreadsheetApp.getActive();

  // 配属案：名前 → 第1候補のチーム
  const teamOf = {};
  const ts = ss.getSheetByName(TEAM_SHEET);
  if (ts) {
    const v = ts.getDataRange().getValues();
    const h = v[0].map(String);
    const iN = h.findIndex((x) => x.indexOf("氏名") >= 0), iT = h.findIndex((x) => x.indexOf("第1候補") >= 0);
    if (iN >= 0 && iT >= 0) v.slice(1).forEach((r) => { const n = clean(r[iN]); if (n) teamOf[n] = TEAM_KEYS[clean(r[iT])]; });
  }

  // フォームの回答
  const fs = ss.getSheetByName(FORM_SHEET);
  const v = fs.getDataRange().getValues();
  const h = v[0].map(String);
  const col = (word) => h.findIndex((x) => x.indexOf(word) >= 0);
  const iStatus = h.findIndex((x) => x.trim() === "メンバー");
  const C = { name: col("氏名"), email: col("メールアドレス"), reason: col("志望動機"), history: col("これまで"), strength: col("強み"), weak: col("弱み"), gain: col("得たい") };
  if (C.name < 0 || C.email < 0) throw new Error("「氏名」か「メールアドレス」の列が見つかりません");

  const seen = {};
  const members = [];
  v.slice(1).forEach((r) => {
    const name = clean(r[C.name]);
    const email = String(r[C.email] || "").trim().toLowerCase();
    if (!name) return;
    const mark = iStatus >= 0 ? clean(r[iStatus]) : "";
    if (/NOT|不参加|辞退/i.test(mark)) return;
    const status = mark === "メンバー" ? "confirmed" : "pending";
    const f = {};
    ["reason", "history", "strength", "weak", "gain"].forEach((k) => {
      const t = C[k] >= 0 ? String(r[C[k]] || "").trim() : "";
      if (t) f[k] = { v: t.slice(0, 300), src: "form" };
    });
    // 同じ人が2回答えていたら、あとの回答を使う
    seen[name] = { name: name, email: email, team: teamOf[name] || "perm", role: "メンバー", status: status, page: { f: f } };
  });
  Object.keys(seen).forEach((k) => members.push(seen[k]));

  const res = UrlFetchApp.fetch(API_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ members: members }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error("アプリに送れませんでした（" + code + "）：" + res.getContentText().slice(0, 200));
  const j = JSON.parse(res.getContentText());
  const done = "アプリに送りました：新しく " + j.added + " 人、更新 " + j.updated + " 人";
  console.log(done);
  try { ss.toast(done, "NEXY運営", 8); } catch (e) {}
  return j;
}

function clean(x) { return String(x || "").replace(/\s+/g, "").trim(); }
