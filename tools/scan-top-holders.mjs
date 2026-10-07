#!/usr/bin/env node

const NODE = process.env.NEV369_NODE || "https://q-lock-ecosystem.com/node";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const RETRIES = 7;
const RETRY_BASE_MS = 750;
const SATOSHIS_PER_NEV = 100000000n;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asBigInt(value) {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Non-integer amount: ${text}`);
  }
  return BigInt(text);
}

function nev(baseUnits) {
  const negative = baseUnits < 0n;
  const n = negative ? -baseUnits : baseUnits;
  const whole = n / SATOSHIS_PER_NEV;
  const frac = (n % SATOSHIS_PER_NEV).toString().padStart(8, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "accept": "application/json" }
      });
      if (response.ok) return await response.json();

      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      const body = await response.text().catch(() => "");
      if (!retryable) throw new Error(`${response.status} ${body.slice(0, 300)}`);
      lastError = new Error(`${response.status} ${body.slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(RETRY_BASE_MS * Math.min(8, 2 ** attempt));
  }
  throw lastError;
}

function transactionList(block) {
  if (!block || !Array.isArray(block.transactions)) return [];
  return block.transactions;
}

function applyTransaction(balances, transaction, blockHeight, stats) {
  const sender = transaction.sender ? String(transaction.sender) : "";
  const recipient = transaction.recipient ? String(transaction.recipient) : "";
  const amount = asBigInt(transaction.amount ?? transaction.value ?? 0);

  if (amount < 0n) throw new Error(`Negative amount at block #${blockHeight}`);

  const fee = asBigInt(transaction.fee ?? 0);
  const crownTax = asBigInt(transaction.crown_tax ?? transaction.crownTax ?? 0);

  if (!recipient) {
    stats.noRecipient++;
  } else {
    balances.set(recipient, (balances.get(recipient) || 0n) + amount);
  }

  const rewardSender = sender.toUpperCase() === "NETWORK_REWARD";

  if (!rewardSender && sender) {
    const debit = amount + fee + crownTax;
    balances.set(sender, (balances.get(sender) || 0n) - debit);
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

  if (blockHeight === 0) {
    stats.genesisTransactions++;
  }
}

async function main() {
  const info = await getJson(`${NODE}/info`);
  const tip = Number(info?.chain_height ?? info?.height);
  if (!Number.isInteger(tip) || tip < 0) {
    throw new Error("Could not determine chain height");
  }

  console.log(JSON.stringify({
    event: "start",
    node: NODE,
    chainHeight: tip,
    concurrency: CONCURRENCY
  }));

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

  let nextHeight = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const height = nextHeight++;
      if (height > tip) return;

      const block = await getJson(`${NODE}/block/${height}`);
      for (const transaction of transactionList(block)) {
        applyTransaction(balances, transaction, height, stats);
      }

      completed++;
      if (completed % 250 === 0 || completed === tip + 1) {
        console.log(`scanned ${completed}/${tip + 1} blocks`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tip + 1) }, worker)
  );

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
    chainHeight: tip,
    top10,
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

  const fs = await import("node:fs/promises");
  await fs.writeFile("top-holders.json", JSON.stringify(report, null, 2) + "\n");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
