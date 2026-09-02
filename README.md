# Ghost Wallet

**Privacy by default. Leave no network trace. Trust no server.**

Ghost Wallet is an SPV (Simplified Payment Verification) desktop wallet for Bitcoin Cash (BCH), built with Electron and designed from the ground up with a **privacy-first architecture**.

Unlike traditional wallets that leak the user's IP address to public servers when checking balances, Ghost Wallet natively integrates the **Tor** network engine — invisibly and automatically.

And unlike most SPV wallets, it does not take a server's word for anything it can verify itself.

---

## Download & Verify

Installers are published on the [Releases page](https://github.com/MadSatCash/Ghost-Wallet/releases).

**Always verify the checksum before running an installer.** These builds are not Authenticode-signed, so Windows SmartScreen will report an unknown publisher — the SHA-256 is how you confirm the file is the one published here.

```bash
# Windows
certutil -hashfile "Ghost Wallet Setup 0.10.0.exe" SHA256

# Linux / macOS
shasum -a 256 "Ghost Wallet Setup 0.10.0.exe"
```

Compare the output against the `SHA256SUMS.txt` published with the release. Case does not matter: `certutil` prints lowercase, PowerShell's `Get-FileHash` prints uppercase. If it does not match character for character, do not run it.

Current releases are Windows-only. Linux and macOS run from source (see below).

---

## Trust Model

A balance is not signed by anyone. If an Electrum server lies about it, a naive wallet has no way to notice. Ghost Wallet answers that in three layers, strongest first:

- **Proof-of-work verified header chain.** Every block header is checked for three things: that it chains to the previous one, that its hash meets the target it declares, and that the declared difficulty is exactly what ASERT requires. This is the only check that is not a vote — a valid header costs real mining work, so it holds even if every server operator colludes. Without the ASERT check an attacker could declare any difficulty they liked, so it is not optional.
- **SPV merkle proofs.** Transaction inclusion is verified against a merkle root taken from a PoW-verified header — never from the server that supplied the proof. A forged proof fails to reconstruct the root and detects itself, which is why a single server is enough for this query.
- **Cross-operator quorum.** What cannot be proven cryptographically (balances, address history) is requested from several independent operators and must agree. Height skew is trimmed before comparing and unconfirmed mempool data is excluded from the strict compare, so legitimate differences between servers do not raise false alarms.

The server list spans **7 servers across 6 independent operators**. Each read queries 3 of them over separate Tor circuits, and 2 must agree for a result to count as verified.

---

## Key Features

### Privacy

- **Tor-Only Networking (Fail-Closed):** All network traffic is routed through Tor via a local SOCKS5h proxy. If Tor is unavailable, the wallet simply does not connect — no clearnet fallback, ever.
- **Circuit Rotation:** Force a new Tor circuit (`SIGNAL NEWNYM`) to change your network identity instantly, without restarting the app.
- **Address-Aware Coin Selection:** Spends come from a single address whenever one covers the amount. Signing several inputs together publishes on-chain that those addresses share an owner — the oldest and most reliable chain-analysis heuristic. When more than one address is unavoidable, the wallet warns you before you sign.
- **Dust Is Left Behind:** Inputs that would cost more in fee than they carry are excluded from the transaction and reported, rather than swept in.
- **Interactive QR Codes & Privacy Overlay:** Each wallet card features a QR code with an automatic blur overlay to prevent shoulder surfing, clickable to reveal.

### Keys & Signing

- **Hierarchical Deterministic (HD) & Legacy Keys:** Supports BIP39 12 to 24-word seed phrases, 64-character (256-bit) HD seeds (deriving full BIP32/BIP44 `m/44'/145'/0'/0/i` trees), and single-address Legacy hex keys.
- **Local Cryptography:** Private keys never leave your computer. All transaction signing is performed 100% offline.
- **Single Master Password:** One password, asked once when the app opens. It unlocks the whole vault for the session, so signing a transaction, revealing a seed or saving a new wallet never prompts again.
- **AES-256-GCM Vault Encryption:** The entire wallet file is encrypted on disk under a key derived from the master password (PBKDF2-SHA256, 600k iterations). Names, addresses, xpubs and group names are inside the ciphertext, so a stolen file does not even reveal how many wallets it holds.

### Interface

- **Wallet Groups with Per-Group Totals:** Wallets can be organised into groups. The home screen opens on the list of groups, each with its own total, and picking one swaps that column for the wallets it holds; the grand total across every wallet stays in view either way. Deleting a group never deletes the wallets inside it — they become ungrouped. Totals say so when they are partial: balances still loading, servers that did not answer, or figures that failed the cross-operator check.
- **Max Send & Fee Estimation:** Automatic network fee calculation and maximum spendable balance estimation before sending transactions.
- **Satoshis & BCH Unit Formatting:** Toggle between BCH and satoshi displays with locale-aware thousands separators.
- **Real-Time Fiat Price Display:** BCH prices are fetched through Tor (Kraken, Bitfinex, CoinGecko, Coinbase, CoinCap) with FX conversion for non-USD currencies.
- **Multi-Language Support:** Native English and Spanish (EN/ES) internationalization system with live language switcher.

### Platform

- **Cross-Platform Source:** Runs on Windows, Linux and macOS, automatically downloading and verifying the correct Tor expert bundle for the host platform. Only Windows installers are published as releases so far; the Linux (AppImage) and macOS (DMG) build targets are declared but not yet released.

---

## Installation & Usage

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm (included with Node.js)

### Running Locally

1. Clone this repository:
   ```bash
   git clone https://github.com/MadSatCash/Ghost-Wallet.git
   cd Ghost-Wallet
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the wallet:
   ```bash
   npm start
   ```

On first launch, the application automatically downloads the Tor expert bundle (~15 MB) for your operating system, verifies its SHA256 hash against the hardcoded official hash, and launches the Tor background daemon.

The first run also synchronizes and verifies the block header chain from a built-in checkpoint. The checkpoint itself is not a block some server named: it was produced by `tools/make-checkpoint.mjs`, which walks the chain from the 2020 ASERT anchor and verifies every header along the way.

---

## Building Executables

Ghost Wallet uses `electron-builder` to produce standalone desktop installers and binaries.

```bash
# Build for Windows (NSIS Installer)
npm run build:win

# Build for Linux (AppImage)
npm run build:linux

# Build for macOS (DMG)
npm run build:mac

# Build for current OS
npm run build
```

Packaged installers and executables are generated in the `dist/` directory.

Note: the `electron-builder` log prints `signing with signtool.exe` even when no code-signing certificate is configured. It is not evidence that the output was signed — check with `Get-AuthenticodeSignature` on Windows.

---

## Testing

The unit suite runs offline against fixed vectors and needs no network:

```bash
npm test
```

The `tools/` directory holds probes, benchmarks and smoke tests that run against the **live network over Tor**. They are deliberately not part of `npm test`: they are slow, they depend on third-party servers being up, and a failure there does not necessarily mean the code is wrong. Run them individually:

```bash
node tools/smoke-chain.mjs              # full shield: sync, verify PoW + ASERT,
                                        # fetch a real merkle proof, verify it,
                                        # and confirm a tampered proof is rejected
node tools/smoke-consensus.mjs [addr]   # multi-operator pool over Tor, real agreement
node tools/smoke-price.mjs              # production price path across all 15 UI currencies

node tools/probe-servers.mjs            # which public Fulcrum servers are still alive
node tools/probe-merkle.mjs             # what a merkle proof costs and proves
node tools/bench-headers.mjs [months]   # header download strategies compared
node tools/bench-verify.mjs             # download + verification, all four stages
node tools/make-checkpoint.mjs          # regenerate the chain.js checkpoint
```

`probe-servers.mjs` exists because the server list in `src/core/network.js` cannot be maintained from memory — public servers appear and disappear. Run it before editing that list.

---

## Security Architecture

- **Fail-Closed Network Guard:** A monkey-patched `ws` WebSocket module blocks any non-Tor connection attempts — clearnet traffic is physically prevented.
- **Cookie Authentication:** The Tor ControlPort uses 32-byte cookie authentication to prevent unauthorized local processes from hijacking the circuit.
- **SOCKS5h Remote DNS:** Domain resolution is delegated strictly to the Tor exit node, preventing local DNS leaks.
- **Strict Content-Security-Policy:** The HTML rendering layer enforces CSP rules that prohibit remote script execution and external network fetches outside the main IPC process.
- **Navigation Guard:** Electron's main process intercepts and blocks unauthorized external URL navigation.
- **SHA256 Binary Integrity Verification:** The downloaded Tor executable is SHA256-hashed before extraction. Any hash mismatch immediately aborts execution to prevent MITM tampering.
- **Nothing Unverified Reaches Storage:** Headers are downloaded in batches and verified as a whole batch. If verification fails the batch is discarded entirely — partial "the good ones" are never kept.

### Known Issues

Three advisories remain open in `bn.js` and `elliptic`, pulled in transitively by `bitcore-lib-cash`, which performs transaction signing. There is no upstream fix. They are tracked and under evaluation.

Released installers are not Authenticode-signed. Verify downloads with the published SHA-256.

---

## Contributing

Security audits and pull requests are welcome. As software that manages cryptocurrency keys, transparent community code review is essential.

## Author & Support

Created by **MadSatCash** — [munia.cash/profile/madsatcash](https://munia.cash/profile/madsatcash)

Support ongoing development: [fundme.cash/campaign/146](https://fundme.cash/campaign/146)

---
*Disclaimer: This software is provided "as is", without warranty of any kind. Use at your own risk.*
