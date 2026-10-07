# NevWhisper

Live NEV369 memo reader and chain-derived holder analytics.

NevWhisper is a lightweight public web application for reading **NEV369 on-chain memo messages ("whispers")** and inspecting the persisted **Top Holders** report produced from raw block data. The project is intentionally simple: static frontend files, a small set of Node.js scanning tools, and GitHub Actions for resumable data collection.

## What is NEV369?

NEV369 is the NEV369 blockchain (NEV369), a post-quantum Layer-1 network. NevWhisper does not attempt to replace the network explorer; it provides a focused, public-facing view of memo activity and holder analytics derived from chain data.

## Features

- **Live Memo Reader** — reads persisted whispers and keeps the archive current.
- **Genesis-aware scanning** — the scanner can start at block 0 and resume from its persisted checkpoint.
- **Raw-block recovery** — recent blocks can be rechecked so memos missed by aggregate endpoints can still be recovered.
- **Top Holders** — displays the latest persisted chain-derived balance ranking.
- **Address tools** — long addresses are shortened for readability and can be copied with one click.
- **Explorer links** — blocks, transactions, and addresses link back to the NEV369 explorer.
- **Resumable CI** — holder chunks are persisted on the `holder-scan-data` branch so interrupted scans do not have to start over.
- **Automated live self-test** — CI exercises the production site against real NEV369 data.

## Live links

- **NevWhisper:** https://mattcodeai91.github.io/nevwhisper/
- **Top Holders:** https://mattcodeai91.github.io/nevwhisper-holders/
- **NEV369 Explorer:** https://q-lock-ecosystem.com/explorer/
- **Holder data branch:** https://github.com/mattcodeai91/nevwhisper/tree/holder-scan-data

## Project structure

```text
nevwhisper/
├── .github/
│   └── workflows/
│       ├── live-self-test.yml
│       ├── merge-top-holders.yml
│       └── top-holders.yml
├── holders/
│   └── index.html              # legacy standalone holder view
├── src/
│   ├── css/
│   │   └── app.css             # shared application styles
│   └── js/
│       ├── app.js              # memo reader, scanner UI, persistence
│       └── holders.js          # Top Holders tab
├── tools/
│   ├── merge-top-holders.mjs   # merge persisted scan chunks
│   └── scan-top-holders.mjs    # scan a block range
├── index.html                  # unified Memo Reader / Top Holders SPA
└── README.md
```

## Architecture

The frontend is a static GitHub Pages application.

1. The browser loads `index.html`.
2. `src/css/app.css` provides the shared dark UI.
3. `src/js/app.js` runs the memo archive, IndexedDB persistence, raw block recovery, and live polling.
4. `src/js/holders.js` reads the published `top-holders.json` report from the `holder-scan-data` branch.
5. The holder scanner in `tools/scan-top-holders.mjs` fetches raw blocks and emits resumable chunk reports.
6. `tools/merge-top-holders.mjs` combines completed chunks into the published holder report.
7. GitHub Actions persist chunks and publish the merged report.

The live frontend does **not** modify holder-scan data. CI owns scanning and publication; the browser is a read-only consumer of the report.

## Running locally

No build system is required.

### Option 1 — simple static server

From the repository root:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

### Option 2 — Node.js

Any static HTTP server can be used. The frontend uses ES modules, so opening `index.html` directly with a `file://` URL is not recommended.

## Holder scanner

The scanner is a plain Node.js ES module and requires Node.js 20+ (CI uses Node 22).

Example:

```bash
START_HEIGHT=0 END_HEIGHT=199 node tools/scan-top-holders.mjs
```

It writes:

```text
chunk-output/chunk.json
```

The merger expects persisted chunk directories and writes:

```text
top-holders.json
```

The GitHub Actions workflow handles the normal persistent storage and publication path.

## Tools and data safety

The scanner uses conservative request pacing and retries for transient HTTP failures. Completed chunks are stored on the dedicated `holder-scan-data` branch. This provides resumability and keeps generated holder data separate from application source.

Amounts are processed as integer base units using JavaScript `BigInt`; the tools do not convert chain amounts through floating-point arithmetic.

The holder report is a **chain-derived ranking**, not a claim that it is an official rich list.

## Environment variables

### `tools/scan-top-holders.mjs`

| Variable | Default | Purpose |
|---|---|---|
| `NEV369_NODE` | `https://q-lock-ecosystem.com/node` | Node API base URL |
| `START_HEIGHT` | `0` | First block in the requested scan range |
| `END_HEIGHT` | `START_HEIGHT + 199` | Last block in the requested scan range |
| `CONCURRENCY` | `1` | Number of scan workers |
| `REQUEST_DELAY_MS` | `900` | Minimum spacing between requests |

No API keys or secrets are required by the application.

## GitHub Actions

- **Top Holders Scan** — scans missing block chunks, persists completed chunks, and publishes a merged report when the complete range is available.
- **Top Holders Merge** — independently rebuilds the published report from persisted chunks.
- **Live Self-Test** — opens the production site with Playwright and validates the raw-block memo recovery path.

The workflows use a non-cancelling concurrency group so an in-progress scan is not interrupted by another scheduled invocation.

## Development principles

- Prefer small, readable modules over a monolithic page.
- Keep chain-derived data separate from frontend source.
- Preserve resumability before optimizing throughput.
- Use integer arithmetic for blockchain amounts.
- Treat upstream data as untrusted input and validate it.
- Avoid destructive Git operations during maintenance.

## License

MIT. See [LICENSE](LICENSE).
