/* NEV369 Top Holders view. Reads the persisted report produced by tools/merge-top-holders.mjs. */
"use strict";
const REPORT="https://raw.githubusercontent.com/mattcodeai91/nevwhisper/holder-scan-data/top-holders.json";
const status=document.getElementById("status"),updated=document.getElementById("updated"),summary=document.getElementById("summary"),list=document.getElementById("list"),note=document.getElementById("note");
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
function short(v){v=String(v||"");return v.length>30?v.slice(0,16)+"..."+v.slice(-12):v}
function pct(b,s){const n=Number(b),d=Number(s);return Number.isFinite(n)&&Number.isFinite(d)&&d>0?((n/d)*100).toFixed(2)+"% of max supply":"—"}
function load(){fetch(REPORT+"?t="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json()}).then(r=>{const d=r.diagnostics||{};updated.textContent="Updated "+new Date(r.generatedAt).toLocaleString();summary.innerHTML='<div class="card"><div class="label">Chain scanned</div><div class="value">#'+Number(r.chainHeight).toLocaleString()+'</div></div><div class="card"><div class="label">Circulating Supply</div><div class="value">'+esc(d.totalPositiveBalanceNEV||"—")+' NEV</div></div>';list.innerHTML=(r.top10||[]).map(h=>'<article class="row"><div class="rank">#'+esc(h.rank)+'</div><div class="address"><a target="_blank" rel="noopener noreferrer" href="https://q-lock-ecosystem.com/explorer/#/address/'+encodeURIComponent(h.address)+'">'+esc(short(h.address))+' ↗</a><div class="meta">Ranked by current balance</div></div><div class="balance"><div class="amount">'+esc(h.balanceNEV)+' NEV</div><div class="share">'+esc(pct(h.balanceNEV,d.maxSupplyNEV))+'</div></div></article>').join("");note.textContent="Complete scan: "+Number(r.scannedRange.start).toLocaleString()+" → "+Number(r.scannedRange.end).toLocaleString()+" across "+Number(r.chunksMerged).toLocaleString()+" persisted chunks. "+Number(d.transactions).toLocaleString()+" transactions accounted for.";status.textContent="LIVE · Holder report loaded"}).catch(e=>{console.error(e);status.textContent="Unable to load holder report · retrying…"} )}
load();setInterval(load,30000);

export function initHoldersView() {
  load();
}
