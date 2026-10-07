/* NEV369 Top Holders view.
 * Reads the persisted report produced by tools/merge-top-holders.mjs.
 * This module is intentionally read-only: scanning and publishing remain CI responsibilities.
 */
const REPORT = "https://raw.githubusercontent.com/mattcodeai91/nevwhisper/holder-scan-data/top-holders.json";
const EXPLORER = "https://q-lock-ecosystem.com/explorer/";

const els = {
  status: document.getElementById("holderStatus"),
  updated: document.getElementById("holderUpdated"),
  summary: document.getElementById("holderSummary"),
  list: document.getElementById("holderList"),
  note: document.getElementById("holderNote")
};

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function shorten(value) {
  const text = String(value || "");
  return text.length > 30 ? text.slice(0, 16) + "..." + text.slice(-12) : text;
}

function percentage(balance, denominator) {
  const b = Number(balance);
  const d = Number(denominator);
  return Number.isFinite(b) && Number.isFinite(d) && d > 0 ? ((b / d) * 100).toFixed(2) + "%" : "—";
}

function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}

function addressUrl(address) {
  return EXPLORER + "#/address/" + encodeURIComponent(address);
}

function render(report) {
  const diagnostics = report.diagnostics || {};
  const maxSupply = diagnostics.maxSupplyNEV || "369369369";
  const top = Array.isArray(report.top10) ? report.top10 : [];

  if (els.updated) els.updated.textContent = report.generatedAt ? "Updated " + new Date(report.generatedAt).toLocaleString() : "—";
  els.summary.innerHTML = [
    ["Chain scanned", "#" + formatNumber(report.chainHeight)],
    ["Positive holders", formatNumber(diagnostics.positiveAddresses)],
    ["Positive balance", (diagnostics.totalPositiveBalanceNEV || "—") + " NEV"]
  ].map(([label, value]) => '<div class="holder-card"><div class="holder-label">' + escapeHtml(label) + '</div><div class="holder-value">' + escapeHtml(value) + '</div></div>').join("");

  els.list.innerHTML = top.length ? top.map(holder => {
    const address = String(holder.address || "");
    const tx = escapeHtml(address);
    return '<article class="holder-row">' +
      '<div class="holder-rank">#' + escapeHtml(holder.rank) + '</div>' +
      '<div><div class="holder-address" title="' + tx + '">' + escapeHtml(shorten(address)) + '</div>' +
      '<div class="holder-actions">' +
      '<a class="holder-action" href="' + escapeHtml(addressUrl(address)) + '" target="_blank" rel="noopener noreferrer">VIEW ↗</a>' +
      '<button class="holder-action" type="button" data-copy-address="' + tx + '">COPY</button>' +
      '</div></div>' +
      '<div class="holder-balance"><div class="holder-amount">' + escapeHtml(holder.balanceNEV) + ' NEV</div>' +
      '<div class="holder-share">' + escapeHtml(percentage(holder.balanceNEV, maxSupply)) + ' of max supply</div></div>' +
      '</article>';
  }).join("") : '<div class="empty">No positive holders in the persisted report.</div>';

  if (els.note) els.note.textContent = "Complete scan: " + formatNumber(report.scannedRange?.start) + " → " + formatNumber(report.scannedRange?.end) + " across " + formatNumber(report.chunksMerged) + " persisted chunks. " + formatNumber(diagnostics.transactions) + " transactions accounted for.";
  if (els.status) { els.status.className = "holder-status live"; els.status.innerHTML = '<span class="status-light" aria-hidden="true"></span><span>Live · Scanned through #' + formatNumber(report.chainHeight) + "</span>"; }

  els.list.querySelectorAll("[data-copy-address]").forEach(button => {
    button.addEventListener("click", async () => {
      const address = button.dataset.copyAddress;
      try {
        await navigator.clipboard.writeText(address);
        const original = button.textContent;
        button.textContent = "COPIED";
        setTimeout(() => { button.textContent = original; }, 1200);
      } catch {
        button.textContent = "COPY FAILED";
        setTimeout(() => { button.textContent = "COPY"; }, 1200);
      }
    });
  });
}

async function load() {
  try {
    const response = await fetch(REPORT + "?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const report = await response.json();
    render(report);
  } catch (error) {
    console.error("Holder report load failed:", error);
    if (els.status) { els.status.className = "holder-status failed"; els.status.innerHTML = '<span class="status-light" aria-hidden="true"></span><span>Failed · Retrying…</span>'; }
  }
}

export function initHoldersView() {
  if (els.status) { els.status.className = "holder-status syncing"; els.status.innerHTML = '<span class="status-light" aria-hidden="true"></span><span>Syncing…</span>'; }
  load();
  setInterval(() => { if (els.status) { els.status.className = "holder-status syncing"; els.status.innerHTML = '<span class="status-light" aria-hidden="true"></span><span>Syncing…</span>'; } load(); }, 15000);
}
