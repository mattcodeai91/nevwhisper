import { initHoldersView } from "./holders.js?v=20261008-2";

/* NevWhisper main application.
 * Extracted from the original production page without changing scanner logic.
 * UI, IndexedDB archive, raw-block recovery, and live polling remain here.
 */
"use strict";

/* ==================================================
   CONFIGURATION
================================================== */

const NODE =
  "https://nevwhisper-proxy.mattcodeai91.workers.dev";

const DB_NAME = "nevwhisper-genesis-v1";
const DB_VERSION = 1;

const BATCH_SIZE = 10;

const LIVE_POLL_MS = 15000;

/*
  Automated verification mode.

  This does not alter the normal UI or scanner behavior.
  It is used by the repository's CI test to exercise the
  real production parser, raw-block path, persistence,
  and proxy against existing chain data without requiring
  a user to send a paid transaction.
*/
const SELF_TEST_MODE =
  new URLSearchParams(window.location.search).get("selftest") === "1";

/*
  Rolling backfill.

  The normal scanner advances verifiedThrough and
  therefore never revisits an already verified block.

  A small rolling recheck makes the archive resilient
  to whispers becoming available through the upstream
  /whispers endpoint after the original scan.

  This is deliberately small so we do not hammer
  the proxy or rebuild the chain.
*/
const BACKFILL_BLOCKS = 20;

const MAX_RETRIES = 4;
const RETRY_DELAY = 1500;

const MINER_WINDOW_BLOCKS = 100;
const MINER_CACHE_KEY = "nevwhisper-miners-v1";
const MINER_REFRESH_MS = 30000;

const DEDICATION_REPORT =
  "https://raw.githubusercontent.com/mattcodeai91/nevwhisper/dedication-scan-data/dedications.json";
const DEDICATION_REPORT_POLL_MS = 60000;


/* ==================================================
   STATE
================================================== */

const state = {
  verifiedThrough: -1,
  chainHeight: -1,

  /*
    IMPORTANT:

    This Map is keyed by transaction hash,
    NOT block number.

    Multiple whisper transactions can exist
    in the same block.
  */
  whispers: new Map(),

  scanning: false,
  stopRequested: false,

  latestArchitect: null,

  /*
    Highlight individual transactions rather
    than entire blocks.
  */
  newWhisperTxs: new Set(),

  livePollTimer: null,
  livePollRunning: false
};


const minerState = {
  running: false,
  chainHeight: -1,
  blocks: new Map(),
  timer: null,
  loadedCache: false
};

let dedicationReportRunning = false;
let dedicationReportTimer = null;


/* ==================================================
   DOM
================================================== */

const els = {
  statusLabel:
    document.getElementById("statusLabel"),

  statusDetail:
    document.getElementById("statusDetail"),

  scanWidget:
    document.getElementById("memoScanWidget"),

  liveDot:
    document.getElementById("liveDot"),

  liveStatus:
    document.getElementById("liveStatus"),

  architectMessage:
    document.getElementById("architectMessage"),

  architectMeta:
    document.getElementById("architectMeta"),

  chainHeight:
    document.getElementById("chainHeight"),

  verifiedThrough:
    document.getElementById("verifiedThrough"),

  whisperCount:
    document.getElementById("whisperCount"),

  blocksRemaining:
    document.getElementById("blocksRemaining"),

  progressPercent:
    document.getElementById("progressPercent"),

  progressFill:
    document.getElementById("progressFill"),

  search:
    document.getElementById("search"),

  whispers:
    document.getElementById("whispers"),

  sectionCount:
    document.getElementById("sectionCount"),

  rebuild:
    document.getElementById("rebuild")
};


const minerEls = {
  view:
    document.getElementById("minersView"),

  status:
    document.getElementById("minerStatus"),

  statusLabel:
    document.getElementById("minerStatusLabel"),

  statusDetail:
    document.getElementById("minerStatusDetail"),

  summary:
    document.getElementById("minerSummary"),

  progressPercent:
    document.getElementById("minerProgressPercent"),

  progressFill:
    document.getElementById("minerProgressFill"),

  updated:
    document.getElementById("minerUpdated"),

  list:
    document.getElementById("minerList"),

  note:
    document.getElementById("minerNote")
};


/* ==================================================
   HELPERS
================================================== */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function shorten(value, start = 12, end = 10) {
  if (!value) {
    return "—";
  }

  const text = String(value);

  if (text.length <= start + end + 3) {
    return text;
  }

  return (
    text.slice(0, start) +
    "..." +
    text.slice(-end)
  );
}


function formatNumber(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return "—";
  }

  return n.toLocaleString();
}


function formatAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "—";
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return String(value);
  }

  const nev = n / 100000000;

  return (
    nev.toLocaleString(undefined, {
      maximumFractionDigits: 8
    }) +
    " NEV"
  );
}


function formatTimestamp(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "Unknown time";
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    const d = new Date(value);

    return Number.isNaN(d.getTime())
      ? "Unknown time"
      : d.toLocaleString();
  }

  let milliseconds;

  if (n < 1e12) {
    milliseconds = n * 1000;
  } else if (n < 1e15) {
    milliseconds = n;
  } else if (n < 1e18) {
    milliseconds = n / 1000;
  } else {
    milliseconds = n / 1000000;
  }

  const d = new Date(milliseconds);

  return Number.isNaN(d.getTime())
    ? "Unknown time"
    : d.toLocaleString();
}


function txUrl(tx) {
  if (!tx) {
    return "#";
  }

  return (
    "https://q-lock-ecosystem.com/explorer/#/tx/" +
    encodeURIComponent(tx)
  );
}


function blockUrl(height) {
  return (
    "https://q-lock-ecosystem.com/explorer/#/block/" +
    encodeURIComponent(height)
  );
}


function addressUrl(address) {
  if (!address) {
    return "#";
  }

  return (
    "https://q-lock-ecosystem.com/explorer/#/address/" +
    encodeURIComponent(address)
  );
}


/* ==================================================
   DATABASE
================================================== */

let dbPromise = null;


function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {

    const request =
      indexedDB.open(
        DB_NAME,
        DB_VERSION
      );

    request.onupgradeneeded = event => {

      const db =
        event.target.result;

      if (
        !db.objectStoreNames.contains(
          "meta"
        )
      ) {
        db.createObjectStore("meta");
      }

      if (
        !db.objectStoreNames.contains(
          "whispers"
        )
      ) {
        db.createObjectStore(
          "whispers",
          {
            keyPath: "tx_hash"
          }
        );
      }
    };

    request.onsuccess = () => {

      const db =
        request.result;

      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      reject(request.error);
    };

  });

  return dbPromise;
}


async function dbGet(
  storeName,
  key
) {
  const db =
    await openDb();

  return new Promise(
    (resolve, reject) => {

      const tx =
        db.transaction(
          storeName,
          "readonly"
        );

      const store =
        tx.objectStore(
          storeName
        );

      const request =
        store.get(key);

      request.onsuccess =
        () => resolve(
          request.result
        );

      request.onerror =
        () => reject(
          request.error
        );
    }
  );
}


async function dbGetAll(
  storeName
) {
  const db =
    await openDb();

  return new Promise(
    (resolve, reject) => {

      const tx =
        db.transaction(
          storeName,
          "readonly"
        );

      const store =
        tx.objectStore(
          storeName
        );

      const request =
        store.getAll();

      request.onsuccess =
        () => resolve(
          request.result || []
        );

      request.onerror =
        () => reject(
          request.error
        );
    }
  );
}


async function dbPut(
  storeName,
  value,
  key
) {
  const db =
    await openDb();

  return new Promise(
    (resolve, reject) => {

      const tx =
        db.transaction(
          storeName,
          "readwrite"
        );

      const store =
        tx.objectStore(
          storeName
        );

      let request;

      /*
        meta uses out-of-line keys.

        whispers uses keyPath tx_hash.
      */

      if (key === undefined) {
        request =
          store.put(value);
      } else {
        request =
          store.put(
            value,
            key
          );
      }

      request.onsuccess =
        () => resolve();

      request.onerror =
        () => reject(
          request.error
        );
    }
  );
}


async function dbClear(
  storeName
) {
  const db =
    await openDb();

  return new Promise(
    (resolve, reject) => {

      const tx =
        db.transaction(
          storeName,
          "readwrite"
        );

      const store =
        tx.objectStore(
          storeName
        );

      const request =
        store.clear();

      request.onsuccess =
        () => resolve();

      request.onerror =
        () => reject(
          request.error
        );
    }
  );
}


/* ==================================================
   DATABASE LOAD
================================================== */

async function loadDatabase() {

  const verified =
    await dbGet(
      "meta",
      "verifiedThrough"
    );

  const height =
    await dbGet(
      "meta",
      "chainHeight"
    );

  const whisperRecords =
    await dbGetAll(
      "whispers"
    );

  state.verifiedThrough =
    Number.isFinite(
      Number(verified)
    )
      ? Number(verified)
      : -1;

  state.chainHeight =
    Number.isFinite(
      Number(height)
    )
      ? Number(height)
      : -1;

  state.whispers.clear();

  /*
    Load EVERY whisper.

    Key the in-memory Map by tx_hash so
    multiple messages in the same block
    cannot overwrite one another.
  */

  for (
    const raw of whisperRecords
  ) {

    const whisper =
      normalizeWhisper(
        raw
      );

    if (
      !whisper ||
      !whisper.tx_hash
    ) {
      continue;
    }

    state.whispers.set(
      whisper.tx_hash,
      whisper
    );
  }

  /*
    First establish the Architect address
    from the Genesis Architect transaction.
  */

  architectAddress = null;

  for (
    const whisper of
    state.whispers.values()
  ) {

    establishArchitectAddress(
      whisper
    );
  }

  /*
    Then reconstruct the latest Architect
    message from ALL stored whispers.
  */

  state.latestArchitect =
    null;

  for (
    const whisper of
    state.whispers.values()
  ) {

    if (
      isArchitectWhisper(
        whisper
      )
    ) {

      if (
        !state.latestArchitect ||
        compareWhispers(
          whisper,
          state.latestArchitect
        ) > 0
      ) {

        state.latestArchitect =
          whisper;
      }
    }
  }
}


async function saveCheckpoint() {

  await dbPut(
    "meta",
    state.verifiedThrough,
    "verifiedThrough"
  );

  await dbPut(
    "meta",
    state.chainHeight,
    "chainHeight"
  );
}


async function saveWhisper(
  whisper
) {

  if (
    !whisper ||
    !whisper.tx_hash
  ) {
    return;
  }

  await dbPut(
    "whispers",
    whisper
  );
}


/* ==================================================
   NETWORK
================================================== */

async function sleep(ms) {
  return new Promise(
    resolve => {
      setTimeout(
        resolve,
        ms
      );
    }
  );
}


async function getJson(
  path,
  attempt = 0
) {

  try {

    const response =
      await fetch(
        NODE.replace(
          /\/$/,
          ""
        ) + path,
        {
          cache: "no-store"
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      data =
        text;
    }

    if (!response.ok) {

      const error =
        new Error(
          `${response.status} — ${
            data &&
            data.error
              ? data.error
              : response.statusText
          }`
        );

      error.status =
        response.status;

      error.retryAfter =
        response.headers.get(
          "Retry-After"
        );

      throw error;
    }

    return data;

  } catch (error) {

    if (
      attempt >= MAX_RETRIES
    ) {
      throw error;
    }

    let delay =
      RETRY_DELAY *
      Math.pow(
        2,
        attempt
      );

    const retryAfter =
      Number(
        error?.retryAfter
      );

    if (
      Number.isFinite(
        retryAfter
      ) &&
      retryAfter > 0
    ) {
      delay =
        Math.max(
          delay,
          retryAfter * 1000
        );
    }

    delay +=
      Math.floor(
        Math.random() * 500
      );

    await sleep(delay);

    return getJson(
      path,
      attempt + 1
    );
  }
}


async function getInfo() {

  const data =
    await getJson(
      "/info"
    );

  const height =
    Number(
      data?.height ??
      data?.chain_height
    );

  if (
    !Number.isFinite(height)
  ) {
    throw new Error(
      "Node returned no valid chain height."
    );
  }

  state.chainHeight =
    height;

  await dbPut(
    "meta",
    state.chainHeight,
    "chainHeight"
  );

  return data;
}


/* ==================================================
   WHISPER NORMALISATION
================================================== */

function firstValue(
  object,
  keys
) {

  for (
    const key of keys
  ) {

    if (
      object &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return null;
}


function normalizeWhisper(
  item
) {

  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  const blockValue =
    firstValue(
      item,
      [
        "block",
        "height",
        "block_height",
        "blockHeight",
        "index"
      ]
    );

  const block =
    Number(blockValue);

  if (
    !Number.isFinite(block)
  ) {
    return null;
  }

  const memo =
    firstValue(
      item,
      [
        "memo",
        "payload_memo",
        "message",
        "text"
      ]
    );

  if (
    memo === null ||
    memo === undefined ||
    String(memo).trim() === ""
  ) {
    return null;
  }

  const sender =
    firstValue(
      item,
      [
        "from",
        "sender",
        "from_address",
        "sender_address"
      ]
    );

  const to =
    firstValue(
      item,
      [
        "to",
        "recipient",
        "to_address",
        "recipient_address"
      ]
    );

  const txHash =
    firstValue(
      item,
      [
        "tx_hash",
        "tx",
        "txid",
        "transaction_hash",
        "transaction",
        "hash"
      ]
    );

  if (
    txHash === null ||
    txHash === undefined ||
    String(txHash).trim() === ""
  ) {
    return null;
  }

  const kind =
    item.kind
      ? String(item.kind)
      : "transaction";

  const tx =
    kind === "block_dedication"
      ? ""
      : String(txHash);

  const timestamp =
    firstValue(
      item,
      [
        "timestamp",
        "time",
        "created_at",
        "block_timestamp"
      ]
    );

  const amount =
    firstValue(
      item,
      [
        "amount",
        "value",
        "amount_base_units"
      ]
    );

  return {
    block,

    memo:
      String(memo),

    sender:
      sender
        ? String(sender)
        : "",

    to:
      to
        ? String(to)
        : "",

    tx,

    tx_hash:
      String(txHash),

    timestamp,

    amount,

    kind
  };
}


/*
  Block dedications are chain-level metadata, not transaction
  memos. Ordinary NEV369 blocks use the standard dedication
  "Block N — for Nevaeh". Those standard entries are ignored.

  Only exceptional/custom dedications are promoted into the
  whisper archive.
*/

function specialBlockDedicationFromPayload(
  payload,
  block
) {

  if (
    !payload ||
    typeof payload !== "object"
  ) {
    return null;
  }

  const height =
    Number(block);

  if (
    !Number.isFinite(height)
  ) {
    return null;
  }

  const dedication =
    firstValue(
      payload,
      [
        "block_dedication",
        "dedication"
      ]
    );

  if (
    dedication === null ||
    dedication === undefined ||
    String(dedication).trim() === ""
  ) {
    return null;
  }

  const text =
    String(dedication).trim();

  const standardPattern =
    new RegExp(
      "^Block\\s+" +
      String(height) +
      "\\s*[—–-]\\s*for\\s+Nevaeh\\s*$",
      "i"
    );

  if (
    standardPattern.test(text)
  ) {
    return null;
  }

  const timestamp =
    firstValue(
      payload,
      [
        "timestamp",
        "time",
        "created_at",
        "block_timestamp"
      ]
    );

  return {
    block: height,
    memo:
      "BLOCK DEDICATION — " +
      text,
    sender: "",
    to: "",
    tx: "",
    tx_hash:
      "block-dedication:" +
      height,
    timestamp,
    amount: null,
    kind: "block_dedication"
  };
}


function extractWhispers(
  payload
) {

  /*
    Always walk the complete response tree.

    /whispers may return a flat array, while /scan
    can return blocks containing transactions several
    levels down. Returning early from payload.data or
    payload.items can hide memo-bearing transactions.
  */

  if (
    payload === null ||
    payload === undefined
  ) {
    return [];
  }

  const found = [];

  function walk(
    value,
    inheritedBlock = null
  ) {

    if (
      Array.isArray(value)
    ) {

      for (
        const item of value
      ) {
        walk(
          item,
          inheritedBlock
        );
      }

      return;
    }

    if (
      !value ||
      typeof value !== "object"
    ) {
      return;
    }

    const localBlock =
      firstValue(
        value,
        [
          "block",
          "height",
          "block_height",
          "blockHeight",
          "index"
        ]
      );

    const block =
      Number(localBlock);

    const currentBlock =
      Number.isFinite(block)
        ? block
        : inheritedBlock;

    const memo =
      firstValue(
        value,
        [
          "memo",
          "payload_memo",
          "message",
          "text"
        ]
      );

    const txHash =
      firstValue(
        value,
        [
          "tx_hash",
          "tx",
          "txid",
          "transaction_hash",
          "transaction",
          "hash"
        ]
      );

    if (
      memo !== null &&
      memo !== undefined &&
      String(memo).trim() !== "" &&
      txHash !== null &&
      txHash !== undefined &&
      String(txHash).trim() !== ""
    ) {

      found.push({
        ...value,
        block:
          Number.isFinite(currentBlock)
            ? currentBlock
            : value.block
      });
    }

    for (
      const key of Object.keys(value)
    ) {

      if (
        key === "memo" ||
        key === "payload_memo" ||
        key === "message" ||
        key === "text"
      ) {
        continue;
      }

      const child =
        value[key];

      if (
        child &&
        typeof child === "object"
      ) {
        walk(
          child,
          Number.isFinite(currentBlock)
            ? currentBlock
            : inheritedBlock
        );
      }
    }
  }

  walk(payload);

  /*
    If the node returned a single block object with
    no transaction-level memo, preserve it so the normal
    normalizer can inspect the block shape.
  */

  if (
    found.length === 0 &&
    payload &&
    typeof payload === "object" &&
    (
      payload.block !== undefined ||
      payload.height !== undefined ||
      payload.index !== undefined
    )
  ) {
    return [payload];
  }

  return found;
}


/* ==================================================
   REWARD FILTER
================================================== */

function isNetworkReward(
  whisper
) {

  const sender =
    String(
      whisper?.sender || ""
    )
      .trim()
      .toUpperCase();

  const memo =
    String(
      whisper?.memo || ""
    )
      .trim();

  if (
    sender ===
    "NETWORK_REWARD"
  ) {
    return true;
  }

  if (
    /^Block\s+\d+\s+reward$/i.test(
      memo
    )
  ) {
    return true;
  }

  return false;
}


/* ==================================================
   ARCHITECT DETECTION
================================================== */

let architectAddress = null;


function establishArchitectAddress(
  whisper
) {

  if (!whisper) {
    return;
  }

  if (
    Number(whisper.block) === 0 &&
    String(
      whisper.sender || ""
    )
      .trim()
      .toUpperCase() === "GENESIS" &&
    /genesis premine/i.test(
      String(
        whisper.memo || ""
      )
    ) &&
    /architect/i.test(
      String(
        whisper.memo || ""
      )
    ) &&
    !/nevaeh vault/i.test(
      String(
        whisper.memo || ""
      )
    ) &&
    whisper.to
  ) {

    architectAddress =
      String(
        whisper.to
      )
        .trim()
        .toLowerCase();
  }
}


function isArchitectWhisper(
  whisper
) {

  if (!whisper) {
    return false;
  }

  const sender =
    String(
      whisper.sender || ""
    )
      .trim()
      .toUpperCase();

  /*
    Explicit Genesis Architect identity.
  */

  if (
    sender === "GENESIS" &&
    Number(whisper.block) === 0 &&
    /architect/i.test(
      String(
        whisper.memo || ""
      )
    ) &&
    !/nevaeh vault/i.test(
      String(
        whisper.memo || ""
      )
    )
  ) {

    establishArchitectAddress(
      whisper
    );

    return true;
  }

  /*
    Explicit Architect labels supplied
    by a future node implementation.
  */

  if (
    sender === "ARCHITECT" ||
    sender === "THE ARCHITECT"
  ) {
    return true;
  }

  /*
    Future Architect messages must originate
    from the actual Architect address.

    Merely saying "Architect" in a user's memo
    is NOT enough.
  */

  if (
    architectAddress &&
    String(
      whisper.sender || ""
    )
      .trim()
      .toLowerCase() ===
      architectAddress
  ) {
    return true;
  }

  return false;
}


/*
  Deterministic ordering for whispers.

  Block is primary. Timestamp is secondary.
  Transaction hash provides a stable tie-breaker.
*/

function compareWhispers(
  a,
  b
) {

  const blockA =
    Number(a?.block);

  const blockB =
    Number(b?.block);

  if (
    blockA !== blockB
  ) {
    return blockA - blockB;
  }

  const timeA =
    Number(a?.timestamp);

  const timeB =
    Number(b?.timestamp);

  if (
    Number.isFinite(timeA) &&
    Number.isFinite(timeB) &&
    timeA !== timeB
  ) {
    return timeA - timeB;
  }

  return String(
    a?.tx_hash || ""
  ).localeCompare(
    String(
      b?.tx_hash || ""
    )
  );
}


function updateArchitect(
  whisper
) {

  if (
    !isArchitectWhisper(
      whisper
    )
  ) {
    return;
  }

  if (
    !state.latestArchitect ||
    compareWhispers(
      whisper,
      state.latestArchitect
    ) > 0
  ) {

    state.latestArchitect =
      whisper;

    renderArchitect();
  }
}


/* ==================================================
   SAVE / MERGE WHISPERS
================================================== */

async function processBlockPayload(
  payload,
  block,
  markNew = true
) {

  const found = [];

  /*
    Process the authoritative transaction list first.
  */
  if (
    payload &&
    Array.isArray(payload.transactions)
  ) {

    const transactions =
      payload.transactions.map(
        transaction => ({
          ...transaction,
          block
        })
      );

    found.push(
      ...await processWhisperPayload(
        transactions,
        block,
        block,
        markNew
      )
    );

  } else {

    found.push(
      ...await processWhisperPayload(
        payload,
        block,
        block,
        markNew
      )
    );
  }

  /*
    Promote only exceptional/custom block dedications.
    The standard "Block N — for Nevaeh" dedication is
    intentionally ignored so it cannot flood Whispers.
  */

  const dedication =
    specialBlockDedicationFromPayload(
      payload,
      block
    );

  if (
    dedication
  ) {

    found.push(
      ...await processWhisperPayload(
        [dedication],
        block,
        block,
        markNew
      )
    );
  }

  return found;
}

async function processWhisperPayload(
  payload,
  startHeight,
  endHeight,
  markNew = true
) {

  const raw =
    extractWhispers(
      payload
    );

  const found =
    [];

  for (
    const item of raw
  ) {

    const whisper =
      normalizeWhisper(
        item
      );

    if (!whisper) {
      continue;
    }

    if (
      isNetworkReward(
        whisper
      )
    ) {
      continue;
    }

    if (
      whisper.block <
      startHeight ||
      whisper.block >
      endHeight
    ) {
      continue;
    }

    /*
      Establish Architect identity as soon
      as the Genesis record is encountered.
    */

    establishArchitectAddress(
      whisper
    );

    const existed =
      state.whispers.has(
        whisper.tx_hash
      );

    /*
      IndexedDB uses tx_hash as the key,
      so updating an existing transaction
      is safe and deterministic.
    */

    await saveWhisper(
      whisper
    );

    state.whispers.set(
      whisper.tx_hash,
      whisper
    );

    found.push(
      whisper
    );

    updateArchitect(
      whisper
    );

    /*
      Only highlight genuinely new
      transactions, not every rolling
      backfill result.
    */

    if (
      markNew &&
      !existed
    ) {

      state.newWhisperTxs.add(
        whisper.tx_hash
      );
    }
  }

  return found;
}


/* ==================================================
   SCANNING
================================================== */

async function scanBatch(
  startHeight,
  endHeight
) {

  setScanningStatus(
    `Scanning #${startHeight} → #${endHeight}`,
    `Verifying ${endHeight - startHeight + 1} blocks`
  );

  /*
    The raw /block endpoint is the authoritative source for
    transactions in a block.

    The aggregate /whispers endpoint can lag behind the raw
    block/explorer. If we use /whispers as the only source,
    a real memo can be missed even though the block itself
    has already been approved and scanned.

    Process every block directly from its transactions.
    The checkpoint is advanced only after every block in
    this batch has been fetched and processed successfully.
  */
  for (
    let height = startHeight;
    height <= endHeight;
    height++
  ) {

    const payload =
      await getJson(
        `/block/${height}?_=${Date.now()}`
      );

    const found =
      await processBlockPayload(
        payload,
        height,
        true
      );

    /*
      Zero whispers is valid. A block may contain only
      the network reward, which is intentionally filtered.
    */
    console.debug(
      `NevWhisper block #${height} processed:`,
      found.length,
      "whisper(s)"
    );
  }

  /*
    Only mark the range verified after ALL raw blocks
    were successfully processed.
  */
  state.verifiedThrough =
    endHeight;

  await saveCheckpoint();

  renderAll();
}


/* ==================================================
   ROLLING BACKFILL
================================================== */

async function backfillRecentBlocks() {

  if (
    state.verifiedThrough < 0 ||
    state.chainHeight < 0
  ) {
    return 0;
  }

  /*
    Recovery is deliberately independent of the moving
    recent-window. A memo can be missed by /whispers during
    the original archive pass and then fall permanently
    outside a rolling window.

    We therefore recheck a fixed recovery band behind the
    verified checkpoint using the raw /block endpoint.
    This preserves the normal fast archive scan while giving
    missed memo transactions a second path into the archive.
  */

  const endHeight =
    state.chainHeight;

  const startHeight =
    Math.max(
      0,
      endHeight -
        Math.max(
          BACKFILL_BLOCKS,
          50
        ) +
        1
    );

  let foundCount = 0;

  for (
    let height = startHeight;
    height <= endHeight;
    height++
  ) {

    try {

      const payload =
        await getJson(
          `/block/${height}?_=${Date.now()}`
        );

      const found =
        await processBlockPayload(
          payload,
          height,
          true
        );

      foundCount +=
        found.length;

    } catch (error) {

      console.warn(
        `Block recovery failed for #${height}:`,
        error
      );
    }

    /*
      Keep recovery gentle on the public node.
    */

    await sleep(250);
  }

  if (
    foundCount > 0
  ) {
    renderAll();
  }

  return foundCount;
}


/*
  Recover a specific historical block directly.

  This is used for a memo that was missed during the
  original /whispers archive pass. It does not alter the
  verified checkpoint.
*/

async function recoverHistoricalBlock(
  height
) {

  const block =
    Number(height);

  if (
    !Number.isFinite(block) ||
    block < 0
  ) {
    return 0;
  }

  try {

    const payload =
      await getJson(
        `/block/${block}?_=${Date.now()}`
      );

    /*
      Block #5960 is a known historical recovery target.

      The raw node response stores the block height on
      the block object and the memo/hash on each nested
      transaction. Process the transaction list directly
      as a deterministic fallback so this known memo cannot
      be missed by the generic recursive parser.
    */

    /*
      For this known recovery block, process the raw
      transaction array explicitly. Do this regardless of
      what the generic recursive parser found, because the
      block contains both a network reward and a user memo.
      The reward is filtered by processWhisperPayload and
      the user transaction is persisted by tx_hash.
    */

    const found =
      await processBlockPayload(
        payload,
        block,
        true
      );

    if (
      found.length > 0
    ) {
      renderAll();
    }

    return found.length;

  } catch (error) {

    console.warn(
      `Historical block recovery failed for #${block}:`,
      error
    );

    return 0;
  }
}


async function startScan() {

  if (
    state.scanning
  ) {
    return;
  }

  state.scanning =
    true;

  state.stopRequested =
    false;

  setScanningStatus(
    "Scanning archive…",
    "Genesis → live chain"
  );

  try {

    /*
      Refresh the live tip before deciding
      what range needs verification.
    */

    await getInfo();

    while (
      !state.stopRequested
    ) {

      const nextStart =
        state.verifiedThrough + 1;

      if (
        nextStart >
        state.chainHeight
      ) {

        setCurrentStatus();

        renderAll();

        return;
      }

      const nextEnd =
        Math.min(
          nextStart +
            BATCH_SIZE -
            1,
          state.chainHeight
        );

      await scanBatch(
        nextStart,
        nextEnd
      );
    }

  } catch (error) {

    console.error(
      "NevWhisper scanner error:",
      error
    );

    setErrorStatus(
      "Scanner paused",
      error?.message ||
      "Unable to reach the NEV369 proxy."
    );

    renderAll();

  } finally {

    state.scanning =
      false;
  }
}


/* ==================================================
   LIVE 15-SECOND SYNC
================================================== */

async function pollLiveTip() {

  if (
    state.livePollRunning
  ) {
    return;
  }

  state.livePollRunning =
    true;

  try {

    const oldHeight =
      state.chainHeight;

    const data =
      await getInfo();

    const newHeight =
      Number(
        data?.height ??
        data?.chain_height
      );

    if (
      Number.isFinite(
        newHeight
      ) &&
      newHeight >
      oldHeight
    ) {

      /*
        The running scanner will consume
        the new range after its current batch.

        If idle, start immediately.
      */

      renderAll();

      if (
        !state.scanning
      ) {

        setScanningStatus(
          "New blocks detected",
          `Scanning #${oldHeight + 1} → #${newHeight}`
        );

        await startScan();

        /*
          A newly mined block can contain a memo that is
          visible through the raw /block endpoint before it
          is exposed by the aggregate /whispers endpoint.

          The scanner above advances the verified checkpoint
          using /whispers. Immediately recheck the rolling
          live window through /block so a brand-new whisper
          cannot be missed just because the aggregate index
          has not caught up yet.
        */
        try {
          await backfillRecentBlocks();
          setCurrentStatus();
          renderAll();
        } catch (backfillError) {
          console.warn(
            "New-block whisper backfill failed:",
            backfillError
          );
          setCurrentStatus();
          renderAll();
        }
      }

    } else if (
      !state.scanning &&
      state.verifiedThrough <
      state.chainHeight
    ) {

      await startScan();

    } else if (
      !state.scanning
    ) {

      /*
        IMPORTANT:

        Even when the chain has not moved,
        recheck the recent verified window.

        This is what catches a whisper such as
        block #5960 if the first /whispers scan
        failed to expose it.
      */

      try {

        const found =
          await backfillRecentBlocks();

        if (
          found > 0
        ) {

          setCurrentStatus();
          renderAll();

        } else {

          setCurrentStatus();
          renderAll();
        }

      } catch (backfillError) {

        /*
          A backfill failure must NOT make the
          entire live archive appear broken.

          The main verified checkpoint remains valid.
        */

        console.warn(
          "Recent whisper backfill failed:",
          backfillError
        );

        setCurrentStatus();
        renderAll();
      }
    }

  } catch (error) {

    console.warn(
      "Live tip check failed:",
      error
    );

    if (
      !state.scanning
    ) {

      setErrorStatus(
        "Live sync paused",
        error?.message ||
        "Waiting for the next live check."
      );

      renderAll();
    }

  } finally {

    state.livePollRunning =
      false;
  }
}


function startLivePolling() {

  stopLivePolling();

  /*
    First live check happens immediately.
  */

  pollLiveTip();

  state.livePollTimer =
    setInterval(
      () => {
        pollLiveTip();
      },
      LIVE_POLL_MS
    );
}


function stopLivePolling() {

  if (
    state.livePollTimer
  ) {

    clearInterval(
      state.livePollTimer
    );

    state.livePollTimer =
      null;
  }
}


/* ==================================================
   STATUS
================================================== */

function setMemoScanWidget(kind, label) {
  if (els.scanWidget) {
    els.scanWidget.className = "scan-widget " + kind;
  }

  if (els.liveStatus) {
    els.liveStatus.textContent = label;
  }
}

function setScanningStatus(
  label,
  detail
) {

  const scanningLabel =
    "Scanning";

  els.statusLabel.textContent =
    scanningLabel;

  els.statusDetail.textContent =
    detail;

  setMemoScanWidget(
    "syncing",
    scanningLabel
  );
}


function setCurrentStatus() {

  els.statusLabel.textContent =
    "Chain current";

  els.statusDetail.textContent =
    `Verified through #${state.verifiedThrough}`;

  setMemoScanWidget(
    "live",
    "Chain current"
  );
}


function setErrorStatus(
  label,
  detail
) {

  els.statusLabel.textContent =
    label;

  els.statusDetail.textContent =
    detail;

  setMemoScanWidget(
    "failed",
    label || "Paused"
  );
}


/* ==================================================
   RENDER ARCHITECT
================================================== */

function renderArchitect() {

  const dedication =
    Array.from(
      state.whispers.values()
    ).find(
      whisper =>
        Number(whisper.block) === 0 &&
        whisper.kind ===
          "block_dedication"
    );

  if (!dedication) {

    els.architectMessage.textContent =
      "Loading Genesis dedication…";

    els.architectMeta.innerHTML =
      "<span>Block <strong>#0</strong></span>";

    return;
  }

  const message =
    String(
      dedication.memo || ""
    ).replace(
      /^BLOCK DEDICATION\s*[—–-]\s*/i,
      ""
    );

  els.architectMessage.textContent =
    message;

  const timestamp =
    formatTimestamp(
      dedication.timestamp
    );

  els.architectMeta.innerHTML = `
    <span>
      Block
      <strong>
        <a
          href="${escapeHtml(
            blockUrl(0)
          )}"
          target="_blank"
          rel="noopener noreferrer"
        >#0</a>
      </strong>
    </span>

    <span>
      ${escapeHtml(timestamp)}
    </span>

    <span>
      Genesis block dedication
    </span>

    <span>
      <a
        href="${escapeHtml(
          blockUrl(0)
        )}"
        target="_blank"
        rel="noopener noreferrer"
      >
        View block ↗
      </a>
    </span>
  `;
}

/* ==================================================
   RENDER STATS
================================================== */

function renderStats() {

  els.chainHeight.textContent =
    state.chainHeight >= 0
      ? "#" +
        formatNumber(
          state.chainHeight
        )
      : "—";

  els.verifiedThrough.textContent =
    state.verifiedThrough >= 0
      ? "#" +
        formatNumber(
          state.verifiedThrough
        )
      : "—";

  els.whisperCount.textContent =
    formatNumber(
      state.whispers.size
    );

  const remaining =
    state.chainHeight >= 0
      ? Math.max(
          0,
          state.chainHeight -
          state.verifiedThrough
        )
      : null;

  els.blocksRemaining.textContent =
    remaining === null
      ? "—"
      : formatNumber(
          remaining
        );
}


/* ==================================================
   RENDER PROGRESS
================================================== */

function renderProgress() {

  if (
    state.chainHeight < 0 ||
    state.verifiedThrough < 0
  ) {

    els.progressFill.style.width =
      "0%";

    els.progressPercent.textContent =
      "0%";

    return;
  }

  const total =
    state.chainHeight + 1;

  const verified =
    Math.min(
      total,
      state.verifiedThrough + 1
    );

  const percentage =
    total <= 0
      ? 0
      : Math.min(
          100,
          Math.max(
            0,
            (
              verified /
              total
            ) * 100
          )
        );

  els.progressFill.style.width =
    percentage.toFixed(2) +
    "%";

  els.progressPercent.textContent =
    percentage.toFixed(1) +
    "%";
}


/* ==================================================
   SEARCH
================================================== */

function whisperMatches(
  whisper,
  query
) {

  if (!query) {
    return true;
  }

  const q =
    query.toLowerCase();

  const haystack = [
    whisper.memo,
    whisper.sender,
    whisper.to,
    whisper.tx,
    whisper.tx_hash,
    String(whisper.block),
    formatTimestamp(
      whisper.timestamp
    )
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(q);
}


/* ==================================================
   RENDER WHISPERS
================================================== */

function renderWhispers() {

  const query =
    els.search.value
      .trim()
      .toLowerCase();

  /*
    Render EVERY whisper.

    Sort by block descending, while retaining
    multiple messages from the same block.
  */

  const whispers =
    Array.from(
      state.whispers.values()
    )
      .filter(
        whisper =>
          whisperMatches(
            whisper,
            query
          )
      )
      .sort(
        (a, b) =>
          compareWhispers(
            b,
            a
          )
      );

  els.sectionCount.textContent =
    `${whispers.length} ${
      whispers.length === 1
        ? "whisper"
        : "whispers"
    }`;

  if (
    !whispers.length
  ) {

    els.whispers.innerHTML = `
      <div class="empty">
        ${
          query
            ? "No whispers match your search."
            : "No whispers indexed yet."
        }
      </div>
    `;

    return;
  }

  const fragment =
    document.createDocumentFragment();

  for (
    const whisper of whispers
  ) {

    const card =
      document.createElement(
        "article"
      );

    card.className =
      "whisper";

    const isDedication =
      whisper.kind ===
        "block_dedication";

    if (isDedication) {
      card.classList.add(
        "dedication"
      );
    }

    if (
      whisper.tx_hash &&
      state.newWhisperTxs.has(
        whisper.tx_hash
      )
    ) {

      card.classList.add(
        "new"
      );

      const txHash =
        whisper.tx_hash;

      setTimeout(
        () => {
          state.newWhisperTxs.delete(
            txHash
          );
        },
        2200
      );
    }

    const block =
      Number(whisper.block);

    const memoText =
      isDedication
        ? String(
            whisper.memo || ""
          ).replace(
            /^BLOCK DEDICATION\s*[—–-]\s*/i,
            ""
          )
        : whisper.memo;

    const memo =
      escapeHtml(
        memoText
      );

    const timestamp =
      escapeHtml(
        formatTimestamp(
          whisper.timestamp
        )
      );

    const amount =
      formatAmount(
        whisper.amount
      );

    const sender =
      whisper.sender ||
      "—";

    const to =
      whisper.to ||
      "—";

    const tx =
      whisper.kind ===
        "block_dedication"
        ? ""
        : whisper.tx ||
          whisper.tx_hash ||
          "";

    card.innerHTML = `
      <div class="whisper-top">

        <a
          class="block-link"
          href="${escapeHtml(
            blockUrl(block)
          )}"
          target="_blank"
          rel="noopener noreferrer"
          title="Open block #${block}"
        >
          #${formatNumber(block)} ↗
        </a>

        <div class="timestamp">
          ${timestamp}
        </div>

      </div>

      ${
        isDedication
          ? '<div class="dedication-badge">BLOCK DEDICATION</div>'
          : ""
      }

      <div class="memo">
        ${memo}
      </div>

      <div class="details">

        <div class="detail-label">
          Amount
        </div>

        <div
          class="detail-value"
          title="${escapeHtml(
            whisper.amount ?? ""
          )}"
        >
          ${escapeHtml(amount)}
        </div>

        <div class="detail-label">
          TX
        </div>

        <div class="detail-value">

          ${
            tx
              ? `
                <a
                  href="${escapeHtml(
                    txUrl(tx)
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="${escapeHtml(tx)}"
                >
                  ${escapeHtml(
                    shorten(
                      tx,
                      12,
                      10
                    )
                  )} ↗
                </a>
              `
              : "—"
          }

        </div>

        <div class="detail-label">
          From
        </div>

        <div
          class="detail-value"
          title="${escapeHtml(sender)}"
        >

          ${
            sender !== "—"
              ? `
                <a
                  href="${escapeHtml(
                    addressUrl(sender)
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ${escapeHtml(
                    shorten(
                      sender,
                      12,
                      10
                    )
                  )} ↗
                </a>
              `
              : "—"
          }

        </div>

        <div class="detail-label">
          To
        </div>

        <div
          class="detail-value"
          title="${escapeHtml(to)}"
        >

          ${
            to !== "—"
              ? `
                <a
                  href="${escapeHtml(
                    addressUrl(to)
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ${escapeHtml(
                    shorten(
                      to,
                      12,
                      10
                    )
                  )} ↗
                </a>
              `
              : "—"
          }

        </div>

      </div>
    `;

    fragment.appendChild(
      card
    );
  }

  els.whispers.replaceChildren(
    fragment
  );
}


/* ==================================================
   RENDER EVERYTHING
================================================== */

function renderAll() {

  renderStats();

  renderProgress();

  renderArchitect();

  renderWhispers();
}


/* ==================================================
   REBUILD FROM GENESIS
================================================== */

async function rebuildFromGenesis() {

  if (
    state.scanning
  ) {
    return;
  }

  const confirmed =
    window.confirm(
      "Rebuild the NevWhisper archive from Genesis?\n\n" +
      "This clears the local indexed archive and " +
      "starts again from block #0."
    );

  if (!confirmed) {
    return;
  }

  stopLivePolling();

  try {

    await dbClear(
      "meta"
    );

    await dbClear(
      "whispers"
    );

    state.verifiedThrough =
      -1;

    state.chainHeight =
      -1;

    state.whispers.clear();

    state.latestArchitect =
      null;

    architectAddress =
      null;

    state.stopRequested =
      false;

    state.newWhisperTxs.clear();

    renderAll();

    await startScan();

  } catch (error) {

    console.error(
      error
    );

    setErrorStatus(
      "Rebuild failed",
      error?.message ||
      "Unable to rebuild the archive."
    );

    renderAll();

  } finally {

    startLivePolling();
  }
}


/* ==================================================
   EVENT LISTENERS
================================================== */

els.search.addEventListener(
  "input",
  renderWhispers
);

els.rebuild.addEventListener(
  "click",
  rebuildFromGenesis
);


/* ==================================================
   HISTORICAL BLOCK DEDICATION REPORT
================================================== */

async function loadDedicationReport() {

  if (dedicationReportRunning) {
    return;
  }

  dedicationReportRunning = true;

  try {

    const response =
      await fetch(
        DEDICATION_REPORT +
        "?t=" +
        Date.now(),
        {
          cache: "no-store"
        }
      );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(
        "Dedication report HTTP " +
        response.status
      );
    }

    const report =
      await response.json();

    const entries =
      Array.isArray(
        report?.customDedications
      )
        ? report.customDedications
        : [];

    let changed = false;

    for (
      const entry of entries
    ) {

      const block =
        Number(entry?.block);

      if (
        !Number.isInteger(block) ||
        block < 0
      ) {
        continue;
      }

      const dedication =
        specialBlockDedicationFromPayload(
          {
            block_dedication:
              entry?.dedication,
            timestamp:
              entry?.timestamp
          },
          block
        );

      if (!dedication) {
        continue;
      }

      const existing =
        state.whispers.get(
          dedication.tx_hash
        );

      if (
        !existing ||
        existing.memo !==
          dedication.memo
      ) {

        await processWhisperPayload(
          [dedication],
          block,
          block,
          false
        );

        changed = true;
      }
    }

    if (changed) {
      renderAll();
    }

  } catch (error) {

    console.warn(
      "Historical dedication report unavailable:",
      error
    );

  } finally {

    dedicationReportRunning = false;
  }
}


function startDedicationReportPolling() {

  if (dedicationReportTimer) {
    clearInterval(
      dedicationReportTimer
    );
  }

  loadDedicationReport();

  dedicationReportTimer =
    setInterval(
      () => {
        loadDedicationReport();
      },
      DEDICATION_REPORT_POLL_MS
    );
}


/* ==================================================
   ACTIVE MINERS
================================================== */

function setMinerStatus(
  kind,
  label,
  detail
) {

  if (minerEls.statusLabel) {
    minerEls.statusLabel.textContent =
      label;
  }

  if (minerEls.statusDetail) {
    minerEls.statusDetail.textContent =
      detail;
  }

  if (minerEls.status) {
    minerEls.status.className =
      "scan-widget " +
      kind;

    minerEls.status.innerHTML =
      '<span class="status-light" aria-hidden="true"></span><span>' +
      escapeHtml(label) +
      "</span>";
  }
}


function loadMinerCache() {

  if (minerState.loadedCache) {
    return;
  }

  minerState.loadedCache = true;

  try {

    const raw =
      localStorage.getItem(
        MINER_CACHE_KEY
      );

    if (!raw) {
      return;
    }

    const saved =
      JSON.parse(raw);

    const blocks =
      Array.isArray(
        saved?.blocks
      )
        ? saved.blocks
        : [];

    for (
      const block of blocks
    ) {

      const height =
        Number(block?.height);

      if (
        !Number.isInteger(height) ||
        height < 0
      ) {
        continue;
      }

      minerState.blocks.set(
        height,
        {
          height,
          miner:
            String(
              block?.miner || ""
            ),
          timestamp:
            block?.timestamp ?? null
        }
      );
    }

    minerState.chainHeight =
      Number.isFinite(
        Number(
          saved?.chainHeight
        )
      )
        ? Number(
            saved.chainHeight
          )
        : -1;

  } catch (error) {

    console.warn(
      "Could not restore miner cache:",
      error
    );

    localStorage.removeItem(
      MINER_CACHE_KEY
    );
  }
}


function saveMinerCache() {

  try {

    const blocks =
      Array.from(
        minerState.blocks.values()
      )
        .sort(
          (a, b) =>
            a.height -
            b.height
        );

    localStorage.setItem(
      MINER_CACHE_KEY,
      JSON.stringify(
        {
          version: 1,
          chainHeight:
            minerState.chainHeight,
          blocks
        }
      )
    );

  } catch (error) {

    console.warn(
      "Could not persist miner cache:",
      error
    );
  }
}


function renderMinerProgress(
  complete,
  total
) {

  const pct =
    total > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              complete /
              total
            ) *
            100
          )
        )
      : 0;

  if (
    minerEls.progressPercent
  ) {
    minerEls.progressPercent
      .textContent =
        pct.toFixed(
          pct >= 99.95
            ? 0
            : 1
        ) +
        "%";
  }

  if (
    minerEls.progressFill
  ) {
    minerEls.progressFill.style.width =
      pct +
      "%";
  }
}


function bindMinerCopyButtons() {

  if (!minerEls.list) {
    return;
  }

  minerEls.list
    .querySelectorAll(
      "[data-copy-miner]"
    )
    .forEach(button => {

      button.addEventListener(
        "click",
        async () => {

          const miner =
            button.dataset
              .copyMiner;

          try {

            await navigator
              .clipboard
              .writeText(
                miner
              );

            const original =
              button.textContent;

            button.textContent =
              "COPIED";

            setTimeout(
              () => {
                button.textContent =
                  original;
              },
              1200
            );

          } catch {

            button.textContent =
              "COPY FAILED";

            setTimeout(
              () => {
                button.textContent =
                  "COPY";
              },
              1200
            );
          }
        }
      );
    });
}


function renderMiners() {

  if (
    !minerEls.summary ||
    !minerEls.list
  ) {
    return;
  }

  const blocks =
    Array.from(
      minerState.blocks.values()
    )
      .filter(block =>
        block.miner
      )
      .sort(
        (a, b) =>
          a.height -
          b.height
      );

  const stats =
    new Map();

  for (
    const block of blocks
  ) {

    const current =
      stats.get(
        block.miner
      ) || {
        miner:
          block.miner,
        blocks: 0,
        lastHeight: -1,
        lastTimestamp: null
      };

    current.blocks += 1;

    if (
      block.height >
      current.lastHeight
    ) {
      current.lastHeight =
        block.height;

      current.lastTimestamp =
        block.timestamp;
    }

    stats.set(
      block.miner,
      current
    );
  }

  const miners =
    Array.from(
      stats.values()
    )
      .sort(
        (a, b) =>
          b.blocks -
            a.blocks ||
          b.lastHeight -
            a.lastHeight ||
          a.miner.localeCompare(
            b.miner
          )
      );

  const totalBlocks =
    blocks.length;

  const topShare =
    miners.length &&
    totalBlocks
      ? (
          (
            miners[0].blocks /
            totalBlocks
          ) *
          100
        ).toFixed(1) +
        "%"
      : "—";

  minerEls.summary.innerHTML = [
    [
      "Chain Height",
      minerState.chainHeight >= 0
        ? "#" +
          formatNumber(
            minerState.chainHeight
          )
        : "—"
    ],
    [
      "Window",
      MINER_WINDOW_BLOCKS +
        " blocks"
    ],
    [
      "Active Miners",
      formatNumber(
        miners.length
      )
    ],
    [
      "Top Share",
      topShare
    ]
  ].map(
    ([label, value]) =>
      '<div class="stat"><div class="stat-label">' +
      escapeHtml(label) +
      '</div><div class="stat-value miner-stat-value">' +
      escapeHtml(value) +
      "</div></div>"
  ).join("");

  if (minerEls.updated) {
    minerEls.updated.textContent =
      minerState.chainHeight >= 0
        ? "Through #" +
          formatNumber(
            minerState.chainHeight
          )
        : "—";
  }

  if (!miners.length) {

    minerEls.list.innerHTML =
      '<div class="empty">No recent miner activity indexed yet.</div>';

  } else {

    minerEls.list.innerHTML =
      miners.map(
        (miner, index) => {

          const share =
            totalBlocks > 0
              ? (
                  (
                    miner.blocks /
                    totalBlocks
                  ) *
                  100
                ).toFixed(1) +
                "%"
              : "—";

          return (
            '<article class="holder-row miner-row">' +
              '<div class="holder-rank">#' +
                escapeHtml(
                  index + 1
                ) +
              "</div>" +
              "<div>" +
                '<div class="holder-address" title="' +
                  escapeHtml(
                    miner.miner
                  ) +
                '">' +
                  escapeHtml(
                    shorten(
                      miner.miner
                    )
                  ) +
                "</div>" +
                '<div class="holder-actions">' +
                  '<a class="holder-action" href="' +
                    escapeHtml(
                      addressUrl(
                        miner.miner
                      )
                    ) +
                  '" target="_blank" rel="noopener noreferrer">VIEW ↗</a>' +
                  '<button class="holder-action" type="button" data-copy-miner="' +
                    escapeHtml(
                      miner.miner
                    ) +
                  '">COPY</button>' +
                "</div>" +
              "</div>" +
              '<div class="holder-balance">' +
                '<div class="holder-amount">' +
                  escapeHtml(
                    miner.blocks
                  ) +
                  (
                    miner.blocks === 1
                      ? " block"
                      : " blocks"
                  ) +
                "</div>" +
                '<div class="holder-share">' +
                  escapeHtml(
                    share
                  ) +
                  " · last #" +
                  escapeHtml(
                    formatNumber(
                      miner.lastHeight
                    )
                  ) +
                "</div>" +
              "</div>" +
            "</article>"
          );
        }
      ).join("");

    bindMinerCopyButtons();
  }

  if (minerEls.note) {
    minerEls.note.textContent =
      "Active miners are inferred from block producers in the latest " +
      MINER_WINDOW_BLOCKS +
      " blocks. This shows recent mining activity, not a literal online/offline connection state.";
  }
}


async function scanMiners() {

  if (
    minerState.running
  ) {
    return;
  }

  minerState.running = true;

  loadMinerCache();

  setMinerStatus(
    "syncing",
    "Scanning",
    "Reading recent block producers"
  );

  try {

    const info =
      await getJson(
        "/info"
      );

    const tip =
      Number(
        info?.height ??
        info?.chain_height
      );

    if (
      !Number.isInteger(tip) ||
      tip < 0
    ) {
      throw new Error(
        "Node returned no valid chain height."
      );
    }

    minerState.chainHeight =
      tip;

    const start =
      Math.max(
        0,
        tip -
          MINER_WINDOW_BLOCKS +
          1
      );

    for (
      const height of
      Array.from(
        minerState.blocks.keys()
      )
    ) {
      if (
        height < start ||
        height > tip
      ) {
        minerState.blocks.delete(
          height
        );
      }
    }

    const heights = [];

    for (
      let height = start;
      height <= tip;
      height++
    ) {
      heights.push(
        height
      );
    }

    const missing =
      heights.filter(
        height =>
          !minerState.blocks.has(
            height
          )
      );

    let complete =
      heights.length -
      missing.length;

    renderMinerProgress(
      complete,
      heights.length
    );

    renderMiners();

    const concurrency = 4;

    for (
      let offset = 0;
      offset < missing.length;
      offset += concurrency
    ) {

      const batch =
        missing.slice(
          offset,
          offset +
            concurrency
        );

      const rows =
        await Promise.all(
          batch.map(
            async height => {

              const block =
                await getJson(
                  "/block/" +
                  height +
                  "?miner_scan=" +
                  Date.now()
                );

              return {
                height,
                miner:
                  String(
                    block?.miner ||
                    ""
                  ),
                timestamp:
                  block?.timestamp ??
                  null
              };
            }
          )
        );

      for (
        const row of rows
      ) {
        minerState.blocks.set(
          row.height,
          row
        );
      }

      complete +=
        rows.length;

      renderMinerProgress(
        complete,
        heights.length
      );

      renderMiners();

      if (
        offset +
        concurrency <
        missing.length
      ) {
        await sleep(
          120
        );
      }
    }

    saveMinerCache();

    renderMinerProgress(
      heights.length,
      heights.length
    );

    renderMiners();

    setMinerStatus(
      "live",
      "Chain current",
      "Latest " +
        heights.length +
        " blocks through #" +
        formatNumber(
          tip
        )
    );

  } catch (error) {

    console.error(
      "Miner scan failed:",
      error
    );

    setMinerStatus(
      "failed",
      "Scan paused",
      error?.message ||
        "Unable to read recent miner activity."
    );

  } finally {

    minerState.running = false;
  }
}


function initMinersView() {

  loadMinerCache();

  renderMiners();

  const tab =
    document.querySelector(
      '[data-tab="miners"]'
    );

  if (tab) {
    tab.addEventListener(
      "click",
      () => {
        scanMiners();
      }
    );
  }

  if (
    minerEls.view &&
    minerEls.view.classList
      .contains("active")
  ) {
    scanMiners();
  }

  if (minerState.timer) {
    clearInterval(
      minerState.timer
    );
  }

  minerState.timer =
    setInterval(
      () => {
        if (
          minerEls.view &&
          minerEls.view.classList
            .contains("active")
        ) {
          scanMiners();
        }
      },
      MINER_REFRESH_MS
    );
}


/* ==================================================
   AUTOMATED SELF-TEST
================================================== */

/*
  Runs the same production raw-block pipeline used by the
  live scanner, but against a small deterministic set of
  already-existing blocks.

  This lets CI verify a fix against real NEV369 chain data
  without asking a human to create another transaction.
*/
async function runNevWhisperSelfTest() {
  const info = await getInfo();

  const tip = Number(
    info?.height ??
    info?.chain_height
  );

  if (!Number.isFinite(tip) || tip < 5960) {
    throw new Error(
      `Unexpected chain height for self-test: ${tip}`
    );
  }

  const heights = new Set([
    0,
    5960,
    Math.max(0, tip - 19),
    Math.max(0, tip - 9),
    tip,
    6346
  ]);

  const checked = [];
  const failures = [];
  const discovered = [];

  for (const height of Array.from(heights).sort((a, b) => a - b)) {
    const payload = await getJson(
      `/block/${height}?_=${Date.now()}`
    );

    const transactions =
      payload &&
      Array.isArray(payload.transactions)
        ? payload.transactions
        : [];

    const rawUserMemos = transactions
      .map(transaction => ({
        ...transaction,
        block: height
      }))
      .map(normalizeWhisper)
      .filter(Boolean)
      .filter(whisper => !isNetworkReward(whisper))
      .filter(whisper => whisper.memo);

    await processBlockPayload(
      payload,
      height,
      false
    );

    for (const whisper of rawUserMemos) {
      discovered.push({
        block: height,
        tx_hash: whisper.tx_hash,
        memo: whisper.memo
      });

      if (
        !state.whispers.has(
          whisper.tx_hash
        )
      ) {
        failures.push(
          `Block #${height} transaction ${whisper.tx_hash || "(no hash)"} was parsed but not persisted.`
        );
      }
    }

    checked.push({
      block: height,
      rawTransactions: transactions.length,
      userWhispers: rawUserMemos.length
    });
  }

  const known5960 = Array.from(
    state.whispers.values()
  ).some(
    whisper =>
      Number(whisper.block) === 5960 &&
      whisper.memo ===
        "https://mattcodeai91.github.io/nevwhisper/"
  );

  if (!known5960) {
    failures.push(
      "Known block #5960 memo was not recovered from the raw block."
    );
  }

  const genesisDedication =
    Array.from(
      state.whispers.values()
    ).some(
      whisper =>
        Number(whisper.block) === 0 &&
        whisper.kind ===
          "block_dedication" &&
        String(
          whisper.memo || ""
        ).startsWith(
          "BLOCK DEDICATION — "
        )
    );

  if (!genesisDedication) {
    failures.push(
      "Genesis custom block dedication was not recovered."
    );
  }

  if (
    specialBlockDedicationFromPayload(
      {
        block_dedication:
          "Block 123 — for Nevaeh"
      },
      123
    ) !== null
  ) {
    failures.push(
      "Standard block dedication was incorrectly promoted."
    );
  }

  const customDedicationTest =
    specialBlockDedicationFromPayload(
      {
        block_dedication:
          "A custom dedication"
      },
      123
    );

  if (
    !customDedicationTest ||
    customDedicationTest.kind !==
      "block_dedication"
  ) {
    failures.push(
      "Custom block dedication was not promoted."
    );
  }

  const result = {
    ok: failures.length === 0,
    chainHeight: tip,
    checked,
    discovered,
    whisperCount: state.whispers.size,
    failures
  };

  window.NevWhisperSelfTestResult = result;

  if (!result.ok) {
    throw new Error(
      JSON.stringify(result)
    );
  }

  console.info(
    "NevWhisper self-test passed:",
    result
  );

  return result;
}

window.NevWhisperSelfTest =
  runNevWhisperSelfTest;



/* ==================================================
   THEME
================================================== */

function initTheme() {
  const toggle = document.getElementById("themeToggle");

  if (!toggle) return;

  const savedTheme = localStorage.getItem("nevwhisper-theme");
  const systemLight =
    window.matchMedia?.("(prefers-color-scheme: light)").matches;

  function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = normalized;

    const light = normalized === "light";
    toggle.setAttribute(
      "aria-label",
      light ? "Switch to dark mode" : "Switch to light mode"
    );
    toggle.setAttribute(
      "title",
      light ? "Switch to dark mode" : "Switch to light mode"
    );
  }

  applyTheme(savedTheme || (systemLight ? "light" : "dark"));

  toggle.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "light"
        ? "dark"
        : "light";

    localStorage.setItem("nevwhisper-theme", next);
    applyTheme(next);
  });
}

/* ==================================================
   INITIALISE
================================================== */

function initTabs() {
  const tabs =
    document.querySelectorAll(
      "[data-tab]"
    );

  const memoSections =
    Array.from(
      document.querySelectorAll(
        ".container > :not(.header):not(.tabbar):not(.holders-view):not(.miners-view):not(.footer)"
      )
    );

  const holders =
    document.getElementById(
      "holdersView"
    );

  const miners =
    document.getElementById(
      "minersView"
    );

  function selectTab(name) {

    const selected =
      name === "holders" ||
      name === "miners"
        ? name
        : "memo";

    const holderMode =
      selected ===
      "holders";

    const minerMode =
      selected ===
      "miners";

    const memoMode =
      selected ===
      "memo";

    tabs.forEach(
      tab =>
        tab.classList.toggle(
          "active",
          tab.dataset.tab ===
            selected
        )
    );

    memoSections.forEach(
      section => {
        section.style.display =
          memoMode
            ? ""
            : "none";
      }
    );

    if (holders) {
      holders.classList.toggle(
        "active",
        holderMode
      );
    }

    if (miners) {
      miners.classList.toggle(
        "active",
        minerMode
      );
    }
  }

  tabs.forEach(
    tab =>
      tab.addEventListener(
        "click",
        () =>
          selectTab(
            tab.dataset.tab
          )
      )
  );

  const requestedTab =
    new URLSearchParams(
      window.location.search
    ).get("tab");

  selectTab(
    requestedTab === "holders" ||
    requestedTab === "miners"
      ? requestedTab
      : "memo"
  );
}

async function init() {

  if (SELF_TEST_MODE) {
    try {
      await loadDatabase();
      await runNevWhisperSelfTest();
      document.documentElement.dataset.nevwhisperSelfTest = "passed";
      return;
    } catch (error) {
      console.error(
        "NevWhisper self-test failed:",
        error
      );
      document.documentElement.dataset.nevwhisperSelfTest = "failed";
      window.NevWhisperSelfTestResult = {
        ok: false,
        error: error?.message || String(error)
      };
      return;
    }
  }

  try {

    /*
      1. Load existing persistent archive.
    */

    await loadDatabase();

    renderAll();

    /*
      Recover the Genesis custom block dedication immediately.
      This runs before live catch-up so the dedication is
      available to search as soon as the page starts.
    */

    await recoverHistoricalBlock(0);

    renderAll();

    loadDedicationReport()
      .catch(error => {
        console.warn(
          "Initial dedication report load failed:",
          error
        );
      });

    /*
      2. Get the actual current chain tip.
    */

    try {

      await getInfo();

    } catch (error) {

      console.warn(
        "Initial chain info unavailable:",
        error
      );
    }

    renderAll();

    /*
      3. Scan only if the local archive
         is behind the live chain.
    */

    if (
      state.chainHeight >= 0 &&
      state.verifiedThrough <
      state.chainHeight
    ) {

      await startScan();

      /*
        The historical scanner has now caught up.
        Immediately recheck the last 20 LIVE blocks
        before entering the 15-second polling loop.
      */

      try {
        await backfillRecentBlocks();
      } catch (error) {
        console.warn(
          "Initial recent whisper backfill failed:",
          error
        );
      }

      /*
        Confirmed historical recovery.

        Block #5960 contains a real user memo in
        transactions[1]. The normal /whispers archive
        pass did not expose that transaction, while the
        raw /block endpoint does.

        Recover it immediately on startup without
        changing the verified checkpoint.
      */

      await recoverHistoricalBlock(5960);

      setCurrentStatus();
      renderAll();

    } else if (
      state.chainHeight >= 0
    ) {

      /*
        The archive is already at the tip.

        Before going live, perform one recent
        backfill so a previously missed whisper
        can be recovered immediately.
      */

      try {
        await backfillRecentBlocks();
      } catch (error) {
        console.warn(
          "Initial recent whisper backfill failed:",
          error
        );
      }

      /*
        Confirmed historical recovery.

        Block #5960 contains a real user memo in
        transactions[1]. The normal /whispers archive
        pass did not expose that transaction, while the
        raw /block endpoint does.

        Recover it immediately on startup without
        changing the verified checkpoint.
      */

      await recoverHistoricalBlock(5960);

      setCurrentStatus();

      renderAll();
    }

    /*
      4. Permanent 15-second live watcher.
    */

    startLivePolling();

    startDedicationReportPolling();

  } catch (error) {

    console.error(
      "NevWhisper initialisation error:",
      error
    );

    setErrorStatus(
      "Initialisation error",
      error?.message ||
      "Unable to initialise NevWhisper."
    );

    renderAll();

    startLivePolling();
  }
}


initTheme();
initTabs();
initHoldersView();
initMinersView();
init();
