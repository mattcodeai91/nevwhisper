"use strict";

import fs from "node:fs/promises";

const NODE =
  process.env.NEV369_NODE ||
  "https://q-lock-ecosystem.com/node";

const REQUEST_DELAY_MS =
  Number(
    process.env.REQUEST_DELAY_MS ||
    150
  );

const MAX_BLOCKS_PER_RUN =
  Number(
    process.env.MAX_BLOCKS_PER_RUN ||
    500
  );

const OUTPUT =
  "dedications.json";

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
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
        ) +
        path,
        {
          headers: {
            accept:
              "application/json"
          }
        }
      );

    if (!response.ok) {

      const error =
        new Error(
          path +
          " HTTP " +
          response.status
        );

      error.status =
        response.status;

      error.retryAfter =
        response.headers.get(
          "retry-after"
        );

      throw error;
    }

    return response.json();

  } catch (error) {

    if (attempt >= 5) {
      throw error;
    }

    let delay =
      1000 *
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

    await sleep(delay);

    return getJson(
      path,
      attempt + 1
    );
  }
}

function specialDedication(
  block,
  height
) {

  const value =
    block?.block_dedication ??
    block?.dedication;

  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const text =
    String(value).trim();

  const standard =
    new RegExp(
      "^Block\\s+" +
      String(height) +
      "\\s*[—–-]\\s*for\\s+Nevaeh\\s*$",
      "i"
    );

  if (standard.test(text)) {
    return null;
  }

  return {
    block:
      height,
    dedication:
      text,
    timestamp:
      block?.timestamp ??
      null,
    hash:
      block?.hash ??
      null
  };
}

async function readState() {

  try {

    const raw =
      await fs.readFile(
        OUTPUT,
        "utf8"
      );

    const saved =
      JSON.parse(raw);

    return {
      version: 1,
      generatedAt:
        saved.generatedAt ||
        null,
      chainHeight:
        Number(
          saved.chainHeight ??
          -1
        ),
      scannedThrough:
        Number(
          saved.scannedThrough ??
          -1
        ),
      complete:
        Boolean(
          saved.complete
        ),
      customDedications:
        Array.isArray(
          saved.customDedications
        )
          ? saved.customDedications
          : [],
      diagnostics: {
        scannedBlocks:
          Number(
            saved?.diagnostics
              ?.scannedBlocks ||
            0
          ),
        standardDedications:
          Number(
            saved?.diagnostics
              ?.standardDedications ||
            0
          ),
        customCount:
          Number(
            saved?.diagnostics
              ?.customCount ||
            0
          )
      }
    };

  } catch {

    return {
      version: 1,
      generatedAt: null,
      chainHeight: -1,
      scannedThrough: -1,
      complete: false,
      customDedications: [],
      diagnostics: {
        scannedBlocks: 0,
        standardDedications: 0,
        customCount: 0
      }
    };
  }
}

async function main() {

  const state =
    await readState();

  const info =
    await getJson(
      "/info"
    );

  const liveHeight =
    Number(
      info?.chain_height ??
      info?.height
    );

  if (
    !Number.isInteger(
      liveHeight
    ) ||
    liveHeight < 0
  ) {
    throw new Error(
      "Node returned no valid chain height."
    );
  }

  const start =
    Math.max(
      0,
      state.scannedThrough +
      1
    );

  const end =
    Math.min(
      liveHeight,
      start +
      Math.max(
        1,
        MAX_BLOCKS_PER_RUN
      ) -
      1
    );

  const customByBlock =
    new Map(
      state.customDedications
        .filter(
          item =>
            Number.isInteger(
              Number(
                item?.block
              )
            )
        )
        .map(
          item => [
            Number(
              item.block
            ),
            item
          ]
        )
    );

  if (start <= end) {

    for (
      let height = start;
      height <= end;
      height++
    ) {

      const block =
        await getJson(
          "/block/" +
          height
        );

      const value =
        block?.block_dedication ??
        block?.dedication;

      if (
        value !== null &&
        value !== undefined &&
        String(value).trim() !== ""
      ) {

        const special =
          specialDedication(
            block,
            height
          );

        if (special) {

          customByBlock.set(
            height,
            special
          );

        } else {

          state.diagnostics
            .standardDedications +=
              1;
        }
      }

      state.scannedThrough =
        height;

      state.diagnostics
        .scannedBlocks +=
          1;

      if (height < end) {
        await sleep(
          REQUEST_DELAY_MS
        );
      }
    }
  }

  state.chainHeight =
    liveHeight;

  state.complete =
    state.scannedThrough >=
    liveHeight;

  state.generatedAt =
    new Date()
      .toISOString();

  state.customDedications =
    Array.from(
      customByBlock.values()
    ).sort(
      (a, b) =>
        Number(a.block) -
        Number(b.block)
    );

  state.diagnostics.customCount =
    state.customDedications.length;

  await fs.writeFile(
    OUTPUT,
    JSON.stringify(
      state,
      null,
      2
    ) +
    "\n",
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        chainHeight:
          state.chainHeight,
        scannedThrough:
          state.scannedThrough,
        complete:
          state.complete,
        customDedications:
          state.customDedications
            .length,
        scannedThisRun:
          start <= end
            ? end -
              start +
              1
            : 0
      },
      null,
      2
    )
  );
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
