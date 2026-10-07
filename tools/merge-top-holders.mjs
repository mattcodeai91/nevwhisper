#!/usr/bin/env node

const fs = await import("node:fs/promises");
const path = await import("node:path");

const SATOSHIS_PER_NEV = 100000000n;

function nev(baseUnits) {
  const negative = baseUnits < 0n;
  const n = negative ? -baseUnits : baseUnits;
  const whole = n / SATOSHIS_PER_NEV;
  const frac = (n % SATOSHIS_PER_NEV).toString().padStart(8, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

function addMap(target, source) {
  for (const [address, value] of Object.entries(source || {})) {
    const amount = BigInt(value);
    target.set(address, (target.get(address) || 0n) + amount);
  }
}

const root = process.argv[2] || "chunk-output";
const entries = await fs.readdir(root, { withFileTypes: true });
const files = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const file = path.join(root, entry.name, "chunk.json");
  try {
    await fs.access(file);
    files.push(file);
  } catch {}
}

if (!files.length) throw new Error("No chunk reports found");

const balances = new Map();
const stats = {
  transactions: 0,
  transfers: 0,
  rewards: 0,
  genesisLike: 0,
  noRecipient: 0,
  genesisTransactions: 0,
  volume: 0n,
  fees: 0n,
  crownTax: 0n
};

let chainHeight = -1;
let minStart = Infinity;
let maxEnd = -1;

for (const file of files.sort()) {
  const report = JSON.parse(await fs.readFile(file, "utf8"));
  addMap(balances, report.balances);
  chainHeight = Math.max(chainHeight, Number(report.chainHeight));
  minStart = Math.min(minStart, Number(report.effectiveStart));
  maxEnd = Math.max(maxEnd, Number(report.effectiveEnd));
  for (const key of Object.keys(stats)) {
    if (key === "volume" || key === "fees" || key === "crownTax") stats[key] += BigInt(report.stats[key] || "0");
    else stats[key] += Number(report.stats[key] || 0);
  }
}

const nonNegative = Array.from(balances.entries())
  .filter(([, balance]) => balance > 0n)
  .sort((a, b) => b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0);

const top10 = nonNegative.slice(0, 10).map(([address, balance], index) => ({
  rank: index + 1,
  address,
  balanceBaseUnits: balance.toString(),
  balanceNEV: nev(balance)
}));

const totalPositive = nonNegative.reduce((sum, [, balance]) => sum + balance, 0n);
const negativeCount = Array.from(balances.values()).filter(balance => balance < 0n).length;

const report = {
  generatedAt: new Date().toISOString(),
  chain: "NEV369",
  chainHeight,
  scannedRange: { start: minStart, end: maxEnd },
  chunksMerged: files.length,
  top10,
  // Full positive/negative balance state is published so the standalone
  // live page can apply newly verified blocks without rescanning Genesis.
  balances: Object.fromEntries(
    Array.from(balances.entries()).map(([address, balance]) => [
      address,
      balance.toString()
    ])
  ),
  diagnostics: {
    addressesSeen: balances.size,
    positiveAddresses: nonNegative.length,
    negativeAddresses: negativeCount,
    totalPositiveBalanceBaseUnits: totalPositive.toString(),
    totalPositiveBalanceNEV: nev(totalPositive),
    maxSupplyNEV: "369369369",
    transactions: stats.transactions,
    transfers: stats.transfers,
    miningRewards: stats.rewards,
    genesisLikeTransactions: stats.genesisLike,
    genesisTransactions: stats.genesisTransactions,
    transactionsWithoutRecipient: stats.noRecipient,
    grossTransferredNEV: nev(stats.volume),
    feesNEV: nev(stats.fees),
    crownTaxNEV: nev(stats.crownTax)
  }
};

console.log("TOP10_JSON_START");
console.log(JSON.stringify(report, null, 2));
console.log("TOP10_JSON_END");
await fs.writeFile("top-holders.json", JSON.stringify(report, null, 2) + "\n");
