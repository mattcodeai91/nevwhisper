/* NEV369 Top Holders view.
 * Reads the persisted report produced by tools/merge-top-holders.mjs.
 * This module is intentionally read-only: scanning and publishing remain CI responsibilities.
 */
const REPORT = "https://raw.githubusercontent.com/mattcodeai91/nevwhisper/holder-scan-data/top-holders.json";
const NODE_INFO = "https://q-lock-ecosystem.com/node/info";
const EXPLORER = "https://q-lock-ecosystem.com/explorer/";

const els = {
  status: document.getElementById("holderStatus"),
  statusLabel: document.getElementById("holderStatusLabel"),
  statusDetail: document.getElementById("holderStatusDetail"),
  countdown: document.getElementById("holderCountdown"),
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

function setHolderStatus(kind, label, detail) {
  if (els.statusLabel) els.statusLabel.textContent = label;
  if (els.statusDetail) els.statusDetail.textContent = detail;
  if (els.status) {
    els.status.className = "holder-status " + kind;
    els.status.innerHTML = '<span class="status-light" aria-hidden="true"></span><span>' + escapeHtml(label) + '</span>';
  }
  if (els.countdown) els.countdown.textContent = "Live sync every 15 seconds";
}

function render(report, liveHeight = null) {
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
  const scanned = Number(report.chainHeight);
  const live = Number(liveHeight);
  if (Number.isFinite(live) && Number.isFinite(scanned)) {
    if (scanned >= live) {
      setHolderStatus("live", "Chain current", "Verified through #" + formatNumber(scanned));
    } else {
      setHolderStatus("syncing", "Chain catching up", "Verified through #" + formatNumber(scanned) + " · Live #" + formatNumber(live));
    }
  } else {
    setHolderStatus("syncing", "Syncing", "Live chain height unavailable");
  }

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
    setHolderStatus("syncing", "Syncing", "Checking latest holder scan…");
    const [reportResponse, infoResponse] = await Promise.all([
      fetch(REPORT + "?t=" + Date.now(), { cache: "no-store" }),
      fetch(NODE_INFO + "?t=" + Date.now(), { cache: "no-store" })
    ]);
    if (!reportResponse.ok) throw new Error("Report HTTP " + reportResponse.status);
    if (!infoResponse.ok) throw new Error("Node info HTTP " + infoResponse.status);
    const report = await reportResponse.json();
    const info = await infoResponse.json();
    const liveHeight = Number(info.chain_height ?? info.height);
    render(report, liveHeight);
  } catch (error) {
    console.error("Holder report load failed:", error);
    setHolderStatus("failed", "Failed", "Unable to verify holder scan against the live chain");
  }
}

export function initHoldersView() {
  setHolderStatus("syncing", "Syncing", "Checking latest holder scan…");
  load();
  setInterval(() => {
    setHolderStatus("syncing", "Syncing", "Checking latest holder scan…");
    load();
  }, 15000);
}
