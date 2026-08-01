const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Inicializar selectores de idioma y moneda ---
const langSelect = $('#lang-select');
const currencySelect = $('#currency-select');
const priceStatus = $('#price-status');
let priceRequestId = 0;
let priceLoadPromise = null;
let priceRetryTimer = null;
let lastPriceError = '';
let torState = 'starting';

langSelect.value = getLang();
CURRENCIES.forEach(function(c) {
  const opt = document.createElement('option');
  opt.value = c.code;
  opt.textContent = c.code + ' (' + c.symbol + ')';
  currencySelect.appendChild(opt);
});
currencySelect.value = getCurrency();

function setPriceStatus(text, state, title) {
  if (!priceStatus) return;
  priceStatus.textContent = text || '';
  priceStatus.className = 'price-status' + (state ? ' ' + state : '');
  priceStatus.title = title || '';
}

function clearPriceRetry() {
  if (!priceRetryTimer) return;
  clearTimeout(priceRetryTimer);
  priceRetryTimer = null;
}

function schedulePriceRetry(delayMs) {
  clearPriceRetry();
  if (torState !== 'ready') return;
  priceRetryTimer = setTimeout(function() {
    priceRetryTimer = null;
    refreshPriceIfTorReady({ silent: false });
  }, delayMs || 15000);
}

function currentFiatPlaceholder() {
  if (torState === 'disabled') return t('price_waiting_tor');
  if (torState !== 'ready') return t('price_establishing_network');
  if (priceLoadPromise) return t('price_loading');
  if (lastPriceError) return t('price_retrying');
  return t('price_loading');
}

function syncTorState(status) {
  if (status && status.enabled && status.ready) torState = 'ready';
  else if (status && (status.enabled || status.ready)) torState = 'starting';
  else torState = 'disabled';
}

function looksLikeTorReadyMessage(msg) {
  var text = String(msg || '').toLowerCase();
  return text.includes('bootstrapped 100%') ||
    text.includes('100%!') ||
    text.includes('conectado a la red tor') ||
    text.includes('connected to the tor network');
}

function renderPriceStatus() {
  var price = fmtPricePerBch();
  if (price) {
    var key = isUsingFallbackPrice() ? 'price_ready_fallback' : 'price_ready';
    setPriceStatus(t(key, { price: price, currency: getCurrency() }), 'ok', getPriceSource());
    return;
  }
  if (torState === 'disabled') {
    setPriceStatus(t('price_waiting_tor'), 'muted');
    return;
  }
  if (torState !== 'ready') {
    setPriceStatus(t('price_establishing_network'), 'muted');
    return;
  }
  if (priceLoadPromise) {
    setPriceStatus(t('price_loading'), 'loading');
    return;
  }
  if (lastPriceError) {
    setPriceStatus(t('price_retrying'), 'warn', lastPriceError);
    return;
  }
  setPriceStatus(t('price_unavailable'), 'bad');
}

function updateAllFiatDisplays() {
  document.querySelectorAll('[data-sats]').forEach(function(el) {
    var fiat = fmtFiat(Number(el.dataset.sats));
    el.textContent = fiat || currentFiatPlaceholder();
  });
}

function withTimeout(promise, ms, message) {
  var timer;
  var timeout = new Promise(function(_resolve, reject) {
    timer = setTimeout(function() {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function() {
    clearTimeout(timer);
  });
}

function refreshPrice(options) {
  options = options || {};
  if (torState !== 'ready') {
    renderPriceStatus();
    updateAllFiatDisplays();
    return Promise.resolve();
  }
  if (priceLoadPromise && !options.force) return priceLoadPromise;
  var requestId = ++priceRequestId;
  lastPriceError = '';
  clearPriceRetry();
  var allCodes = CURRENCIES.map(function(c) { return c.code.toLowerCase(); }).join(',');
  var currentPromise = withTimeout(window.api.getBchPrice(allCodes, !!options.force), 35000, 'Price request timed out').then(function(payload) {
    if (requestId !== priceRequestId) return;
    setBchPrices(payload);
    lastPriceError = '';
    clearPriceRetry();
  }).catch(function(err) {
    if (requestId !== priceRequestId) return;
    console.error('Price fetch failed:', err);
    lastPriceError = err && err.message ? err.message : String(err);
    if (!fmtPricePerBch()) schedulePriceRetry();
  }).finally(function() {
    if (priceLoadPromise === currentPromise) priceLoadPromise = null;
    renderPriceStatus();
    updateAllFiatDisplays();
  });
  priceLoadPromise = currentPromise;
  renderPriceStatus();
  updateAllFiatDisplays();
  return currentPromise;
}

function ensurePriceLoaded(options) {
  if (fmtPricePerBch()) return Promise.resolve();
  if (torState !== 'ready') {
    renderPriceStatus();
    updateAllFiatDisplays();
    return Promise.resolve();
  }
  return refreshPrice(options);
}

function refreshPriceIfTorReady(options) {
  return window.api.torStatus().then(function(s) {
    syncTorState(s);
    if (s.enabled && s.ready) return refreshPrice(options);
    renderPriceStatus();
    updateAllFiatDisplays();
  }).catch(function() {
    torState = 'starting';
    renderPriceStatus();
    updateAllFiatDisplays();
  });
}

langSelect.addEventListener('change', function() {
  setLang(langSelect.value);
  updateGenerateButtonText();
  if (torState === 'ready') {
    setTorConnectedUI();
  } else if (torState === 'disabled') {
    setTorDisconnectedUI();
  } else {
    setTorStartingUI();
  }
  renderPriceStatus();
  updateAllFiatDisplays();
});

currencySelect.addEventListener('change', function() {
  setCurrency(currencySelect.value);
  updateAllFiatDisplays();
  renderPriceStatus();
  if (getDisplayedPriceCode() !== getCurrency()) refreshPriceIfTorReady({ silent: false });
});

var refreshPriceBtn = $('#btn-refresh-price');
refreshPriceBtn.addEventListener('click', function() {
  if (torState !== 'ready') return;
  refreshPriceBtn.classList.add('spinning');
  refreshPrice({ force: true }).finally(function() {
    refreshPriceBtn.classList.remove('spinning');
  });
});

$('.logo').addEventListener('click', function() {
  if (torState !== 'ready') return;
  refreshPrice({ force: true });
  loadSavedWallets();
});

applyTranslations();
renderPriceStatus();
refreshPriceIfTorReady({ silent: true });

// --- Navegacion entre pantallas ---
function goTo(name) {
  $$('.screen').forEach(function(s) { s.classList.toggle('active', s.dataset.screen === name); });

  if (name === 'welcome') {
    loadSavedWallets();
    $('#create-result').classList.add('hidden');
    $('#mnemonic-grid').innerHTML = '';
    $('#secret-box').innerHTML = '';
    $('#create-address').classList.add('hidden');
    $('#save-create-section').classList.add('hidden');
    $('#save-create-name').value = '';
    $('#save-create-password').value = '';
    $('#save-create-error').classList.add('hidden');
    currentMnemonic = '';
    currentSecret = '';

    $('#import-input').value = '';
    $('#import-hint').textContent = '';
    $('#import-hint').className = 'hint';
    $('#import-hex-mode').classList.add('hidden');
    $$('.import-mode-btn').forEach(function(b) { b.classList.remove('active'); });
    importHexType = '';
    $('#import-result').classList.add('hidden');
    $('#save-import-section').classList.add('hidden');
    $('#save-import-name').value = '';
    $('#save-import-password').value = '';
    $('#save-import-error').classList.add('hidden');
  }
}
$$('[data-go]').forEach(function(el) { el.addEventListener('click', function() { goTo(el.dataset.go); }); });

// --- Utilidades de UI ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function addressBox(label, address, note) {
  var box = document.createElement('div');
  box.className = 'address-box';
  box.innerHTML =
    '<div class="lbl">' + escapeHtml(label) + '</div>' +
    '<div class="row">' +
      '<span class="addr">' + escapeHtml(address) + '</span>' +
      '<button class="copy">' + t('copy') + '</button>' +
    '</div>' +
    (note ? '<div class="muted-note">' + escapeHtml(note) + '</div>' : '');
  var btn = box.querySelector('.copy');
  btn.addEventListener('click', async function() {
    await navigator.clipboard.writeText(address);
    btn.textContent = t('copied');
    setTimeout(function() { btn.textContent = t('copy'); }, 1200);
  });
  return box;
}

function fmtBch(sats) {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BCH';
}

function fmtSats(sats) {
  var sep = getLang() === 'es' ? '.' : ',';
  var str = Math.abs(sats).toString();
  var result = '';
  for (var i = str.length - 1, c = 0; i >= 0; i--, c++) {
    if (c > 0 && c % 3 === 0) result = sep + result;
    result = str[i] + result;
  }
  return result + ' sats';
}

function balanceHead(confirmed, unconfirmed) {
  var total = (confirmed || 0) + (unconfirmed || 0);
  var el = document.createElement('div');
  el.className = 'balance-head';
  var fiat = fmtFiat(total) || currentFiatPlaceholder();
  ensurePriceLoaded({ silent: true }).then(updateAllFiatDisplays);
  el.innerHTML =
    '<div class="balance-label">' + t('total_balance') + '</div>' +
    '<div class="balance-amount">' + escapeHtml(fmtBch(total)) + '</div>' +
    '<div class="balance-fiat" data-sats="' + total + '">' + escapeHtml(fiat) + '</div>' +
    (unconfirmed ? '<div class="balance-pending">' + t('includes_unconfirmed', { amount: fmtBch(unconfirmed) }) + '</div>' : '');
  return el;
}

function isHdWalletType(type) {
  return type === 'mnemonic' || type === 'hex_hd';
}

// =========================== CREAR ===========================
var createType = 'mnemonic';
var currentMnemonic = '';
var currentSecret = '';
updateGenerateButtonText();

function updateGenerateButtonText() {
  $('#btn-generate').textContent = createType === 'mnemonic' ? t('generate_mnemonic') : t('generate_hex');
}

$$('.create-type-seg .seg-btn').forEach(function(b) { b.addEventListener('click', function() {
  createType = b.dataset.ctype;
  $$('.create-type-seg .seg-btn').forEach(function(x) { x.classList.toggle('active', x === b); });
  $('#field-words').classList.toggle('hidden', createType !== 'mnemonic');
  $('#field-hex').classList.toggle('hidden', createType !== 'hex');
  $('#field-hex-hd').classList.toggle('hidden', createType !== 'hex_hd');
  updateGenerateButtonText();
  $('#create-result').classList.add('hidden');
}); });

$('#btn-generate').addEventListener('click', async function() {
  var grid = $('#mnemonic-grid');
  var secretBox = $('#secret-box');
  grid.innerHTML = '';
  secretBox.innerHTML = '';
  $('#create-address').classList.add('hidden');
  $('#create-address').innerHTML = '';
  $('#save-create-section').classList.add('hidden');

  if (createType === 'mnemonic') {
    $('#btn-copy-mnemonic').classList.remove('hidden');
    var words = Number($('#word-count').value);
    currentMnemonic = await window.api.generateMnemonic(words);
    currentSecret = '';
    $('#create-warning').textContent = t('warning_mnemonic');
    currentMnemonic.split(' ').forEach(function(word, i) {
      var el = document.createElement('div');
      el.className = 'word';
      el.innerHTML = '<span class="num">' + (i + 1) + '</span>' + escapeHtml(word);
      grid.appendChild(el);
    });
  } else {
    currentSecret = await window.api.generateHexSecret();
    currentMnemonic = '';
    $('#create-warning').textContent = createType === 'hex_hd' ? t('warning_hex_hd') : t('warning_hex');
    var box = document.createElement('div');
    box.className = 'secret-box';
    box.innerHTML =
      '<div class="lbl">' + t('your_secret') + '</div>' +
      '<div class="row">' +
        '<span class="secret">' + escapeHtml(currentSecret) + '</span>' +
        '<button class="copy" id="copy-secret">' + t('copy') + '</button>' +
      '</div>';
    secretBox.appendChild(box);
    box.querySelector('#copy-secret').addEventListener('click', async function(e) {
      await navigator.clipboard.writeText(currentSecret);
      e.target.textContent = t('copied');
      setTimeout(function() { e.target.textContent = t('copy'); }, 1200);
    });
    $('#btn-copy-mnemonic').classList.add('hidden');
  }

  $('#create-result').classList.remove('hidden');
});

$('#btn-copy-mnemonic').addEventListener('click', async function(e) {
  if (currentMnemonic) {
    await navigator.clipboard.writeText(currentMnemonic);
    var orig = e.target.textContent;
    e.target.textContent = t('copied');
    setTimeout(function() { e.target.textContent = orig; }, 1200);
  }
});

$('#btn-saved').addEventListener('click', async function() {
  var target = $('#create-address');
  target.classList.remove('hidden');
  target.innerHTML = '<div class="loading">' + t('calculating_address') + '</div>';

  var address, label;
  if (createType === 'mnemonic') {
    var addrs = await window.api.fromMnemonic(currentMnemonic, { count: 1 });
    address = addrs[0].address;
    label = t('first_address');
  } else if (createType === 'hex_hd') {
    var addrs = await window.api.fromHexHd(currentSecret, { count: 1 });
    address = addrs[0].address;
    label = t('first_address');
  } else {
    var cands = await window.api.fromHex(currentSecret);
    address = cands.find(function(c) { return c.recipe === 'compressed'; }).address;
    label = t('standard_address');
  }

  target.innerHTML = '';
  var box = addressBox(label, address, t('share_address'));
  target.appendChild(box);

  var bal = document.createElement('div');
  bal.className = 'muted-note';
  bal.textContent = t('checking_balance');
  box.appendChild(bal);
  try {
    var b = await window.api.getBalance(address);
    bal.textContent = t('balance_prefix') + fmtBch((b.confirmed || 0) + (b.unconfirmed || 0));
  } catch (e) {
    bal.textContent = t('balance_error');
  }

  $('#save-create-name').value = '';
  $('#save-create-password').value = '';
  $('#save-create-error').classList.add('hidden');
  $('#save-create-section').classList.remove('hidden');
});

// =========================== IMPORTAR ===========================
var importInput = $('#import-input');
var importHint = $('#import-hint');
var importHexType = '';

var hintTimer = null;
importInput.addEventListener('input', function() {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateHint, 150);
});

async function updateHint() {
  var val = importInput.value.trim();
  if (!val) {
    importHint.textContent = '';
    importHint.className = 'hint';
    $('#import-hex-mode').classList.add('hidden');
    $$('.import-mode-btn').forEach(function(b) { b.classList.remove('active'); });
    importHexType = '';
    return;
  }
  var type = await window.api.detectInput(val);
  var isHex = type === 'hex';
  $('#import-hex-mode').classList.toggle('hidden', !isHex);
  if (!isHex) {
    $$('.import-mode-btn').forEach(function(b) { b.classList.remove('active'); });
    importHexType = '';
  }
  var map = {
    hex: [t('hex_detected'), 'ok'],
    mnemonic: [t('mnemonic_detected'), 'ok'],
    'mnemonic-invalid': [t('mnemonic_invalid'), 'bad'],
    unknown: [t('unknown_format'), 'bad'],
  };
  var entry = map[type] || ['', 'hint'];
  importHint.textContent = entry[0];
  importHint.className = 'hint ' + entry[1];
}

$$('.import-mode-btn').forEach(function(b) {
  b.addEventListener('click', function() {
    importHexType = b.dataset.importHexType;
    $$('.import-mode-btn').forEach(function(x) { x.classList.toggle('active', x === b); });
    $('#import-result').classList.add('hidden');
    $('#save-import-section').classList.add('hidden');
  });
});

$('#btn-import').addEventListener('click', async function() {
  var val = importInput.value.trim();
  var out = $('#import-result');
  out.classList.remove('hidden');
  if (!val) { out.innerHTML = '<div class="error">' + t('paste_first') + '</div>'; return; }
  $('#save-import-section').classList.add('hidden');

  var type = await window.api.detectInput(val);
  if (type !== 'hex' && type !== 'mnemonic') {
    out.innerHTML = '<div class="error">' + t('unrecognized_input') + '</div>';
    return;
  }
  if (type === 'hex' && !importHexType) {
    out.innerHTML = '<div class="error">' + t('import_hex_mode_required') + '</div>';
    return;
  }

  out.innerHTML = '<div class="loading">' + t('connecting_network') + '</div>';

  try {
    if (type === 'hex' && importHexType === 'hex') {
      var r = await window.api.resolveHexSecret(val);
      var chosen = r.candidates.find(function(c) { return c.recipe === r.chosenRecipe; });
      var other = r.candidates.find(function(c) { return c.recipe !== r.chosenRecipe; });
      var total = chosen.confirmed + chosen.unconfirmed;

      out.innerHTML = '';
      out.appendChild(balanceHead(chosen.confirmed, chosen.unconfirmed));
      var note = total > 0
        ? t('detected_balance', { version: chosen.label.toLowerCase() })
        : t('no_balance_found');
      out.appendChild(addressBox(t('your_address', { label: chosen.label }), chosen.address, note));
      if (other) {
        out.appendChild(addressBox(
          t('other_version', { label: other.label }),
          other.address,
          t('balance_here') + fmtBch(other.confirmed + other.unconfirmed)
        ));
      }
      if (r.server) out.appendChild(serverNote(r.server));

      currentImportedSecret = val;
      currentImportedType = 'hex';
      currentImportedAddress = chosen.address;

      $('#save-import-name').value = '';
      $('#save-import-password').value = '';
      $('#save-import-error').classList.add('hidden');
      $('#save-import-section').classList.remove('hidden');
      return;
    }

    if (type === 'hex' && importHexType === 'hex_hd') {
      var r = await window.api.hexHdReport(val, 5);
      out.innerHTML = '';
      out.appendChild(balanceHead(r.total.confirmed, r.total.unconfirmed));
      var titleEl = document.createElement('p');
      titleEl.className = 'subtitle';
      titleEl.textContent = t('first_addresses');
      out.appendChild(titleEl);
      r.addresses.forEach(function(a) {
        out.appendChild(addressBox(
          t('address_num', { num: a.index + 1 }),
          a.address,
          t('balance_prefix') + fmtBch((a.confirmed || 0) + (a.unconfirmed || 0))
        ));
      });
      if (r.server) out.appendChild(serverNote(r.server));

      currentImportedSecret = val;
      currentImportedType = 'hex_hd';
      currentImportedAddress = r.addresses[0].address;

      $('#save-import-name').value = '';
      $('#save-import-password').value = '';
      $('#save-import-error').classList.add('hidden');
      $('#save-import-section').classList.remove('hidden');
      return;
    }

    // mnemonic
    var r = await window.api.mnemonicReport(val, 5);
    out.innerHTML = '';
    out.appendChild(balanceHead(r.total.confirmed, r.total.unconfirmed));
    var titleEl = document.createElement('p');
    titleEl.className = 'subtitle';
    titleEl.textContent = t('first_addresses');
    out.appendChild(titleEl);
    r.addresses.forEach(function(a) {
      out.appendChild(addressBox(
        t('address_num', { num: a.index + 1 }),
        a.address,
        t('balance_prefix') + fmtBch((a.confirmed || 0) + (a.unconfirmed || 0))
      ));
    });
    if (r.server) out.appendChild(serverNote(r.server));

    currentImportedSecret = val;
    currentImportedType = 'mnemonic';
    currentImportedAddress = r.addresses[0].address;

    $('#save-import-name').value = '';
    $('#save-import-password').value = '';
    $('#save-import-error').classList.add('hidden');
    $('#save-import-section').classList.remove('hidden');
  } catch (err) {
    out.innerHTML = '<div class="error">' + escapeHtml(err.message || String(err)) + '</div>';
  }
});

function serverNote(server) {
  var el = document.createElement('div');
  el.className = 'server-note';
  el.textContent = t('connected_to') + server;
  return el;
}

// =========================== PERSISTENCIA Y DETALLES ===========================
var currentImportedSecret = '';
var currentImportedType = '';
var currentImportedAddress = '';
var selectedWalletId = '';
var currentWalletBalanceSats = 0;

async function loadSavedWallets() {
  var wallets = await window.api.listWallets();
  var section = $('#saved-wallets-section');
  var list = $('#saved-wallets-list');
  list.innerHTML = '';

  if (wallets.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  wallets.forEach(function(w) {
    var item = document.createElement('div');
    item.className = 'wallet-item';
    var typeLabel = w.type === 'hex'
      ? t('wallet_tag_single')
      : (w.type === 'hex_hd' ? t('wallet_tag_hex_hd') : t('wallet_tag_hd'));
    item.innerHTML =
      '<div class="wallet-item-info">' +
        '<div class="wallet-item-name-row">' +
          '<span class="wallet-item-name">' + escapeHtml(w.name) + '</span>' +
          '<span class="wallet-item-type">' + typeLabel + '</span>' +
        '</div>' +
        '<span class="wallet-item-addr">' + escapeHtml(w.address) + '</span>' +
      '</div>' +
      '<div class="wallet-item-balance-col">' +
        '<div class="wallet-item-balance" id="bal-' + w.id + '">' + t('loading_bch') + '</div>' +
        '<div class="wallet-item-sats" id="sats-' + w.id + '"></div>' +
        '<div class="wallet-item-fiat" id="fiat-' + w.id + '"></div>' +
      '</div>' +
      '<div class="wallet-qr-container" id="qr-' + w.id + '">' +
        '<div class="wallet-qr-overlay">' +
          '<span class="wallet-qr-icon">QR</span>' +
        '</div>' +
        '<div class="wallet-qr-code"></div>' +
      '</div>';

    var qrContainer = item.querySelector('.wallet-qr-container');
    qrContainer.addEventListener('click', function(e) {
      e.stopPropagation();
      var isRevealed = qrContainer.classList.toggle('revealed');
      if (isRevealed && !qrContainer.dataset.loaded) {
        qrContainer.dataset.loaded = '1';
        window.api.generateQr(w.address).then(function(svg) {
          qrContainer.querySelector('.wallet-qr-code').innerHTML = svg;
        });
      }
    });

    item.addEventListener('click', function() { showWalletDetails(w.id); });
    list.appendChild(item);

    var balancePromise = isHdWalletType(w.type)
      ? window.api.getHdBalance(w.id)
      : window.api.getBalance(w.address);
    balancePromise.then(function(b) {
      var balEl = document.getElementById('bal-' + w.id);
      var fiatEl = document.getElementById('fiat-' + w.id);
      if (balEl) {
        var totalSats = (b.confirmed || 0) + (b.unconfirmed || 0);
        balEl.textContent = fmtBch(totalSats);
        var satsEl = document.getElementById('sats-' + w.id);
        if (satsEl) satsEl.textContent = fmtSats(totalSats);
        if (fiatEl) {
          fiatEl.dataset.sats = totalSats;
          fiatEl.textContent = fmtFiat(totalSats) || currentFiatPlaceholder();
          ensurePriceLoaded({ silent: true }).then(updateAllFiatDisplays);
        }
      }
    }).catch(function() {
      var balEl = document.getElementById('bal-' + w.id);
      if (balEl) balEl.textContent = t('error_text');
    });
  });
}

async function showWalletDetails(id) {
  selectedWalletId = id;
  var wallets = await window.api.listWallets();
  var w = wallets.find(function(x) { return x.id === id; });
  if (!w) return;

  goTo('wallet-details');

  $('#details-wallet-name').textContent = w.name;
  $('#details-wallet-type').textContent = w.type === 'hex'
    ? t('type_hex_detail')
    : (w.type === 'hex_hd' ? t('type_hex_hd_detail') : t('type_mnemonic_detail'));

  var addrContainer = $('#details-address-container');
  var hdContainer = $('#hd-addresses-container');
  addrContainer.innerHTML = '';

  if (!isHdWalletType(w.type)) {
    addrContainer.appendChild(addressBox(t('bch_public_address'), w.address, t('share_receive')));
    addrContainer.classList.remove('hidden');
    hdContainer.classList.add('hidden');
  } else {
    addrContainer.classList.add('hidden');
    hdContainer.classList.remove('hidden');
    $('#hd-addresses-list').innerHTML = '<div class="loading">' + t('loading_addresses') + '</div>';
  }

  var balContainer = $('#details-balance-container');
  balContainer.innerHTML = '<div class="loading">' + t('loading_balance') + '</div>';

  $('#reveal-password-field').classList.add('hidden');
  $('#btn-reveal-secret').classList.remove('hidden');
  $('#revealed-secret-container').classList.add('hidden');
  $('#revealed-secret-container').innerHTML = '';
  $('#reveal-password').value = '';

  try {
    var b;
    if (!isHdWalletType(w.type)) {
      b = await window.api.getBalance(w.address);
    } else {
      b = await window.api.getHdBalance(w.id);

      var list = $('#hd-addresses-list');
      list.innerHTML = '';
      b.receiveAddresses.forEach(function(a) {
        var div = document.createElement('div');
        div.style.padding = '0.5rem';
        div.style.borderBottom = '1px solid #444';
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';

        var detail = b.details.find(function(d) { return d.address === a.address; });
        var balText = detail ? ' (' + t('balance_prefix') + fmtBch(detail.confirmed + detail.unconfirmed) + ')' : ' (' + t('no_use') + ')';

        div.innerHTML = '<span style="font-family: monospace; font-size: 0.9em; user-select: all;">' + a.address + '</span>' +
                         '<span style="color: ' + (detail ? '#4caf50' : '#888') + '; font-size: 0.8em;">' + balText + '</span>';
        list.appendChild(div);
      });
    }

    currentWalletBalanceSats = (b.confirmed || 0) + (b.unconfirmed || 0);
    balContainer.innerHTML = '';
    balContainer.appendChild(balanceHead(b.confirmed, b.unconfirmed));
  } catch (err) {
    currentWalletBalanceSats = 0;
    balContainer.innerHTML = '<div class="error">' + t('balance_network_error', { error: escapeHtml(err.message || String(err)) }) + '</div>';
  }
}

$('#btn-generate-address').addEventListener('click', async function() {
  var wallets = await window.api.listWallets();
  var w = wallets.find(function(x) { return x.id === selectedWalletId; });
  if (!w || !isHdWalletType(w.type)) return;

  await window.api.incrementReceiveIndex(w.id);
  showWalletDetails(w.id);
});

// Guardado de wallet creada
$('#btn-save-created').addEventListener('click', async function() {
  var name = $('#save-create-name').value.trim();
  var password = $('#save-create-password').value;
  var errorEl = $('#save-create-error');
  errorEl.classList.add('hidden');

  if (!password) {
    errorEl.textContent = t('password_required');
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    var secret = createType === 'mnemonic' ? currentMnemonic : currentSecret;
    var address;
    if (createType === 'mnemonic') {
      var addrs = await window.api.fromMnemonic(currentMnemonic, { count: 1 });
      address = addrs[0].address;
    } else if (createType === 'hex_hd') {
      var addrs = await window.api.fromHexHd(currentSecret, { count: 1 });
      address = addrs[0].address;
    } else {
      var cands = await window.api.fromHex(currentSecret);
      address = cands.find(function(c) { return c.recipe === 'compressed'; }).address;
    }

    await window.api.saveWallet({ name: name, address: address, type: createType, secret: secret, password: password });
    goTo('welcome');
  } catch (err) {
    errorEl.textContent = err.message || t('save_error');
    errorEl.classList.remove('hidden');
  }
});

// Guardado de wallet importada
$('#btn-save-imported').addEventListener('click', async function() {
  var name = $('#save-import-name').value.trim();
  var password = $('#save-import-password').value;
  var errorEl = $('#save-import-error');
  errorEl.classList.add('hidden');

  if (!password) {
    errorEl.textContent = t('password_required');
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await window.api.saveWallet({ name: name, address: currentImportedAddress, type: currentImportedType, secret: currentImportedSecret, password: password });
    goTo('welcome');
  } catch (err) {
    errorEl.textContent = err.message || t('save_error');
    errorEl.classList.remove('hidden');
  }
});

// Revelar claves
$('#btn-reveal-secret').addEventListener('click', function() {
  $('#reveal-password-field').classList.remove('hidden');
  $('#btn-reveal-secret').classList.add('hidden');
  $('#reveal-password').focus();
});

$('#btn-cancel-reveal').addEventListener('click', function() {
  $('#reveal-password-field').classList.add('hidden');
  $('#btn-reveal-secret').classList.remove('hidden');
  $('#reveal-password').value = '';
});

$('#btn-confirm-reveal').addEventListener('click', async function() {
  var password = $('#reveal-password').value;
  var container = $('#revealed-secret-container');
  container.classList.add('hidden');
  container.innerHTML = '';

  if (!password) {
    alert(t('enter_password'));
    return;
  }

  try {
    var decrypted = await window.api.decryptWallet(selectedWalletId, password);
    container.classList.remove('hidden');

    var wallets = await window.api.listWallets();
    var w = wallets.find(function(x) { return x.id === selectedWalletId; });

    if (w.type !== 'mnemonic') {
      container.innerHTML =
        '<div class="secret-box">' +
          '<div class="lbl">' + t('your_secret') + '</div>' +
          '<div class="row">' +
            '<span class="secret">' + escapeHtml(decrypted) + '</span>' +
            '<button class="copy" id="copy-revealed">' + t('copy') + '</button>' +
          '</div>' +
        '</div>';
    } else {
      var gridHtml = decrypted.split(' ').map(function(word, i) {
        return '<div class="word"><span class="num">' + (i + 1) + '</span>' + escapeHtml(word) + '</div>';
      }).join('');
      container.innerHTML =
        '<div class="warning">' + t('warning_write_down') + '</div>' +
        '<div class="mnemonic-grid">' + gridHtml + '</div>';
    }

    var copyBtn = container.querySelector('.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function(e) {
        await navigator.clipboard.writeText(decrypted);
        e.target.textContent = t('copied');
        setTimeout(function() { e.target.textContent = t('copy'); }, 1200);
      });
    }

    $('#reveal-password-field').classList.add('hidden');
  } catch (err) {
    alert(err.message || t('decrypt_error'));
  }
});

// Eliminar wallet
$('#btn-delete-wallet').addEventListener('click', async function() {
  if (!confirm(t('delete_confirm'))) return;
  await window.api.deleteWallet(selectedWalletId);
  goTo('welcome');
});

// =========================== HISTORIAL ===========================
$('#btn-go-history').addEventListener('click', async function() {
  goTo('history');

  var wallets = await window.api.listWallets();
  var w = wallets.find(function(x) { return x.id === selectedWalletId; });
  if (!w) return;

  $('#history-wallet-name').textContent = w.name;
  var container = $('#history-container');
  container.innerHTML = '<div class="loading">' + t('loading_history') + '</div>';

  try {
    var history = await window.api.getHistory(w.id);
    container.innerHTML = '';

    if (history.length === 0) {
      container.innerHTML = '<div class="hint" style="text-align: center; padding: 2rem;">' + t('no_transactions') + '</div>';
      return;
    }

    history.forEach(function(tx) {
      var isPositive = tx.netSats > 0;
      var bch = (Math.abs(tx.netSats) / 1e8).toFixed(8).replace(/\.?0+$/, '');
      var sign = isPositive ? '+' : '-';
      var color = isPositive ? 'var(--bch)' : 'var(--warn-text)';
      var bg = isPositive ? 'rgba(10,193,142,0.1)' : 'rgba(255,107,107,0.1)';

      var date = new Date(tx.time * 1000).toLocaleString();
      var statusText = tx.height <= 0 ? ' ' + t('unconfirmed_label') : '';
      var fiat = fmtFiat(Math.abs(tx.netSats)) || currentFiatPlaceholder();
      ensurePriceLoaded({ silent: true }).then(updateAllFiatDisplays);

      var div = document.createElement('div');
      div.style.background = 'var(--panel)';
      div.style.border = '1px solid var(--border)';
      div.style.borderRadius = '10px';
      div.style.padding = '14px';
      div.style.marginBottom = '10px';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';

      div.innerHTML =
        '<div style="flex: 1; overflow: hidden; margin-right: 15px;">' +
          '<div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">' +
            (isPositive ? t('received') : t('sent')) +
            ' <span style="color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 6px;">' + date + statusText + '</span>' +
          '</div>' +
          '<div style="font-family: monospace; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + tx.txid + '">' +
            '<a href="https://blockchair.com/bitcoin-cash/transaction/' + tx.txid + '" target="_blank" style="color: var(--muted); text-decoration: none;">' + tx.txid + '</a>' +
          '</div>' +
        '</div>' +
        '<div style="text-align: right;">' +
          '<div style="background: ' + bg + '; color: ' + color + '; padding: 6px 12px; border-radius: 8px; font-weight: bold; font-family: monospace; font-size: 15px; white-space: nowrap;">' +
            sign + bch + ' BCH' +
          '</div>' +
          '<div class="fiat-sub" data-sats="' + Math.abs(tx.netSats) + '" style="text-align: right; margin-top: 4px;">' + escapeHtml(fiat) + '</div>' +
        '</div>';
      container.appendChild(div);
    });

  } catch (err) {
    container.innerHTML = '<div class="error">' + t('history_error', { error: escapeHtml(err.message) }) + '</div>';
  }
});

// =========================== ENVIAR BCH ===========================
$('#btn-go-send').addEventListener('click', function() {
  $('#send-address').value = '';
  $('#send-amount').value = '';
  $('#send-password').value = '';
  $('#send-error').classList.add('hidden');
  $('#send-status').classList.add('hidden');
  $('#send-result').classList.add('hidden');

  var nameEl = $('#details-wallet-name').textContent;
  $('#send-wallet-name').textContent = nameEl;

  var bchStr = (currentWalletBalanceSats / 1e8).toFixed(8).replace(/\.?0+$/, '');
  $('#send-wallet-balance').textContent = bchStr;
  var sendFiatEl = $('#send-balance-fiat');
  sendFiatEl.dataset.sats = currentWalletBalanceSats;
  sendFiatEl.textContent = fmtFiat(currentWalletBalanceSats) || currentFiatPlaceholder();
  ensurePriceLoaded({ silent: true }).then(updateAllFiatDisplays);
  $('#send-satoshis').textContent = '0 ' + t('satoshis');

  goTo('send');
});

$('#send-amount').addEventListener('input', function(e) {
  var val = e.target.value.replace(/[^0-9.,]/g, '');
  val = val.replace(',', '.');

  var parts = val.split('.');
  if (parts.length > 2) {
    val = parts[0] + '.' + parts.slice(1).join('');
  }

  if (val !== e.target.value) {
    e.target.value = val;
  }

  var bch = parseFloat(val) || 0;
  var sats = Math.floor(bch * 1e8);
  $('#send-satoshis').textContent = new Intl.NumberFormat('es-AR').format(sats) + ' ' + t('satoshis');
});

$('#btn-send-max').addEventListener('click', async function(e) {
  e.preventDefault();
  var btn = e.currentTarget;
  var originalText = btn.textContent;
  btn.textContent = '…';
  try {
    var est = await window.api.estimateMaxSend(selectedWalletId);
    var maxSats = est.maxSats || 0;
    var maxBch = (maxSats / 1e8).toFixed(8);
    $('#send-amount').value = maxBch;
    $('#send-satoshis').textContent = new Intl.NumberFormat('es-AR').format(maxSats) + ' ' + t('satoshis');
  } catch (err) {
    var estimatedFeeSats = 2000;
    var maxSats = Math.max(0, currentWalletBalanceSats - estimatedFeeSats);
    var maxBch = (maxSats / 1e8).toFixed(8);
    $('#send-amount').value = maxBch;
    $('#send-satoshis').textContent = new Intl.NumberFormat('es-AR').format(maxSats) + ' ' + t('satoshis');
  } finally {
    btn.textContent = originalText;
  }
});

$('#btn-confirm-send').addEventListener('click', async function() {
  var address = $('#send-address').value.trim();
  var amount = $('#send-amount').value;
  var password = $('#send-password').value;

  var errEl = $('#send-error');
  var statEl = $('#send-status');
  var resEl = $('#send-result');

  errEl.classList.add('hidden');
  resEl.classList.add('hidden');
  statEl.classList.remove('hidden');
  statEl.textContent = t('building_tx');

  if (!address || !amount || !password) {
    statEl.classList.add('hidden');
    errEl.textContent = t('fill_all_fields');
    errEl.classList.remove('hidden');
    return;
  }

  try {
    var txid = await window.api.sendBch(selectedWalletId, password, address, amount);
    statEl.classList.add('hidden');
    resEl.innerHTML =
      '<div class="ok" style="color: #4CAF50; font-weight: bold;">' + t('tx_success') + '</div>' +
      '<div class="hash" style="margin-top: 10px;">TXID:<br> <a href="https://blockchair.com/bitcoin-cash/transaction/' + txid + '" target="_blank" style="color: #4CAF50; word-break: break-all;">' + txid + '</a></div>' +
      '<button class="btn" id="btn-back-after-send" style="margin-top: 1rem">' + t('back_to_home') + '</button>';
    resEl.classList.remove('hidden');
    document.getElementById('btn-back-after-send').addEventListener('click', function() { goTo('welcome'); });
  } catch (err) {
    statEl.classList.add('hidden');
    errEl.textContent = err.message || t('send_error');
    errEl.classList.remove('hidden');
  }
});

// Cargar billeteras guardadas al iniciar la app
loadSavedWallets();

// Añadir botón de mostrar/ocultar a todos los campos de contraseña
document.querySelectorAll('input[type="password"]').forEach(function(input) {
  var wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';

  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  var toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = t('show_password');
  toggleBtn.style.position = 'absolute';
  toggleBtn.style.right = '10px';
  toggleBtn.style.background = 'none';
  toggleBtn.style.border = 'none';
  toggleBtn.style.color = 'var(--bch)';
  toggleBtn.style.cursor = 'pointer';
  toggleBtn.style.fontSize = '12px';
  toggleBtn.style.fontWeight = 'bold';

  input.style.paddingRight = '60px';

  toggleBtn.addEventListener('click', function() {
    if (input.type === 'password') {
      input.type = 'text';
      toggleBtn.textContent = t('hide_password');
    } else {
      input.type = 'password';
      toggleBtn.textContent = t('show_password');
    }
  });

  wrapper.appendChild(toggleBtn);
});

// =========================== TOR ===========================
var torStatusText = $('#tor-status-text');
var torLabel = $('#tor-status-label');
var newCircuitBtn = $('#btn-new-circuit');

function setTorStartingUI(message) {
  torState = 'starting';
  torStatusText.textContent = t('starting_tor');
  torLabel.title = message || t('starting_tor');
  torStatusText.style.color = 'var(--warn-text)';
  torLabel.style.borderColor = 'var(--border)';
  newCircuitBtn.disabled = true;
  renderPriceStatus();
  updateAllFiatDisplays();
}

function setTorConnectedUI() {
  torState = 'ready';
  torStatusText.textContent = t('tor_connected');
  torLabel.title = '';
  torStatusText.style.color = 'var(--bch)';
  torLabel.style.borderColor = 'var(--bch)';
  newCircuitBtn.disabled = false;
  renderPriceStatus();
  updateAllFiatDisplays();
}

newCircuitBtn.addEventListener('click', async function() {
  newCircuitBtn.disabled = true;
  newCircuitBtn.textContent = t('rotating');
  try {
    await window.api.torNewCircuit();
    newCircuitBtn.textContent = t('circuit_done');
    setTimeout(function() { newCircuitBtn.textContent = t('new_circuit'); }, 2000);
    refreshPrice({ silent: false, force: true });
  } catch (err) {
    alert(t('circuit_error') + err.message);
    newCircuitBtn.textContent = t('new_circuit');
  }
  newCircuitBtn.disabled = false;
});

window.api.onTorProgress(function(msg) {
  if (msg) {
    if (looksLikeTorReadyMessage(msg)) {
      setTorConnectedUI();
      refreshPriceIfTorReady({ silent: false });
    } else {
      torStatusText.textContent = t('starting_tor');
      torLabel.title = msg;
      torState = 'starting';
      renderPriceStatus();
      updateAllFiatDisplays();
    }
  }
});

// Tor auto-start — always on
window.api.torStatus().then(async function(status) {
  if (status.enabled && status.ready) {
    setTorConnectedUI();
    refreshPriceIfTorReady({ silent: false });
    return;
  }

  setTorStartingUI(t('starting'));
  try {
    await window.api.enableTor();
    setTorConnectedUI();
    refreshPriceIfTorReady({ silent: false, force: true });
  } catch (err) {
    torStatusText.textContent = t('tor_start_error') + err.message;
    torStatusText.style.color = '#ff6b6b';
    console.error('Tor start failed:', err);
  }
});
