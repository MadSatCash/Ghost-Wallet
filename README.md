# Ghost Wallet

**Privacy by default. Leave no network trace.**

Ghost Wallet is an SPV (Simplified Payment Verification) desktop wallet for Bitcoin Cash (BCH), built with Electron and designed from the ground up with a **privacy-first architecture**.

Unlike traditional wallets that leak the user's IP address to public servers when checking balances, Ghost Wallet natively integrates the **Tor** network engine — invisibly and automatically.

## Features

- **Tor-Only Networking (Fail-Closed):** All network traffic is routed through Tor via a local SOCKS5h proxy. If Tor is unavailable, the wallet simply does not connect — no clearnet fallback, ever.
- **Circuit Rotation:** Force a new Tor circuit (`SIGNAL NEWNYM`) to change your network identity instantly, without restarting the app.
- **Local Cryptography:** Private keys (BIP39 seed phrases or raw 64-char hex secrets) never leave your computer. Transaction signing is performed 100% offline.
- **Fiat Price Display:** Real-time BCH price fetched entirely through Tor (Kraken, Bitfinex, CoinGecko, Coinbase, CoinCap) with FX conversion for non-USD currencies.
- **Multi-Language:** English and Spanish (EN/ES) with a language selector.
- **Cross-Platform:** Runs on Windows, Linux, and macOS. The Tor expert bundle is downloaded automatically for the detected platform.
- **SPV via Fulcrum Nodes:** Uses `@electrum-cash/network` to interact with public SPV servers in a decentralized way.
- **AES-256-GCM Encryption:** Saved wallets are stored locally, encrypted with your password.

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm (included with Node.js)

### Steps

1. Clone this repository:
   ```bash
   git clone https://github.com/MadSatCash/Ghost-Wallet.git
   cd Ghost-Wallet
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the wallet:
   ```bash
   npm start
   ```

On first launch, the app will download the Tor expert bundle (~15 MB) for your platform, verify its SHA256 hash against the hardcoded official hash, and start the Tor daemon automatically.

## Security Architecture

- **Fail-Closed Design:** A monkey-patched `ws` module throws on any non-Tor connection attempt — clearnet is mathematically blocked.
- **CookieAuthentication:** The Tor ControlPort requires 32-byte cookie authentication, preventing malicious local processes from hijacking the circuit.
- **SOCKS5h (Remote DNS):** DNS resolution happens at the Tor exit node, preventing DNS leaks.
- **Strict Content-Security-Policy:** The UI blocks all external resources and cross-origin scripts.
- **Navigation Blocking:** Electron's main process prevents accidental external link opening.
- **SHA256 Verification:** The Tor binary is verified against a hardcoded hash before extraction — a hash mismatch aborts the process (possible MITM protection).

## Contributing

Security audits and pull requests are welcome. As software that handles cryptocurrency, community code review is the most important pillar.

## Support Development

Help keep this project going: [fundme.cash/campaign/146](https://fundme.cash/campaign/146)

---
*Disclaimer: This software is provided "as is". Use at your own risk.*
