# Ghost Wallet

**Privacy by default. Leave no network trace.**

Ghost Wallet is an SPV (Simplified Payment Verification) desktop wallet for Bitcoin Cash (BCH), built with Electron and designed from the ground up with a **privacy-first architecture**.

Unlike traditional wallets that leak the user's IP address to public servers when checking balances, Ghost Wallet natively integrates the **Tor** network engine — invisibly and automatically.

---

## Key Features

- **Tor-Only Networking (Fail-Closed):** All network traffic is routed through Tor via a local SOCKS5h proxy. If Tor is unavailable, the wallet simply does not connect — no clearnet fallback, ever.
- **Circuit Rotation:** Force a new Tor circuit (`SIGNAL NEWNYM`) to change your network identity instantly, without restarting the app.
- **Hierarchical Deterministic (HD) & Legacy Keys:** Supports BIP39 12 to 24-word seed phrases, 64-character (256-bit) HD seeds (deriving full BIP32/BIP44 `m/44'/145'/0'/0/i` trees), and single-address Legacy hex keys.
- **Interactive QR Codes & Privacy Overlay:** Each wallet card features a QR code with an automatic blur overlay to prevent shoulder surfing, clickable to reveal.
- **Max Send & Fee Estimation:** Automatic Network Fee calculation and maximum spendable balance estimation before sending transactions.
- **Satoshis & BCH Unit Formatting:** Toggle between BCH and satoshi displays with locale-aware thousands separators.
- **Local Cryptography:** Private keys never leave your computer. All transaction signing is performed 100% offline.
- **Real-Time Fiat Price Display:** BCH prices are fetched through Tor (Kraken, Bitfinex, CoinGecko, Coinbase, CoinCap) with FX conversion for non-USD currencies.
- **Multi-Language Support:** Native English and Spanish (EN/ES) internationalization system with live language switcher.
- **AES-256-GCM Storage Encryption:** Saved wallets are encrypted locally on disk using password-derived keys.
- **Cross-Platform:** Native support for Windows, Linux, and macOS. Automatically downloads and verifies the correct Tor expert bundle for the host platform.

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

---

## Security Architecture

- **Fail-Closed Network Guard:** A monkey-patched `ws` WebSocket module blocks any non-Tor connection attempts — clearnet traffic is physically prevented.
- **Cookie Authentication:** The Tor ControlPort uses 32-byte cookie authentication to prevent unauthorized local processes from hijacking the circuit.
- **SOCKS5h Remote DNS:** Domain resolution is delegated strictly to the Tor exit node, preventing local DNS leaks.
- **Strict Content-Security-Policy:** The HTML rendering layer enforces CSP rules that prohibit remote script execution and external network fetches outside the main IPC process.
- **Navigation Guard:** Electron's main process intercepts and blocks unauthorized external URL navigation.
- **SHA256 Binary Integrity Verification:** The downloaded Tor executable is SHA256-hashed before extraction. Any hash mismatch immediately aborts execution to prevent MITM tampering.

---

## Contributing

Security audits and pull requests are welcome. As software that manages cryptocurrency keys, transparent community code review is essential.

## Author & Support

Created by **MadSatCash** — [munia.cash/profile/madsatcash](https://munia.cash/profile/madsatcash)

Support ongoing development: [fundme.cash/campaign/146](https://fundme.cash/campaign/146)

---
*Disclaimer: This software is provided "as is", without warranty of any kind. Use at your own risk.*
