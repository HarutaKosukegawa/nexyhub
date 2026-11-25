import crypto from "node:crypto";
import assert from "node:assert/strict";
process.env.SUMMIT_FS_DIR="/tmp/stafftest"+Date.now(); process.env.STAFF_DEV_LOGIN="1";
process.env.OWNER_EMAILS="rep@example.com"; process.env.GOOGLE_CLIENT_ID="cid.apps.googleusercontent.com";
// Google公開鍵をテスト用に差し替え
const {publicKey,privateKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"k1",alg:"RS256",use:"sig"};
globalThis.fetch=async(u)=>({ok:true,json:async()=>({keys:[jwk]})});
const mk=(claims)=>{const h=Buffer.from(JSON.stringify({alg:"RS256",kid:"k1"})).toString("base64url");const p=Buffer.from(JSON.stringify(claims)).toString("base64url");
  return h+"."+p+"."+crypto.sign("RSA-SHA256",Buffer.from(h+"."+p),privateKey).toString("base64url")};
const mod=await import(process.argv[2]||new URL("../api/staff.js",import.meta.url).href);const GET="GET",POST="POST";
const B="https://x/api/staff?a=";
const call=async(fn,a,body,ck)=>{const r=await mod[fn]({url:B+a,method:fn,headers:{get:(n)=>n==="cookie"?(ck||""):null},text:async()=>fn===GET?"":JSON.stringify(body||{})});
  return {s:r.status,j:await r.json(),c:(r.headers.get("set-cookie")||"").split(";")[0]}};
const login=async(email)=>{const r=await call(POST,"dev_login",{email});return r.s===200?r.c:r};

// 未ログイン
assert.equal((await call(GET,"all")).s,401);
const rep=await login("rep@example.com");
const boot=await call(POST,"bootstrap",{members:[
 {ref:"L",name:"統括A",team:"media",role:"統括",status:"confirmed",email:"lead@example.com",page:{f:{strength:{v:"段取り"},weak:{v:"人前で話す"},contact:{v:"21時まで"}},kw:["段取り"],thanks:[{t:"ありがとう1"},{t:"ありがとう2"}]}},
 {ref:"M",name:"メンバーB",team:"media",role:"メンバー",status:"confirmed",email:"mem@example.com",page:{f:{strength:{v:"編集"},weak:{v:"朝"}}}},
 {ref:"O",name:"別チームC",team:"a",role:"メンバー",status:"confirmed",email:"other@example.com",page:{f:{strength:{v:"企画"}}}},
 {ref:"P",name:"保留D",team:"media",role:"メンバー",status:"pending",email:"pend@example.com"}]},rep);
assert.equal(boot.j.count,4);
// 保留の人はログインできない／未登録も
assert.equal((await login("pend@example.com")).s,403);
assert.equal((await login("nobody@example.com")).s,403);
const lead=await login("lead@example.com"),mem=await login("mem@example.com"),oth=await login("other@example.com");
// 名簿：保留とGmailは代表だけ
let r=await call(GET,"all",null,rep);assert.equal(r.j.roster.length,4);assert.ok("email" in r.j.roster[0]);
r=await call(GET,"all",null,mem);assert.equal(r.j.roster.length,3);assert.ok(!("email" in r.j.roster[0]));
const R0=r.j.roster;const id=n=>R0.find(m=>m.name===n).id;const L=id("統括A"),M=id("メンバーB");
// 公開前は本人と代表だけ
assert.equal(r.j.pages[L].open,false);
r=await call(GET,"page&id="+L,null,rep);assert.equal(r.j.f.weak.v,"人前で話す");assert.equal(r.j.thanks.length,2);
// 本人以外は編集できない
assert.equal((await call(POST,"page_save",{id:L,f:{strength:{v:"x"}}},mem)).s,403);
// 同意なしでは公開できない
assert.equal((await call(POST,"page_save",{id:L,publish:true},lead)).s,400);
r=await call(POST,"page_save",{id:L,publish:true,consent:true,thanksPub:[true,false],x:{skills:{"段取り":"good","ハッキング":"good"},from:19,to:22}},lead);
assert.equal(r.s,200);assert.deepEqual(r.j.x.skills,{"段取り":"good"});
// メンバー（同じチーム）：全員とチーム内は見える、管理職までは見えない、ありがとうは選ばれた1件だけ
r=await call(GET,"page&id="+L,null,mem);assert.equal(r.j.f.strength.v,"段取り");assert.equal(r.j.f.contact.v,"21時まで");assert.ok(!r.j.f.weak);assert.equal(r.j.thanks.length,1);assert.ok(!r.j.excluded&&!r.j.consent&&!r.j.f.strength.q);
// 別チーム：チーム内も見えない
r=await call(GET,"page&id="+L,null,oth);assert.ok(r.j.f.strength&&!r.j.f.contact&&!r.j.f.weak);
// 管理職：自分のチームのメンバーの「管理職まで」は見える（公開後）
await call(POST,"page_save",{id:M,publish:true,consent:true},mem);
r=await call(GET,"page&id="+M,null,lead);assert.equal(r.j.f.weak.v,"朝");
r=await call(GET,"page&id="+M,null,oth);assert.ok(!r.j.f.weak);
// 1on1の下書き：管理職は自分のチームの人だけ、別チームと本人は不可
assert.equal((await call(POST,"draft_save",{id:id("別チームC"),fields:{dream:{text:"x"}}},lead)).s,403);
assert.equal((await call(POST,"draft_save",{id:L,fields:{dream:{text:"x"}}},lead)).s,403);
r=await call(POST,"draft_save",{id:M,fields:{dream:{text:"映像の仕事",quote:"映像の仕事がしたい",check:true}},consent:"yes"},lead);assert.equal(r.s,200);
assert.equal(r.j.status,"draft");
// メンバーは名簿を変えられない／代表は保留→確定にできる
const P=(await call(GET,"all",null,rep)).j.roster.find(m=>m.name==="保留D");
assert.equal((await call(POST,"roster_upsert",{...P,status:"confirmed"},mem)).s,403);
assert.equal((await call(POST,"roster_upsert",{...P,status:"confirmed"},rep)).s,200);
assert.ok(typeof (await login("pend@example.com"))==="string");
// 確定→保留に戻すと、その場で入れなくなる
await call(POST,"roster_upsert",{...(await call(GET,"all",null,rep)).j.roster.find(m=>m.id===M),email:"mem@example.com",status:"pending"},rep);
assert.equal((await call(GET,"all",null,mem)).s,401);
// Gmailの重複は登録できない
assert.equal((await call(POST,"roster_upsert",{name:"重複",team:"a",email:"lead@example.com"},rep)).s,409);
// 外すとページも消える
await call(POST,"roster_remove",{id:id("別チームC")},rep);
assert.equal((await call(GET,"page&id="+id("別チームC"),null,rep)).s,404);
// Googleログイン：正しいトークンだけ通る
const now=Math.floor(Date.now()/1000);
const good=mk({iss:"https://accounts.google.com",aud:"cid.apps.googleusercontent.com",email:"Lead@Example.com",email_verified:true,exp:now+600});
assert.equal((await call(POST,"login",{credential:good})).s,200);
assert.equal((await call(POST,"login",{credential:mk({iss:"https://accounts.google.com",aud:"other",email:"lead@example.com",email_verified:true,exp:now+600})})).s,401);
assert.equal((await call(POST,"login",{credential:mk({iss:"https://accounts.google.com",aud:"cid.apps.googleusercontent.com",email:"lead@example.com",email_verified:true,exp:now-1})})).s,401);
assert.equal((await call(POST,"login",{credential:good.slice(0,-4)+"AAAA"})).s,401);
// 本番（Blob）では dev_login は使えない
delete process.env.STAFF_DEV_LOGIN;assert.equal((await call(POST,"dev_login",{email:"rep@example.com"})).s,404);
console.log("all tests passed");
