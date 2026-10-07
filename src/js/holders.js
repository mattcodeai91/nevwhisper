/* NEV369 Top Holders view.
 * Reads the persisted report produced by tools/merge-top-holders.mjs.
 * This module is intentionally read-only: scanning and publishing remain CI responsibilities.
 */
const REPORT = "https://raw.githubusercontent.com/mattcodeai91/nevwhisper/holder-scan-data/top-holders.json";
const NODE = "https://nevwhisper-proxy.mattcodeai91.workers.dev";
const NODE_INFO = NODE + "/info";
const EXPLORER = "https://q-lock-ecosystem.com/explorer/";
const REQUEST_DELAY_MS = 900;
const HISTORICAL_REQUEST_DELAY_MS = 100;
const HISTORICAL_RENDER_EVERY_BLOCKS = 5;
const HISTORICAL_SAVE_EVERY_BLOCKS = 50;
const HISTORICAL_CACHE_KEY = "nevwhisper-holder-rebuild-v2";
const REWARD_ACCOUNTING_VERSION = 2;
const BLOCK_REWARD_BASE_UNITS = 36900000000n;

let liveBalances = null;
let liveScanHeight = -1;
let liveReportHeight = -1;
let liveScanRunning = false;

let historicalBalances = null;
let historicalScanHeight = -1;

const els = {
  status: document.getElementById("holderStatus"),
  statusLabel: document.getElementById("holderStatusLabel"),
  statusDetail: document.getElementById("holderStatusDetail"),
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asBigInt(value) {
  if (value === null || value === undefined || value === "") return 0n;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new Error("Non-integer amount: " + text);
  return BigInt(text);
}

function nestedAddress(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return String(
      value.address ??
      value.recipient ??
      value.miner ??
      value.miner_address ??
      value.minerAddress ??
      ""
    );
  }
  return "";
}

function rewardRecipient(block, transaction) {
  return String(
    transaction.recipient ??
    transaction.to ??
    transaction.miner ??
    transaction.miner_address ??
    transaction.minerAddress ??
    nestedAddress(transaction.reward?.recipient) ??
    nestedAddress(transaction.reward?.address) ??
    nestedAddress(block.miner) ??
    block.miner_address ??
    block.minerAddress ??
    block.reward_recipient ??
    block.rewardRecipient ??
    ""
  );
}

function applyTransaction(balances, transaction, block) {
  const sender = transaction.sender ? String(transaction.sender) : "";
  const rewardSender = sender.toUpperCase() === "NETWORK_REWARD";

  let amount = asBigInt(transaction.amount ?? transaction.value ?? 0);
  let recipient = String(transaction.recipient ?? "");

  // Match the server scanner: protocol issuance is 369 NEV per successful
  // block, including genesis block 0. Do not trust NETWORK_REWARD.amount.
  if (rewardSender) {
    amount = 36900000000n;
    recipient = rewardRecipient(block, transaction);
  }

  const fee = asBigInt(transaction.fee ?? 0);
  const crownTax = asBigInt(transaction.crown_tax ?? transaction.crownTax ?? 0);

  if (amount < 0n) throw new Error("Negative transaction amount");

  if (recipient) {
    balances.set(recipient, (balances.get(recipient) || 0n) + amount);
  }

  if (!rewardSender && sender) {
    balances.set(sender, (balances.get(sender) || 0n) - amount - fee - crownTax);
  }
}

function formatNev(baseUnits) {
  const negative = baseUnits < 0n;
  const value = negative ? -baseUnits : baseUnits;
  const whole = value / 100000000n;
  const fraction = (value % 100000000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");

  return (negative ? "-" : "") + whole.toString() + (fraction ? "." + fraction : "");
}

function setHolderStatus(kind, label, detail) {
  if (els.statusLabel) els.statusLabel.textContent = label;
  if (els.statusDetail) els.statusDetail.textContent = detail;
  if (els.status) {
    els.status.className = "scan-widget " + kind;
    els.status.innerHTML =
      '<span class="status-light" aria-hidden="true"></span><span>' +
      escapeHtml(label) +
      '</span>';
  }
}

function bindCopyButtons() {
  if (!els.list) return;

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

function holderRowsHtml(top, maxSupply, emptyMessage) {
  if (!top.length) {
    return '<div class="empty">' + escapeHtml(emptyMessage) + '</div>';
  }

  return top.map(holder => {
    const address = String(holder.address || "");
    const tx = escapeHtml(address);

    return '<article class="holder-row">' +
      '<div class="holder-rank">#' + escapeHtml(holder.rank) + '</div>' +
      '<div><div class="holder-address" title="' + tx + '">' +
      escapeHtml(shorten(address)) + '</div>' +
      '<div class="holder-actions">' +
      '<a class="holder-action" href="' + escapeHtml(addressUrl(address)) +
      '" target="_blank" rel="noopener noreferrer">VIEW ↗</a>' +
      '<button class="holder-action" type="button" data-copy-address="' +
      tx + '">COPY</button>' +
      '</div></div>' +
      '<div class="holder-balance"><div class="holder-amount">' +
      escapeHtml(holder.balanceNEV) + ' NEV</div>' +
      '<div class="holder-share">' +
      escapeHtml(percentage(holder.balanceNEV, maxSupply)) +
      ' of max supply</div></div>' +
      '</article>';
  }).join("");
}

function saveHistoricalCheckpoint() {
  if (!(historicalBalances instanceof Map) || historicalScanHeight < 0) return;

  try {
    const payload = {
      version: REWARD_ACCOUNTING_VERSION,
      height: historicalScanHeight,
      balances: Object.fromEntries(
        Array.from(historicalBalances.entries()).map(([address, balance]) => [
          address,
          balance.toString()
        ])
      )
    };

    localStorage.setItem(HISTORICAL_CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not persist holder rebuild checkpoint:", error);
  }
}

function restoreHistoricalCheckpoint(liveHeight) {
  if (historicalBalances instanceof Map) return;

  try {
    const raw = localStorage.getItem(HISTORICAL_CACHE_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);
    const height = Number(saved?.height);

    if (
      Number(saved?.version) !== REWARD_ACCOUNTING_VERSION ||
      !Number.isInteger(height) ||
      height < 0 ||
      (Number.isInteger(liveHeight) && height > liveHeight) ||
      !saved?.balances ||
      typeof saved.balances !== "object"
    ) {
      localStorage.removeItem(HISTORICAL_CACHE_KEY);
      return;
    }

    historicalBalances = new Map(
      Object.entries(saved.balances).map(([address, value]) => [
        address,
        BigInt(value)
      ])
    );
    historicalScanHeight = height;
  } catch (error) {
    console.warn("Could not restore holder rebuild checkpoint:", error);
    localStorage.removeItem(HISTORICAL_CACHE_KEY);
  }
}

function renderHistoricalProgress(liveHeight) {
  const live = Number(liveHeight);
  const positive = Array.from(historicalBalances || new Map())
    .filter(([, balance]) => balance > 0n)
    .sort((a, b) => b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0);

  const totalPositive = positive.reduce((sum, [, balance]) => sum + balance, 0n);
  const top = positive.slice(0, 10).map(([address, balance], index) => ({
    rank: index + 1,
    address,
    balanceBaseUnits: balance.toString(),
    balanceNEV: formatNev(balance)
  }));

  if (els.updated) {
    els.updated.textContent =
      "Live rebuild #" + formatNumber(Math.max(0, historicalScanHeight)) +
      (Number.isFinite(live) ? " / #" + formatNumber(live) : "");
  }

  if (els.summary) {
    els.summary.innerHTML = [
      ["Chain scanned", historicalScanHeight >= 0 ? "#" + formatNumber(historicalScanHeight) : "#0"],
      ["Holders", formatNumber(positive.length)],
      ["Circulating Supply", formatNev(totalPositive) + " NEV"]
    ].map(([label, value]) =>
      '<div class="holder-card"><div class="holder-label">' +
      escapeHtml(label) + '</div><div class="holder-value">' +
      escapeHtml(value) + '</div></div>'
    ).join("");
  }

  if (els.list) {
    els.list.innerHTML = holderRowsHtml(
      top,
      "369369369",
      "Scanning genesis blocks… holder addresses will appear here as rewards are verified."
    );
    bindCopyButtons();
  }

  if (els.note) {
    els.note.textContent =
      "Live holder rebuild from Genesis #0. Balances above are recalculated from verified blocks and update continuously while the scan runs.";
  }

  const nextBlock = Math.max(0, historicalScanHeight + 1);
  setHolderStatus(
    historicalScanHeight >= live && Number.isFinite(live) ? "live" : "syncing",
    historicalScanHeight >= live && Number.isFinite(live)
      ? "Chain current"
      : "Historical rebuild",
    historicalScanHeight >= live && Number.isFinite(live)
      ? "Verified through #" + formatNumber(historicalScanHeight)
      : "Scanning block #" + formatNumber(nextBlock) +
        (Number.isFinite(live) ? " of #" + formatNumber(live) : "")
  );
}

async function scanHistoricalBalances(liveHeight) {
  const live = Number(liveHeight);
  if (!Number.isInteger(live) || live < 0) {
    throw new Error("Live chain height unavailable for historical holder rebuild");
  }

  restoreHistoricalCheckpoint(live);

  if (!(historicalBalances instanceof Map)) {
    historicalBalances = new Map();
    historicalScanHeight = -1;
  }

  renderHistoricalProgress(live);

  for (let height = historicalScanHeight + 1; height <= live; height++) {
    const response = await fetch(
      NODE + "/block/" + height + "?t=" + Date.now(),
      { cache: "no-store", headers: { accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error("Historical block #" + height + " HTTP " + response.status);
    }

    const block = await response.json();
    const transactions = Array.isArray(block?.transactions)
      ? block.transactions
      : [];

    for (const transaction of transactions) {
      applyTransaction(historicalBalances, transaction, block);
    }

    historicalScanHeight = height;

    if (
      height === 0 ||
      height === live ||
      height % HISTORICAL_RENDER_EVERY_BLOCKS === 0
    ) {
      renderHistoricalProgress(live);
    }

    if (
      height === live ||
      height % HISTORICAL_SAVE_EVERY_BLOCKS === 0
    ) {
      saveHistoricalCheckpoint();
    }

    if (height < live) {
      await sleep(HISTORICAL_REQUEST_DELAY_MS);
    }
  }

  renderHistoricalProgress(live);
}

function hasValidRewardAccounting(report) {
  const diagnostics = report?.diagnostics || {};
  const version = Number(diagnostics.rewardAccountingVersion || 0);
  if (version >= REWARD_ACCOUNTING_VERSION) return true;

  const rewardCount = Number(diagnostics.miningRewards || 0);
  if (!Number.isFinite(rewardCount) || rewardCount <= 0) return false;

  try {
    const gross = asBigInt(diagnostics.grossTransferredBaseUnits ?? 0);
    const minimumRewardVolume =
      BigInt(Math.max(0, Math.trunc(rewardCount))) * BLOCK_REWARD_BASE_UNITS;
    return gross >= minimumRewardVolume;
  } catch {
    return false;
  }
}

async function renderHistoricalRebuild(report, liveHeight) {
  if (els.updated && report?.generatedAt && historicalScanHeight < 0) {
    els.updated.textContent =
      "Starting live rebuild · legacy snapshot " +
      new Date(report.generatedAt).toLocaleString();
  }

  await scanHistoricalBalances(liveHeight);
}


function render(report, liveHeight = null) {
  const diagnostics = report.diagnostics || {};
  const maxSupply = diagnostics.maxSupplyNEV || "369369369";

  let top = Array.isArray(report.top10) ? report.top10 : [];
  let scannedHeight = Number(report.chainHeight);

  if (liveBalances instanceof Map && liveScanHeight >= scannedHeight) {
    const positive = Array.from(liveBalances.entries())
      .filter(([, balance]) => balance > 0n)
      .sort((a, b) => b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0);

    top = positive.slice(0, 10).map(([address, balance], index) => ({
      rank: index + 1,
      address,
      balanceBaseUnits: balance.toString(),
      balanceNEV: formatNev(balance)
    }));

    const totalPositive = positive.reduce((sum, [, balance]) => sum + balance, 0n);
    scannedHeight = liveScanHeight;

    if (els.updated) {
      els.updated.textContent = report.generatedAt
        ? "Published " + new Date(report.generatedAt).toLocaleString()
        : "—";
    }

    diagnostics.positiveAddresses = positive.length;
    diagnostics.totalPositiveBalanceNEV = formatNev(totalPositive);
  } else if (els.updated) {
    els.updated.textContent = report.generatedAt
      ? "Published " + new Date(report.generatedAt).toLocaleString()
      : "—";
  }

  els.summary.innerHTML = [
    ["Chain scanned", "#" + formatNumber(scannedHeight)],
    ["Holders", formatNumber(diagnostics.positiveAddresses)],
    ["Circulating Supply", (diagnostics.totalPositiveBalanceNEV || "—") + " NEV"]
  ].map(([label, value]) => '<div class="holder-card"><div class="holder-label">' + escapeHtml(label) + '</div><div class="holder-value">' + escapeHtml(value) + '</div></div>').join("");

  els.list.innerHTML = holderRowsHtml(
    top,
    maxSupply,
    "No positive holders in the persisted report."
  );
  bindCopyButtons();

  if (els.note) els.note.textContent = "Complete scan: " + formatNumber(report.scannedRange?.start) + " → " + formatNumber(report.scannedRange?.end) + " across " + formatNumber(report.chunksMerged) + " persisted chunks. " + formatNumber(diagnostics.transactions) + " transactions accounted for.";
  const scanned = Number(scannedHeight);
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
}

async function load() {
  if (liveScanRunning) return;

  liveScanRunning = true;

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
    const reportHeight = Number(report.chainHeight);

    if (!hasValidRewardAccounting(report)) {
      liveBalances = null;
      liveScanHeight = -1;
      liveReportHeight = -1;
      await renderHistoricalRebuild(report, liveHeight);
      return;
    }

    if (historicalBalances instanceof Map) {
      historicalBalances = null;
      historicalScanHeight = -1;
      localStorage.removeItem(HISTORICAL_CACHE_KEY);
    }

    if (
      !(liveBalances instanceof Map) ||
      reportHeight > liveReportHeight ||
      reportHeight > liveScanHeight
    ) {
      liveBalances = new Map(
        Object.entries(report.balances || {}).map(([address, value]) => [
          address,
          BigInt(value)
        ])
      );
      liveReportHeight = reportHeight;
      liveScanHeight = reportHeight;
    }

    if (
      Number.isInteger(liveHeight) &&
      liveHeight > liveScanHeight
    ) {
      setHolderStatus(
        "syncing",
        "Scanning",
        "Verifying new blocks #" + formatNumber(liveScanHeight + 1) + " → #" + formatNumber(liveHeight)
      );

      for (let height = liveScanHeight + 1; height <= liveHeight; height++) {
        const response = await fetch(
          NODE + "/block/" + height + "?t=" + Date.now(),
          { cache: "no-store", headers: { accept: "application/json" } }
        );

        if (!response.ok) {
          throw new Error("Block #" + height + " HTTP " + response.status);
        }

        const block = await response.json();
        const transactions = Array.isArray(block?.transactions)
          ? block.transactions
          : [];

        for (const transaction of transactions) {
          applyTransaction(liveBalances, transaction, block);
        }

        liveScanHeight = height;

        render(report, liveHeight);
        setHolderStatus(
          "syncing",
          "Scanning",
          "Verified #" + formatNumber(height) + " · Live #" + formatNumber(liveHeight)
        );

        if (height < liveHeight) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
    }

    render(report, liveHeight);
  } catch (error) {
    console.error("Holder live scan failed:", error);
    setHolderStatus("failed", "Live scan paused", "Retrying on the next 15-second sync");
  } finally {
    liveScanRunning = false;
  }
}

export function initHoldersView() {
  setHolderStatus("syncing", "Syncing", "Checking latest holder scan…");
  load();
  setInterval(() => {
    load();
  }, 15000);
}
