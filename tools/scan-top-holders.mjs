#!/usr/bin/env node

const NODE = process.env.NEV369_NODE || "https://q-lock-ecosystem.com/node";
const START_HEIGHT = Number(process.env.START_HEIGHT ?? 0);
const END_HEIGHT = Number(process.env.END_HEIGHT ?? START_HEIGHT + 199);
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
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

  if (recipient) balances.set(recipient, (balances.get(recipient) || 0n) + amount);
  else stats.noRecipient++;

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
  if (!Number.isInteger(START_HEIGHT) || !Number.isInteger(END_HEIGHT) || START_HEIGHT < 0 || END_HEIGHT < START_HEIGHT) {
    throw new Error("Invalid START_HEIGHT/END_HEIGHT");
  }

  const info = await getJson(`${NODE}/info`);
  const tip = Number(info?.chain_height ?? info?.height);
  if (!Number.isInteger(tip) || tip < 0) throw new Error("Could not determine chain height");

  const effectiveStart = Math.min(START_HEIGHT, tip + 1);
  const effectiveEnd = Math.min(END_HEIGHT, tip);

  console.log(JSON.stringify({
    event: "chunk-start",
    node: NODE,
    chainHeight: tip,
    requestedStart: START_HEIGHT,
    requestedEnd: END_HEIGHT,
    effectiveStart,
    effectiveEnd,
    concurrency: CONCURRENCY,
    requestDelayMs: REQUEST_DELAY_MS
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

  if (effectiveStart <= effectiveEnd) {
    let nextHeight = effectiveStart;
    let completed = 0;
    async function worker() {
      while (true) {
        const height = nextHeight++;
        if (height > effectiveEnd) return;
        const block = await getJson(`${NODE}/block/${height}`);
        for (const transaction of transactionList(block)) applyTransaction(balances, transaction, height, stats);
        completed++;
        if (completed % 25 === 0 || completed === effectiveEnd - effectiveStart + 1) {
          console.log(`chunk ${effectiveStart}-${effectiveEnd}: scanned ${completed}/${effectiveEnd - effectiveStart + 1} blocks`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, effectiveEnd - effectiveStart + 1) }, worker));
  }

  const serialBalances = {};
  for (const [address, balance] of balances) serialBalances[address] = balance.toString();

  const report = {
    generatedAt: new Date().toISOString(),
    chain: "NEV369",
    chainHeight: tip,
    startHeight: START_HEIGHT,
    endHeight: END_HEIGHT,
    effectiveStart,
    effectiveEnd,
    balances: serialBalances,
    stats: {
      transactions: stats.transactions,
      transfers: stats.transfers,
      rewards: stats.rewards,
      genesisLike: stats.genesisLike,
      noRecipient: stats.noRecipient,
      genesisTransactions: stats.genesisTransactions,
      volume: stats.volume.toString(),
      fees: stats.fees.toString(),
      crownTax: stats.crownTax.toString()
    }
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("chunk-output", { recursive: true });
  await fs.writeFile("chunk-output/chunk.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "chunk-complete",
    startHeight: START_HEIGHT,
    endHeight: END_HEIGHT,
    effectiveStart,
    effectiveEnd,
    addresses: balances.size,
    transactions: stats.transactions
  }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
