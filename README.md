# NevWhisper

Live NEV369 memo reader and chain-derived holder analytics.

NevWhisper is a lightweight public web application for reading **NEV369 on-chain memo messages ("whispers")** and inspecting a live **Top Holders** ranking derived from raw block data.

## Live application

- **NevWhisper:** https://mattcodeai91.github.io/nevwhisper/
- **Top Holders tab:** https://mattcodeai91.github.io/nevwhisper/?tab=holders
- **NEV369 Explorer:** https://q-lock-ecosystem.com/explorer/
- **Persisted holder state:** `holder-scan-data` branch

The former standalone Top Holders site now redirects to the unified Top Holders tab.

## Features

- **Memo Reader** — reads NEV369 memo transactions and maintains a browser-side archive.
- **Genesis → Live verification** — verifies chain history and catches up to the current chain tip.
- **Raw-block recovery** — rechecks recent raw blocks so memos missed by aggregate endpoints can still be recovered.
- **Top Holders** — ranks addresses by balances derived from raw NEV369 transactions.
- **Live holder rebuild** — when the persisted holder snapshot is invalid or incomplete, the browser can rebuild balances from Genesis and show balances as the scan advances.
- **Incremental holder publication** — GitHub Actions maintain a resumable authoritative holder snapshot on the `holder-scan-data` branch.
- **Address tools** — holder addresses can be opened in the explorer or copied directly.
- **Dark / Light themes** — shared visual system across Memo Reader and Top Holders.
- **Production self-test** — GitHub Actions exercise the deployed application against live chain data.

## Project structure

```text
nevwhisper/
├── .github/
│   └── workflows/
│       ├── live-self-test.yml
│       └── top-holders.yml
├── holders/
│   └── index.html              # compatibility redirect to ?tab=holders
├── src/
│   ├── css/
│   │   └── app.css             # shared application styles
│   └── js/
│       ├── app.js              # Memo Reader, persistence, live polling, tabs
│       └── holders.js          # Top Holders live verification/rebuild UI
├── tools/
│   └── update-top-holders.mjs  # authoritative incremental holder scanner
├── index.html                  # unified Memo Reader / Top Holders application
├── LICENSE
└── README.md
```

## Architecture

### Frontend

The application is a static GitHub Pages site.

1. `index.html` provides the unified application shell.
2. `src/css/app.css` provides the shared UI used by both tabs.
3. `src/js/app.js` manages the Memo Reader, IndexedDB persistence, raw-block recovery, live polling, themes, and tab selection.
4. `src/js/holders.js` reads the published holder snapshot and independently verifies newer blocks in the browser.
5. If the published snapshot fails reward-accounting validation, the Top Holders tab performs a browser-side Genesis rebuild and displays live balances while scanning.

The browser never publishes holder state back to GitHub.

### Holder scanner

The authoritative persisted holder state is maintained by:

- `.github/workflows/top-holders.yml`
- `tools/update-top-holders.mjs`
- the `holder-scan-data` branch

The workflow runs incrementally, resumes from the persisted snapshot, catches up to the live chain, and pushes the updated `top-holders.json` back to `holder-scan-data`.

NEV amounts are processed in integer base units with JavaScript `BigInt`. Protocol mining rewards are accounted for as **369 NEV per successful block** rather than trusting an arbitrary `NETWORK_REWARD.amount` field.

## Running locally

No build system is required.

From the repository root:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

Top Holders can be opened directly with:

```text
http://localhost:8080/?tab=holders
```

Because the frontend uses ES modules, opening `index.html` directly with a `file://` URL is not recommended.

## Holder scanner

The incremental scanner requires Node.js 20+.

Normal production scanning is handled by GitHub Actions. The workflow currently invokes:

```bash
node tools/update-top-holders.mjs
```

Important production scanner settings are defined in `.github/workflows/top-holders.yml`, including the NEV369 node endpoint and request pacing.

## Data safety

- The active holder scanner is isolated from frontend source changes through workflow path filters.
- Persisted holder data lives on the dedicated `holder-scan-data` branch.
- The scheduled scan uses a non-cancelling concurrency group so a newer schedule does not terminate an in-progress scan.
- Browser-side rebuild checkpoints are local to the browser and do not overwrite the authoritative GitHub snapshot.
- Chain amounts are handled with integer arithmetic.

## GitHub Actions

### NEV369 Top Holders Scan

Runs the authoritative incremental holder scanner and publishes the updated snapshot to `holder-scan-data`.

### NevWhisper live self-test

Loads the deployed site with Playwright and validates the production Memo Reader against live NEV369 data.

## Maintenance rule

The active holder pipeline is intentionally small:

```text
top-holders.yml → update-top-holders.mjs → holder-scan-data/top-holders.json
```

Legacy chunk scanners and the old merge workflow have been removed so there is only one authoritative holder-scanning path.

## License

MIT. See [LICENSE](LICENSE).
