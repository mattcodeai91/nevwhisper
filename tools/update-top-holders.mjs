#!/usr/bin/env node

const fs = await import("node:fs/promises");

const NODE = process.env.NEV369_NODE || "https://q-lock-ecosystem.com/node";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 900);
const RETRIES = 10;
const RETRY_BASE_MS = 2000;
const SATOSHIS_PER_NEV = 100000000n;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asBigInt(value) {
  if (value === null || value === undefined || value === "") return 0n;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`Non-integer amount: ${text}`);
  return BigInt(text);
}

async function paceRequests() {
  const now = Date.now();
  const wait = Math.max(0, (globalThis.nextRequestAt || 0) - now);
  globalThis.nextRequestAt = Math.max(now, globalThis.nextRequestAt || 0) + REQUEST_DELAY_MS;
  if (wait > 0) await sleep(wait);
}

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      await paceRequests();
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.ok) return await response.json();
      const body = await response.text().catch(() => "");
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      lastError = new Error(`${response.status} ${body.slice(0, 300)}`);
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
    }
    const backoff = Math.min(60000, RETRY_BASE_MS * Math.min(16, 2 ** attempt));
    console.log(`retrying after error: ${lastError.message.slice(0, 120)}; wait=${backoff}ms`);
    await sleep(backoff);
  }
  throw lastError;
}

function transactionList(block) {
  return block && Array.isArray(block.transactions) ? block.transactions : [];
}

function applyTransaction(balances, transaction, blockHeight, stats) {
  const sender = transaction.sender ? String(transaction.sender) : "";
  const recipient = transaction.recipient ? String(transaction.recipient) : "";
  const amount = asBigInt(transaction.amount ?? transaction.value ?? 0);
  if (amount < 0n) throw new Error(`Negative amount at block #${blockHeight}`);

  const fee = asBigInt(transaction.fee ?? 0);
  const crownTax = asBigInt(transaction.crown_tax ?? transaction.crownTax ?? 0);

  if (recipient) {
    balances.set(recipient, (balances.get(recipient) || 0n) + amount);
  } else {
    stats.noRecipient++;
  }

  const rewardSender = sender.toUpperCase() === "NETWORK_REWARD";
  if (!rewardSender && sender) {
    balances.set(sender, (balances.get(sender) || 0n) - amount - fee - crownTax);
    stats.transfers++;
  } else if (rewardSender) {
    stats.rewards++;
  } else {
    stats.genesisLike++;
  }

  stats.volume += amount;
  stats.fees += fee;
  stats.crownTax += crownTax;
  stats.transactions++;
  if (blockHeight === 0) stats.genesisTransactions++;
}

async function main() {
  const report = JSON.parse(await fs.readFile("top-holders.json", "utf8"));
  if (report.chain !== "NEV369") throw new Error("Existing holder report is not NEV369");

  const info = await getJson(`${NODE}/info`);
  const tip = Number(info?.chain_height ?? info?.height);
  if (!Number.isInteger(tip) || tip < 0) throw new Error("Could not determine chain height");

  const lastScanned = Number(report.chainHeight);
  if (!Number.isInteger(lastScanned) || lastScanned < -1) {
    throw new Error("Existing holder report has no valid chain height");
  }

  const balances = new Map(
    Object.entries(report.balances || {}).map(([address, value]) => [address, BigInt(value)])
  );

  const diagnostics = report.diagnostics || {};
  const stats = {
    transactions: Number(diagnostics.transactions || 0),
    transfers: Number(diagnostics.transfers || 0),
    rewards: Number(diagnostics.miningRewards || 0),
    genesisLike: Number(diagnostics.genesisLikeTransactions || 0),
    noRecipient: Number(diagnostics.transactionsWithoutRecipient || 0),
    genesisTransactions: Number(diagnostics.genesisTransactions || 0),
    volume: asBigInt(diagnostics.grossTransferredBaseUnits ?? 0),
    fees: asBigInt(diagnostics.feesBaseUnits ?? 0),
    crownTax: asBigInt(diagnostics.crownTaxBaseUnits ?? 0)
  };

  const startHeight = lastScanned + 1;

  console.log(JSON.stringify({
    event: "incremental-start",
    node: NODE,
    previousHeight: lastScanned,
    chainHeight: tip,
    startHeight,
    blocksToScan: Math.max(0, tip - startHeight + 1)
  }));

  if (startHeight <= tip) {
    for (let height = startHeight; height <= tip; height++) {
      const block = await getJson(`${NODE}/block/${height}`);
      for (const transaction of transactionList(block)) {
        applyTransaction(balances, transaction, height, stats);
      }

      if ((height - startHeight + 1) % 25 === 0 || height === tip) {
        console.log(`incremental scan: ${height}/${tip}`);
      }
    }
  } else {
    console.log("Already caught up; no new blocks to scan.");
  }

  const positive = Array.from(balances.entries())
    .filter(([, balance]) => balance > 0n)
    .sort((a, b) => b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0);

  function nev(baseUnits) {
    const negative = baseUnits < 0n;
    const n = negative ? -baseUnits : baseUnits;
    const whole = n / SATOSHIS_PER_NEV;
    const frac = (n % SATOSHIS_PER_NEV).toString().padStart(8, "0").replace(/0+$/, "");
    return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
  }

  const totalPositive = positive.reduce((sum, [, balance]) => sum + balance, 0n);
  const top10 = positive.slice(0, 10).map(([address, balance], index) => ({
    rank: index + 1,
    address,
    balanceBaseUnits: balance.toString(),
    balanceNEV: nev(balance)
  }));

  const nextReport = {
    generatedAt: new Date().toISOString(),
    chain: "NEV369",
    chainHeight: tip,
    scannedRange: {
      start: Number(report.scannedRange?.start ?? 0),
      end: tip
    },
    chunksMerged: report.chunksMerged ?? 0,
    top10,
    balances: Object.fromEntries(
      Array.from(balances.entries()).map(([address, balance]) => [address, balance.toString()])
    ),
    diagnostics: {
      addressesSeen: balances.size,
      positiveAddresses: positive.length,
      negativeAddresses: Array.from(balances.values()).filter(balance => balance < 0n).length,
      totalPositiveBalanceBaseUnits: totalPositive.toString(),
      totalPositiveBalanceNEV: nev(totalPositive),
      maxSupplyNEV: "369369369",
      transactions: stats.transactions,
      transfers: stats.transfers,
      miningRewards: stats.rewards,
      genesisLikeTransactions: stats.genesisLike,
      genesisTransactions: stats.genesisTransactions,
      transactionsWithoutRecipient: stats.noRecipient,
      grossTransferredBaseUnits: stats.volume.toString(),
      grossTransferredNEV: nev(stats.volume),
      feesBaseUnits: stats.fees.toString(),
      feesNEV: nev(stats.fees),
      crownTaxBaseUnits: stats.crownTax.toString(),
      crownTaxNEV: nev(stats.crownTax)
    }
  };

  await fs.writeFile("top-holders.json", JSON.stringify(nextReport, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "incremental-complete",
    previousHeight: lastScanned,
    chainHeight: tip,
    scannedBlocks: Math.max(0, tip - startHeight + 1),
    positiveAddresses: positive.length,
    topHolder: top10[0] || null
  }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
