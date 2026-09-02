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
  if (!vaultAbierto) pintarCandado();
  if (torState === 'ready') {
    setTorConnectedUI();
  } else if (torState === 'disabled') {
    setTorDisconnectedUI();
  } else {
    setTorStartingUI();
  }
  renderPriceStatus();
  updateAllFiatDisplays();
  if (vaultAbierto) renderColumnas();
  ['save-create', 'save-import'].forEach(function(prefijo) {
    var select = $('#' + prefijo + '-group');
    pintarSelectorDeGrupo(select, select.value);
  });
});

currencySelect.addEventListener('change', function() {
  setCurrency(currencySelect.value);
  updateAllFiatDisplays();
  renderPriceStatus();
  // Sin cotizacion cargada getDisplayedPriceCode() devuelve la moneda elegida,
  // asi que comparar sola no alcanza: hay que pedir precio igual. Y va forzado
  // porque el cache del main puede ser justo el payload al que le falta.
  var faltaLaMoneda = !fmtPricePerBch() || isUsingFallbackPrice() || getDisplayedPriceCode() !== getCurrency();
  if (faltaLaMoneda) refreshPriceIfTorReady({ silent: false, force: true });
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
  loadSavedWallets({ refrescar: true });
});

applyTranslations();
renderPriceStatus();
refreshPriceIfTorReady({ silent: true });

// La cotizacion cacheada vence a los 5 min y nada la renovaba: la barra se
// quedaba en "no disponible" hasta que el usuario tocara refrescar. Va forzado
// porque un fetch sin force devuelve el payload viejo, con su updatedAt viejo,
// y vence igual.
var PRICE_AUTO_REFRESH_MS = 4 * 60 * 1000;
setInterval(function() {
  if (torState !== 'ready') return;
  refreshPriceIfTorReady({ silent: true, force: true });
}, PRICE_AUTO_REFRESH_MS);

// Con la ventana en segundo plano Electron frena los timers: al volver, si la
// cotizacion vencio mientras tanto, se pide de nuevo.
window.addEventListener('focus', function() {
  if (torState !== 'ready' || fmtPricePerBch()) return;
  refreshPriceIfTorReady({ silent: true, force: true });
});

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
    $('#save-create-error').classList.add('hidden');
    pintarSelectorDeGrupo($('#save-create-group'), null);
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
    $('#save-import-error').classList.add('hidden');
    pintarSelectorDeGrupo($('#save-import-group'), null);
  }
}
$$('[data-go]').forEach(function(el) { el.addEventListener('click', function() { goTo(el.dataset.go); }); });

// --- Utilidades de UI ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

// Un error que vuelve del proceso principal llega envuelto por Electron:
// "Error invoking remote method 'x': Error: lo que importa". Al usuario le
// sirve el final, no la plomeria del puente IPC.
function mensajeDeError(err) {
  var texto = (err && err.message) ? String(err.message) : String(err || '');
  var corte = texto.lastIndexOf('Error: ');
  return corte === -1 ? texto : texto.slice(corte + 'Error: '.length);
}

// Enter dentro del campo dispara el boton que confirma ese paso.
function submitOnEnter(input, button) {
  input.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    button.click();
  });
}

// Un txid legitimo son 64 caracteres hex. Lo que venga del servidor Electrum
// que no cumpla eso no se muestra como enlace ni se concatena en HTML.
function isTxid(s) {
  return /^[0-9a-fA-F]{64}$/.test(String(s || ''));
}

// Enlace al explorador. Si el txid que mando el servidor no tiene forma de
// txid, se muestra como texto plano y NO como enlace: asi un servidor hostil
// no puede fabricar un href arbitrario que termine abriendose en el navegador.
function txidLink(txid) {
  if (!isTxid(txid)) {
    return '<span style="word-break: break-all;">' + escapeHtml(String(txid || '')) + '</span>';
  }
  return '<a href="https://blockchair.com/bitcoin-cash/transaction/' + encodeURIComponent(txid) +
    '" style="color: var(--muted); text-decoration: none;">' + escapeHtml(txid) + '</a>';
}

// =========================== MODAL ===========================
// Reemplaza alert()/confirm() nativos: mismo estilo que el resto de la app.

var _modalResolve = null;

function closeModal(result) {
  $('#modal-backdrop').classList.add('hidden');
  var r = _modalResolve;
  _modalResolve = null;
  if (r) r(result);
}

// bodyHtml ya debe venir escapado por el llamador.
function openModal(opts) {
  return new Promise(function(resolve) {
    _modalResolve = resolve;
    $('#modal-title').textContent = opts.title || '';
    $('#modal-body').innerHTML = opts.bodyHtml || escapeHtml(opts.body || '');

    var okBtn = $('#modal-ok');
    var cancelBtn = $('#modal-cancel');

    okBtn.textContent = opts.confirmText || t('modal_accept');
    okBtn.className = 'btn ' + (opts.danger ? 'primary' : 'primary');

    if (opts.cancelText) {
      cancelBtn.textContent = opts.cancelText;
      cancelBtn.classList.remove('hidden');
    } else {
      cancelBtn.classList.add('hidden');
    }

    $('#modal-backdrop').classList.remove('hidden');
    okBtn.focus();
  });
}

// Valida la contrasena maestra al crearla. Devuelve un mensaje de error, o
// null si esta bien.
//
// La confirmacion importa tanto como la longitud: sin ella, un error de tipeo
// al crear el vault lo deja inaccesible para siempre y no hay forma de saberlo
// hasta que ya es tarde.
var PASSWORD_MIN = 8;

function validarPassword(password, confirmacion) {
  if (!password) return t('password_required');
  if (password.length < PASSWORD_MIN) return t('password_too_short');
  if (password !== confirmacion) return t('password_mismatch');
  return null;
}

function showAlert(message, title) {
  return openModal({ title: title || t('modal_notice'), body: message });
}

function showConfirm(opts) {
  return openModal({
    title: opts.title,
    bodyHtml: opts.bodyHtml,
    body: opts.body,
    confirmText: opts.confirmText,
    cancelText: opts.cancelText || t('modal_cancel'),
    danger: opts.danger,
  });
}

$('#modal-ok').addEventListener('click', function() { closeModal(true); });
$('#modal-cancel').addEventListener('click', function() { closeModal(false); });
$('#modal-backdrop').addEventListener('click', function(e) {
  if (e.target === this && !$('#modal-cancel').classList.contains('hidden')) closeModal(false);
});
document.addEventListener('keydown', function(e) {
  if (_modalResolve === null) return;
  if (e.key === 'Escape' && !$('#modal-cancel').classList.contains('hidden')) closeModal(false);
  if (e.key === 'Enter') closeModal(true);
});

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

  abrirCajaDeGuardado('save-create');
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

      abrirCajaDeGuardado('save-import');
      return;
    }

    if (type === 'hex' && importHexType === 'hex_hd') {
      var r = await window.api.hexHdReport(val, 5);
      out.innerHTML = '';
      out.appendChild(balanceHead(r.total.confirmed, r.total.unconfirmed));
      appendIncompleteWarnings(out, r);
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

      abrirCajaDeGuardado('save-import');
      return;
    }

    // mnemonic
    var r = await window.api.mnemonicReport(val, 5);
    out.innerHTML = '';
    out.appendChild(balanceHead(r.total.confirmed, r.total.unconfirmed));
    appendIncompleteWarnings(out, r);
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

    abrirCajaDeGuardado('save-import');
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

// Distintivo SPV de una transaccion.
//
// Solo el verde afirma algo: que la transaccion esta en un bloque con
// proof-of-work verificado. El resto de los estados NO son acusaciones — una tx
// anterior al checkpoint o todavia en el mempool no es sospechosa, simplemente
// cae fuera de lo que la wallet puede demostrar por si misma. Decirle "no
// verificada" a secas al usuario seria mentirle por omision.
function spvBadge(verification) {
  if (!verification) return '';

  var estilos = {
    ok:       { bg: 'rgba(10,193,142,0.15)',  color: 'var(--bch)',        texto: t('spv_verified') },
    pendiente:{ bg: 'rgba(255,255,255,0.06)', color: 'var(--muted)',      texto: t('spv_pending') },
    fuera:    { bg: 'rgba(255,255,255,0.06)', color: 'var(--muted)',      texto: t('spv_out_of_range') },
    esperando:{ bg: 'rgba(255,255,255,0.06)', color: 'var(--muted)',      texto: t('spv_waiting_header') },
    alerta:   { bg: 'rgba(255,107,107,0.15)', color: 'var(--warn-text)',  texto: t('spv_failed') },
  };

  var clave;
  if (verification.verified) clave = 'ok';
  else if (verification.reason === 'sin-confirmar') clave = 'pendiente';
  else if (verification.reason === 'fuera-de-rango') clave = 'fuera';
  // Un bloque MAS NUEVO que lo sincronizado no es historico: es lo contrario.
  // Se resuelve solo cuando la cadena de cabeceras alcanza esa altura.
  else if (verification.reason === 'sin-cabecera') clave = 'esperando';
  else if (verification.reason === 'sin-prueba') clave = 'pendiente';
  else clave = 'alerta';

  var e = estilos[clave];
  return '<span style="background: ' + e.bg + '; color: ' + e.color + '; font-size: 10px; ' +
    'font-weight: 600; padding: 2px 7px; border-radius: 6px; margin-left: 8px; white-space: nowrap;" ' +
    'title="' + escapeHtml(verification.detail || '') + '">' + e.texto + '</span>';
}

// Estado de la cadena de cabeceras, arriba del historial.
//
// Se muestra siempre, tambien cuando esta todo bien: el usuario tiene que poder
// ver de un vistazo hasta donde llega lo que la wallet puede demostrar sola.
function buildChainNote(estadoCadena) {
  var el = document.createElement('div');
  el.className = 'chain-note';

  if (estadoCadena.fase === 'listo' && estadoCadena.tipHeight > 0) {
    el.classList.add('chain-note-ok');
    el.textContent = t('chain_ready', { height: estadoCadena.tipHeight });
  } else if (estadoCadena.fase === 'error') {
    el.classList.add('chain-note-warn');
    el.textContent = t('chain_error', { error: estadoCadena.error || '' });
  } else {
    var pct = estadoCadena.total > 0
      ? Math.min(99, Math.floor((estadoCadena.bajadas / estadoCadena.total) * 100))
      : 0;
    el.textContent = t('chain_syncing', { pct: pct });
  }
  return el;
}

// Aviso de que el dato mostrado no paso el cruce entre operadores.
// Va con el detalle textual, no con un icono a secas: si la wallet dice
// "cuidado" tiene que decir tambien que vio y quien discrepa.
function buildVerificationWarning(verification) {
  return buildWarning(t('verify_unverified_title'), verification.detail || '');
}

// Aviso de dato incompleto. Distinto del de arriba: alla los servidores
// contestaron y no coincidieron; aca directamente no contestaron, y lo que se
// muestra es lo que se pudo juntar. Sin este cartel, un saldo al que le faltan
// direcciones se lee igual que uno completo.
function buildWarning(titulo, detalle) {
  var el = document.createElement('div');
  el.className = 'verify-warning';
  var head = document.createElement('strong');
  head.textContent = titulo;
  var body = document.createElement('div');
  body.className = 'verify-warning-detail';
  body.textContent = detalle;
  el.appendChild(head);
  el.appendChild(body);
  return el;
}

// Cuelga los avisos de "esto que ves puede no ser todo" en cualquier pantalla
// que muestre un saldo. Va en un solo lugar porque la regla es la misma en las
// tres: un total al que le faltan direcciones se lee igual que uno completo si
// nadie lo dice.
function appendIncompleteWarnings(container, r) {
  if (r.failures > 0) {
    container.appendChild(buildWarning(
      t('incomplete_balance_title'),
      t('incomplete_balance_detail', { failures: r.failures, total: r.addressesQueried })
    ));
  }
  if (r.discoveryFailures > 0 || r.discoveryIncomplete) {
    container.appendChild(buildWarning(
      t('incomplete_balance_title'), t('incomplete_balance_scan')
    ));
  }
}

// =========================== PERSISTENCIA Y DETALLES ===========================
var currentImportedSecret = '';
var currentImportedType = '';
var currentImportedAddress = '';
var selectedWalletId = '';
// Si la lista completa de direcciones esta desplegada. Sobrevive al repintado
// del detalle: pedir una direccion nueva no tiene por que cerrarla en la cara.
var listaDireccionesAbierta = false;
var currentWalletBalanceSats = 0;
// Parte del saldo que todavia esta en el mempool. Se puede gastar —BCH no
// tiene RBF—, pero la pantalla de envio lo dice en vez de disimularlo.
var currentWalletUnconfirmedSats = 0;
// Mientras el vault siga cerrado no hay billeteras que listar: el proceso
// principal rechaza igual, pero pedirselo llenaria la pantalla de errores.
var vaultAbierto = false;
var vaultEsNuevo = false;

// =========================== GRUPOS Y BILLETERAS ===========================
//
// La pantalla de inicio tiene dos columnas que se turnan en el mismo lugar: la
// de grupos y, al entrar a uno, la de sus billeteras.
//
// Los saldos se piden una sola vez y quedan en memoria. Sin eso, cada ida y
// vuelta entre columnas volveria a consultar todas las direcciones por Tor, y
// los totales por grupo obligan a tener el saldo de TODAS las billeteras, no
// solo el de las que estan a la vista.

// No es un grupo de verdad: es donde caen las billeteras que no estan en
// ninguno. No se puede renombrar ni borrar, y desaparece cuando queda vacio.
var SIN_GRUPO = '__sin_grupo__';

var gruposCache = [];
var walletsCache = [];
// id de billetera -> { sats, incompleta, sinVerificar } | { error } | { cargando }
var saldos = {};
var grupoAbiertoId = null; // null = se ve la columna de grupos

function grupoRealAbierto() {
  return grupoAbiertoId && grupoAbiertoId !== SIN_GRUPO ? grupoAbiertoId : null;
}

function nombreDeGrupo(id) {
  if (id === SIN_GRUPO) return t('ungrouped');
  var grupo = gruposCache.find(function(g) { return g.id === id; });
  return grupo ? grupo.name : '';
}

function agruparWallets() {
  var porGrupo = {};
  gruposCache.forEach(function(g) { porGrupo[g.id] = []; });
  var sueltas = [];
  walletsCache.forEach(function(w) {
    if (w.groupId && porGrupo[w.groupId]) porGrupo[w.groupId].push(w);
    else sueltas.push(w);
  });
  return { porGrupo: porGrupo, sueltas: sueltas };
}

function walletsDelGrupo(id) {
  var repartidas = agruparWallets();
  return id === SIN_GRUPO ? repartidas.sueltas : (repartidas.porGrupo[id] || []);
}

// Suma lo que se sabe y cuenta lo que falta, las dos cosas juntas: un total al
// que le faltan billeteras se lee igual que uno completo si nadie lo dice.
function sumarSaldos(lista) {
  var resumen = {
    sats: 0, conSaldo: 0, cargando: 0, fallaron: 0,
    incompletas: 0, sinVerificar: 0, total: lista.length,
  };
  lista.forEach(function(w) {
    var saldo = saldos[w.id];
    if (!saldo || saldo.cargando) { resumen.cargando++; return; }
    if (saldo.error) { resumen.fallaron++; return; }
    resumen.sats += saldo.sats;
    resumen.conSaldo++;
    if (saldo.incompleta) resumen.incompletas++;
    if (saldo.sinVerificar) resumen.sinVerificar++;
  });
  return resumen;
}

// El aviso que acompaña a un total. Las razones por las que un total puede no
// ser el total se dicen todas juntas, porque se pueden dar juntas.
function pintarNotaDelTotal(el, resumen) {
  if (!el) return;
  var partes = [];
  if (resumen.fallaron > 0) {
    partes.push(t('total_failed', { failures: resumen.fallaron, total: resumen.total }));
  }
  if (resumen.incompletas > 0) partes.push(t('total_incomplete', { count: resumen.incompletas }));
  if (resumen.sinVerificar > 0) partes.push(t('total_unverified', { count: resumen.sinVerificar }));
  if (resumen.cargando > 0) {
    partes.push(torState === 'ready'
      ? t('total_loading', { count: resumen.cargando })
      : t('price_establishing_network'));
  }

  var grave = resumen.fallaron > 0 || resumen.incompletas > 0 || resumen.sinVerificar > 0;
  el.textContent = partes.join(' · ');
  el.className = 'total-note' + (partes.length === 0 ? ' hidden' : (grave ? ' warn' : ' muted'));
}

// Un grupo del que todavia no se sabe ningun saldo NO vale cero: vale "no se".
// Mostrar "0 BCH" mientras las consultas viajan por Tor se lee como "no tenes
// plata", que es la lectura mas cara posible de un dato que todavia no llego.
function pintarMonto(idMonto, idSats, idFiat, resumen) {
  var seSabeAlgo = resumen.total === 0 || resumen.conSaldo > 0;
  var montoEl = document.getElementById(idMonto);
  if (montoEl) montoEl.textContent = seSabeAlgo ? fmtBch(resumen.sats) : t('loading_bch');
  var satsEl = idSats ? document.getElementById(idSats) : null;
  if (satsEl) satsEl.textContent = seSabeAlgo ? fmtSats(resumen.sats) : '';
  var fiatEl = idFiat ? document.getElementById(idFiat) : null;
  if (fiatEl) {
    if (seSabeAlgo) {
      fiatEl.dataset.sats = resumen.sats;
      fiatEl.textContent = fmtFiat(resumen.sats) || currentFiatPlaceholder();
    } else {
      delete fiatEl.dataset.sats;
      fiatEl.textContent = '';
    }
  }
}

function pintarTotales() {
  var global = sumarSaldos(walletsCache);
  pintarMonto('grand-total-amount', 'grand-total-sats', 'grand-total-fiat', global);
  pintarNotaDelTotal($('#grand-total-note'), global);

  if (grupoAbiertoId) {
    var delGrupo = sumarSaldos(walletsDelGrupo(grupoAbiertoId));
    pintarMonto('group-head-amount', null, 'group-head-fiat', delGrupo);
    pintarNotaDelTotal($('#group-head-note'), delGrupo);
  } else {
    var repartidas = agruparWallets();
    gruposCache.forEach(function(g) {
      pintarTotalDeTarjeta(g.id, sumarSaldos(repartidas.porGrupo[g.id] || []));
    });
    if (repartidas.sueltas.length > 0) {
      pintarTotalDeTarjeta(SIN_GRUPO, sumarSaldos(repartidas.sueltas));
    }
  }
  ensurePriceLoaded({ silent: true }).then(updateAllFiatDisplays);
}

function pintarTotalDeTarjeta(clave, resumen) {
  pintarMonto('gbal-' + clave, 'gsats-' + clave, 'gfiat-' + clave, resumen);
  pintarNotaDelTotal(document.getElementById('gnote-' + clave), resumen);
}

function pintarSaldoDeWallet(id) {
  var balEl = document.getElementById('bal-' + id);
  if (!balEl) return;
  var satsEl = document.getElementById('sats-' + id);
  var fiatEl = document.getElementById('fiat-' + id);
  var saldo = saldos[id];

  if (!saldo || saldo.cargando || saldo.error) {
    // Sin Tor listo no se consulto nada: decir "estableciendo la red" y no
    // "Error", que es lo que parece cuando la fila se queda en blanco.
    balEl.textContent = saldo && saldo.error
      ? t('error_text')
      : (torState === 'ready' ? t('loading_bch') : t('price_establishing_network'));
    if (satsEl) satsEl.textContent = '';
    if (fiatEl) {
      fiatEl.textContent = '';
      delete fiatEl.dataset.sats;
    }
    return;
  }

  balEl.textContent = fmtBch(saldo.sats);
  if (satsEl) satsEl.textContent = fmtSats(saldo.sats);
  if (fiatEl) {
    fiatEl.dataset.sats = saldo.sats;
    fiatEl.textContent = fmtFiat(saldo.sats) || currentFiatPlaceholder();
  }
}

// Pide solo lo que falta. La lista va en modo rapido: sin consultas de
// descubrimiento. El costo de esta pantalla se multiplica por la cantidad de
// billeteras guardadas, y el barrido completo de cada una hacia que abrir la
// app disparara miles de consultas de golpe por Tor. El detalle si barre todo.
function pedirSaldosFaltantes() {
  if (torState !== 'ready') return;
  walletsCache.forEach(function(w) {
    if (saldos[w.id]) return;
    saldos[w.id] = { cargando: true };

    var pedido = isHdWalletType(w.type)
      ? window.api.getHdBalance(w.id, { rapido: true })
      : window.api.getBalance(w.address);

    pedido.then(function(b) {
      saldos[w.id] = {
        sats: (b.confirmed || 0) + (b.unconfirmed || 0),
        incompleta: b.failures > 0 || b.discoveryFailures > 0 || !!b.discoveryIncomplete,
        sinVerificar: !!(b.verification && !b.verification.verified),
      };
    }).catch(function() {
      saldos[w.id] = { error: true };
    }).then(function() {
      // La billetera pudo borrarse mientras la consulta iba por Tor.
      if (!walletsCache.some(function(x) { return x.id === w.id; })) {
        delete saldos[w.id];
        return;
      }
      pintarSaldoDeWallet(w.id);
      pintarTotales();
    });
  });
}

function walletItem(w) {
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
  return item;
}

function renderGroupsView() {
  var lista = $('#groups-list');
  lista.innerHTML = '';
  var repartidas = agruparWallets();

  var tarjetas = gruposCache.map(function(g) {
    return { clave: g.id, nombre: g.name, wallets: repartidas.porGrupo[g.id] || [] };
  });
  if (repartidas.sueltas.length > 0) {
    tarjetas.push({ clave: SIN_GRUPO, nombre: t('ungrouped'), wallets: repartidas.sueltas });
  }

  tarjetas.forEach(function(tarjeta) {
    var cuenta = t(tarjeta.wallets.length === 1 ? 'group_wallet_one' : 'group_wallet_many',
      { count: tarjeta.wallets.length });
    var item = document.createElement('div');
    item.className = 'group-item' + (tarjeta.clave === SIN_GRUPO ? ' group-item-loose' : '');
    item.innerHTML =
      '<div class="group-item-info">' +
        '<span class="group-item-name">' + escapeHtml(tarjeta.nombre) + '</span>' +
        '<span class="group-item-count">' + escapeHtml(cuenta) + '</span>' +
      '</div>' +
      '<div class="group-item-balance-col">' +
        '<div class="group-item-balance" id="gbal-' + tarjeta.clave + '"></div>' +
        '<div class="group-item-sats" id="gsats-' + tarjeta.clave + '"></div>' +
        '<div class="group-item-fiat" id="gfiat-' + tarjeta.clave + '"></div>' +
        '<div class="total-note hidden" id="gnote-' + tarjeta.clave + '"></div>' +
      '</div>' +
      '<span class="group-item-chevron">&rsaquo;</span>';
    item.addEventListener('click', function() { abrirGrupo(tarjeta.clave); });
    lista.appendChild(item);
  });
}

function renderWalletsView() {
  $('#group-head-name').textContent = nombreDeGrupo(grupoAbiertoId);
  // "Sin grupo" no es una carpeta: no hay nada que renombrar ni que borrar.
  $('#group-head-actions').classList.toggle('hidden', !grupoRealAbierto());

  var lista = $('#saved-wallets-list');
  lista.innerHTML = '';
  var delGrupo = walletsDelGrupo(grupoAbiertoId);

  if (delGrupo.length === 0) {
    lista.innerHTML = '<div class="empty-note">' + escapeHtml(t('group_empty')) + '</div>';
    return;
  }

  delGrupo.forEach(function(w) {
    lista.appendChild(walletItem(w));
    pintarSaldoDeWallet(w.id);
  });
}

function renderColumnas() {
  var enGrupo = grupoAbiertoId !== null;
  $('#groups-view').classList.toggle('hidden', enGrupo);
  $('#wallets-view').classList.toggle('hidden', !enGrupo);
  if (enGrupo) renderWalletsView();
  else renderGroupsView();
  pintarTotales();
}

function abrirGrupo(clave) {
  grupoAbiertoId = clave;
  renderColumnas();
}

async function loadSavedWallets(opciones) {
  if (!vaultAbierto) return;
  opciones = opciones || {};

  var datos = await Promise.all([window.api.listWallets(), window.api.listGroups()]);
  walletsCache = datos[0];
  gruposCache = datos[1];

  // Los saldos sobreviven a la navegacion, pero no a las billeteras borradas:
  // sumar el saldo de una que ya no esta inflaria el total.
  var vigentes = {};
  if (!opciones.refrescar) {
    walletsCache.forEach(function(w) {
      if (saldos[w.id]) vigentes[w.id] = saldos[w.id];
    });
  }
  saldos = vigentes;

  // El grupo que se estaba mirando pudo borrarse, o quedarse sin billeteras si
  // era el de las sueltas. En los dos casos ya no hay nada que mostrar adentro.
  if (grupoRealAbierto() && !gruposCache.some(function(g) { return g.id === grupoAbiertoId; })) {
    grupoAbiertoId = null;
  }
  if (grupoAbiertoId === SIN_GRUPO && walletsDelGrupo(SIN_GRUPO).length === 0) {
    grupoAbiertoId = null;
  }

  var section = $('#saved-wallets-section');
  if (walletsCache.length === 0 && gruposCache.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  renderColumnas();
  pedirSaldosFaltantes();
}

// --- Alta, renombre y borrado de grupos ---

// Nada de prompt() del navegador: el mismo modal que el resto de la app. La
// referencia al input se toma con el modal ya abierto, asi el valor se lee
// aunque el cuerpo del modal se reemplace despues.
async function pedirNombreDeGrupo(opciones) {
  var promesa = showConfirm({
    title: opciones.title,
    confirmText: opciones.confirmText,
    bodyHtml:
      '<label class="field modal-field">' +
        '<span>' + escapeHtml(t('group_name_label')) + '</span>' +
        '<input type="text" id="group-name-input" maxlength="40" autocomplete="off"' +
          ' value="' + escapeHtml(opciones.valor || '') + '"' +
          ' placeholder="' + escapeHtml(t('group_name_placeholder')) + '" />' +
      '</label>',
  });
  var input = $('#group-name-input');
  input.focus();
  input.select();
  var aceptado = await promesa;
  return aceptado ? input.value.trim() : null;
}

$('#btn-new-group').addEventListener('click', async function() {
  var nombre = await pedirNombreDeGrupo({
    title: t('new_group_title'),
    confirmText: t('create_group'),
  });
  if (!nombre) return;
  try {
    var grupo = await window.api.createGroup(nombre);
    await loadSavedWallets();
    abrirGrupo(grupo.id);
  } catch (err) {
    showAlert(mensajeDeError(err));
  }
});

$('#btn-back-to-groups').addEventListener('click', function() {
  grupoAbiertoId = null;
  renderColumnas();
});

$('#btn-rename-group').addEventListener('click', async function() {
  var id = grupoRealAbierto();
  if (!id) return;
  var nombre = await pedirNombreDeGrupo({
    title: t('rename_group_title'),
    confirmText: t('rename_group'),
    valor: nombreDeGrupo(id),
  });
  if (!nombre) return;
  try {
    await window.api.renameGroup(id, nombre);
    await loadSavedWallets();
  } catch (err) {
    showAlert(mensajeDeError(err));
  }
});

$('#btn-delete-group').addEventListener('click', async function() {
  var id = grupoRealAbierto();
  if (!id) return;
  var cuantas = walletsDelGrupo(id).length;
  // Que las billeteras NO se borran tiene que estar en el texto: es la duda
  // exacta que frena a alguien delante de un boton rojo con plata adentro.
  var confirmado = await showConfirm({
    title: t('delete_group_title'),
    body: cuantas > 0
      ? t('delete_group_confirm', { name: nombreDeGrupo(id), count: cuantas })
      : t('delete_group_confirm_empty', { name: nombreDeGrupo(id) }),
    confirmText: t('delete_group'),
    danger: true,
  });
  if (!confirmado) return;
  try {
    await window.api.deleteGroup(id);
    grupoAbiertoId = null;
    await loadSavedWallets();
  } catch (err) {
    showAlert(mensajeDeError(err));
  }
});

function pintarGrupoDeDetalles() {
  var w = walletsCache.find(function(x) { return x.id === selectedWalletId; });
  $('#details-wallet-group').textContent = w && w.groupId ? nombreDeGrupo(w.groupId) : t('ungrouped');
}

var NUEVO_GRUPO = '__nuevo__';

$('#btn-change-group').addEventListener('click', async function() {
  if (!selectedWalletId) return;
  var actual = walletsCache.find(function(w) { return w.id === selectedWalletId; });
  var actualId = (actual && actual.groupId) || '';

  var opciones = '<option value="">' + escapeHtml(t('ungrouped')) + '</option>' +
    gruposCache.map(function(g) {
      return '<option value="' + escapeHtml(g.id) + '"' + (g.id === actualId ? ' selected' : '') + '>' +
        escapeHtml(g.name) + '</option>';
    }).join('') +
    '<option value="' + NUEVO_GRUPO + '">' + escapeHtml(t('new_group_option')) + '</option>';

  var promesa = showConfirm({
    title: t('change_group_title'),
    confirmText: t('modal_accept'),
    bodyHtml:
      '<label class="field modal-field">' +
        '<span>' + escapeHtml(t('group_label_full')) + '</span>' +
        '<select id="group-picker">' + opciones + '</select>' +
      '</label>',
  });
  var picker = $('#group-picker');
  var aceptado = await promesa;
  if (!aceptado) return;

  var elegido = picker.value;
  try {
    if (elegido === NUEVO_GRUPO) {
      var nombre = await pedirNombreDeGrupo({
        title: t('new_group_title'),
        confirmText: t('create_group'),
      });
      if (!nombre) return;
      elegido = (await window.api.createGroup(nombre)).id;
    }
    await window.api.assignWalletGroup(selectedWalletId, elegido || null);
    await loadSavedWallets();
    pintarGrupoDeDetalles();
  } catch (err) {
    showAlert(mensajeDeError(err));
  }
});

// --- Grupo al guardar una billetera ---
//
// El selector arranca en el grupo que se estaba mirando en el inicio, que es
// donde caia la billetera cuando no se podia elegir. Poder crear el grupo desde
// aca evita el rodeo de guardar primero y mover despues.

function pintarSelectorDeGrupo(select, seleccionadoId) {
  var elegido = gruposCache.some(function(g) { return g.id === seleccionadoId; }) ? seleccionadoId : '';
  select.innerHTML =
    '<option value="">' + escapeHtml(t('ungrouped')) + '</option>' +
    gruposCache.map(function(g) {
      return '<option value="' + escapeHtml(g.id) + '"' + (g.id === elegido ? ' selected' : '') + '>' +
        escapeHtml(g.name) + '</option>';
    }).join('') +
    '<option value="' + NUEVO_GRUPO + '">' + escapeHtml(t('new_group_option')) + '</option>';
  select.value = elegido;
  select.dataset.previo = elegido;
}

// "Crear un grupo nuevo" no es un valor guardable: se pide el nombre en el acto
// y el selector queda apuntando al grupo recien creado. Si se cancela, vuelve a
// lo que estaba elegido antes.
async function alElegirGrupoAlGuardar(select) {
  if (select.value !== NUEVO_GRUPO) {
    select.dataset.previo = select.value;
    return;
  }
  var previo = select.dataset.previo || '';
  var nombre = await pedirNombreDeGrupo({
    title: t('new_group_title'),
    confirmText: t('create_group'),
  });
  if (!nombre) {
    select.value = previo;
    return;
  }
  try {
    var grupo = await window.api.createGroup(nombre);
    gruposCache = await window.api.listGroups();
    pintarSelectorDeGrupo(select, grupo.id);
  } catch (err) {
    select.value = previo;
    showAlert(mensajeDeError(err));
  }
}

['save-create', 'save-import'].forEach(function(prefijo) {
  var select = $('#' + prefijo + '-group');
  select.addEventListener('change', function() { alElegirGrupoAlGuardar(select); });
});

function abrirCajaDeGuardado(prefijo) {
  $('#' + prefijo + '-name').value = '';
  $('#' + prefijo + '-error').classList.add('hidden');
  pintarSelectorDeGrupo($('#' + prefijo + '-group'), grupoRealAbierto());
  $('#' + prefijo + '-section').classList.remove('hidden');
}

// Sin grupo elegido va null, que es lo que el storage entiende por "suelta".
function grupoElegidoAlGuardar(prefijo) {
  var elegido = $('#' + prefijo + '-group').value;
  return elegido && elegido !== NUEVO_GRUPO ? elegido : null;
}

async function showWalletDetails(id) {
  selectedWalletId = id;
  walletsCache = await window.api.listWallets();
  var w = walletsCache.find(function(x) { return x.id === id; });
  if (!w) return;

  goTo('wallet-details');

  $('#details-wallet-name').textContent = w.name;
  pintarGrupoDeDetalles();
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
    $('#hd-fresh-address').innerHTML = '<div class="loading">' + t('loading_addresses') + '</div>';
    $('#hd-addresses-list').innerHTML = '';
    pintarDesplegableDeDirecciones(0);
  }

  var balContainer = $('#details-balance-container');
  balContainer.innerHTML = '<div class="loading">' + t('loading_balance') + '</div>';

  $('#btn-reveal-secret').classList.remove('hidden');
  $('#revealed-secret-container').classList.add('hidden');
  $('#revealed-secret-container').innerHTML = '';

  try {
    var b;
    if (!isHdWalletType(w.type)) {
      b = await window.api.getBalance(w.address);
    } else {
      b = await window.api.getHdBalance(w.id);
      pintarDireccionesDeRecepcion(b);
    }

    currentWalletBalanceSats = (b.confirmed || 0) + (b.unconfirmed || 0);
    currentWalletUnconfirmedSats = b.unconfirmed || 0;
    // El detalle barre completo: es mejor dato que el modo rapido de la lista,
    // asi que el total de la pantalla de inicio se queda con este.
    saldos[w.id] = {
      sats: currentWalletBalanceSats,
      incompleta: b.failures > 0 || b.discoveryFailures > 0 || !!b.discoveryIncomplete,
      sinVerificar: !!(b.verification && !b.verification.verified),
    };
    balContainer.innerHTML = '';
    balContainer.appendChild(balanceHead(b.confirmed, b.unconfirmed));
    if (b.verification && !b.verification.verified) {
      balContainer.appendChild(buildVerificationWarning(b.verification));
    }
    // El saldo puede ser un piso y no un total: decirlo.
    appendIncompleteWarnings(balContainer, b);
  } catch (err) {
    currentWalletBalanceSats = 0;
    currentWalletUnconfirmedSats = 0;
    saldos[w.id] = { error: true };
    balContainer.innerHTML = '<div class="error">' + t('balance_network_error', { error: escapeHtml(err.message || String(err)) }) + '</div>';
    // Sin barrido no hay historial, y sin historial no se puede afirmar que
    // una direccion este sin estrenar. Mejor decirlo que ofrecer cualquiera.
    if (isHdWalletType(w.type)) {
      $('#hd-fresh-address').innerHTML = '<div class="warning">' + escapeHtml(t('fresh_address_none')) + '</div>';
      pintarDesplegableDeDirecciones(0);
    }
  }
}

// El detalle ofrece UNA direccion para cobrar: la que la cadena confirma sin
// estrenar. La lista completa queda plegada abajo — tenerla siempre a la vista
// invita a repetir una direccion vieja, que es justo lo que conviene no hacer.
function pintarDireccionesDeRecepcion(b) {
  var destacada = $('#hd-fresh-address');
  destacada.innerHTML = '';

  if (b.direccionSinEstrenar) {
    var caja = addressBox(t('fresh_address_label'), b.direccionSinEstrenar.address, t('fresh_address_note'));
    caja.classList.add('fresh-address');
    destacada.appendChild(caja);
  } else {
    destacada.innerHTML = '<div class="warning">' + escapeHtml(t('fresh_address_none')) + '</div>';
  }

  var lista = $('#hd-addresses-list');
  lista.innerHTML = '';
  b.receiveAddresses.forEach(function(a) {
    var detalle = b.details.find(function(d) { return d.address === a.address; });
    var saldo = detalle ? detalle.confirmed + detalle.unconfirmed : 0;

    // "Sin estrenar" es lo que dijo la cadena, no la ausencia de saldo: una
    // direccion que ya cobro y se vacio sigue siendo una direccion usada, y
    // repetirla ata entre si los pagos que la miren.
    var estado;
    if (saldo > 0) estado = 'funded';
    else if (detalle || a.historyLength > 0) estado = 'used';
    else if (a.historyLength === 0) estado = 'fresh';
    else estado = 'unknown';

    var texto = estado === 'funded'
      ? t('balance_prefix') + fmtBch(saldo)
      : t(estado === 'fresh' ? 'addr_state_fresh' : (estado === 'used' ? 'addr_state_used' : 'addr_state_unknown'));

    var fila = document.createElement('div');
    fila.className = 'addr-row ' + estado;
    fila.innerHTML = '<span class="addr-row-address">' + escapeHtml(a.address) + '</span>' +
                     '<span class="addr-row-state">' + escapeHtml(texto) + '</span>';
    lista.appendChild(fila);
  });

  pintarDesplegableDeDirecciones(b.receiveAddresses.length);
}

function pintarDesplegableDeDirecciones(cantidad) {
  var panel = $('#hd-addresses-panel');
  var boton = $('#btn-toggle-addresses');
  panel.classList.toggle('hidden', !listaDireccionesAbierta);
  boton.setAttribute('aria-expanded', listaDireccionesAbierta ? 'true' : 'false');
  $('#addr-list-toggle-text').textContent = cantidad === 0
    ? t('see_all_addresses')
    : t(listaDireccionesAbierta ? 'hide_all_addresses' : 'see_all_addresses_count', { count: cantidad });
}

$('#btn-toggle-addresses').addEventListener('click', function() {
  listaDireccionesAbierta = !listaDireccionesAbierta;
  pintarDesplegableDeDirecciones($('#hd-addresses-list').childElementCount);
});

$('#btn-generate-address').addEventListener('click', async function() {
  var wallets = await window.api.listWallets();
  var w = wallets.find(function(x) { return x.id === selectedWalletId; });
  if (!w || !isHdWalletType(w.type)) return;

  // Adelantar el puntero cuesta un rebarrido: sin esto, tres clics seguidos
  // saltean tres direcciones y muestran la de la ultima consulta que vuelva.
  var boton = this;
  boton.disabled = true;
  try {
    await window.api.incrementReceiveIndex(w.id);
    await showWalletDetails(w.id);
  } finally {
    boton.disabled = false;
  }
});

// Guardado de wallet creada
$('#btn-save-created').addEventListener('click', async function() {
  var name = $('#save-create-name').value.trim();
  var errorEl = $('#save-create-error');
  errorEl.classList.add('hidden');

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

    await window.api.saveWallet({
      name: name, address: address, type: createType, secret: secret,
      groupId: grupoElegidoAlGuardar('save-create'),
    });
    goTo('welcome');
  } catch (err) {
    errorEl.textContent = mensajeDeError(err) || t('save_error');
    errorEl.classList.remove('hidden');
  }
});

// Guardado de wallet importada
$('#btn-save-imported').addEventListener('click', async function() {
  var name = $('#save-import-name').value.trim();
  var errorEl = $('#save-import-error');
  errorEl.classList.add('hidden');

  try {
    await window.api.saveWallet({
      name: name, address: currentImportedAddress, type: currentImportedType,
      secret: currentImportedSecret, groupId: grupoElegidoAlGuardar('save-import'),
    });
    goTo('welcome');
  } catch (err) {
    errorEl.textContent = mensajeDeError(err) || t('save_error');
    errorEl.classList.remove('hidden');
  }
});

// Revelar claves. No pide contrasena: la maestra del arranque ya autorizo esta
// sesion, y volver a pedirla aca solo entrenaria al usuario a tipearla seguido.
$('#btn-reveal-secret').addEventListener('click', async function() {
  var container = $('#revealed-secret-container');
  container.classList.add('hidden');
  container.innerHTML = '';

  try {
    var decrypted = await window.api.revealWallet(selectedWalletId);
    $('#btn-reveal-secret').classList.add('hidden');
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
      var revealedWords = decrypted.trim().split(/\s+/);
      var gridHtml = revealedWords.map(function(word, i) {
        return '<div class="word"><span class="num">' + (i + 1) + '</span>' + escapeHtml(word) + '</div>';
      }).join('');
      container.innerHTML =
        '<div class="warning">' + t('warning_write_down') + '</div>' +
        '<div class="mnemonic-grid">' + gridHtml + '</div>' +
        '<div class="copy-phrase-row">' +
          '<button class="btn secondary" id="copy-revealed-mnemonic">' + t('copy_phrase') + '</button>' +
        '</div>';

      container.querySelector('#copy-revealed-mnemonic').addEventListener('click', async function(e) {
        // Solo las palabras, separadas por un espacio: en orden y sin la numeracion.
        await navigator.clipboard.writeText(revealedWords.join(' '));
        e.target.textContent = t('copied');
        setTimeout(function() { e.target.textContent = t('copy_phrase'); }, 1200);
      });
    }

    var copyBtn = container.querySelector('.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function(e) {
        await navigator.clipboard.writeText(decrypted);
        e.target.textContent = t('copied');
        setTimeout(function() { e.target.textContent = t('copy'); }, 1200);
      });
    }

  } catch (err) {
    showAlert(mensajeDeError(err) || t('decrypt_error'));
  }
});

// Eliminar wallet
$('#btn-delete-wallet').addEventListener('click', async function() {
  var confirmado = await showConfirm({
    title: t('delete_wallet'),
    body: t('delete_confirm'),
    confirmText: t('delete_wallet'),
    danger: true,
  });
  if (!confirmado) return;
  await window.api.deleteWallet(selectedWalletId);
  delete saldos[selectedWalletId];
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
    var historyResult = await window.api.getHistory(w.id);
    var history = historyResult.transactions;
    container.innerHTML = '';

    if (historyResult.verification && !historyResult.verification.verified) {
      container.appendChild(buildVerificationWarning(historyResult.verification));
    }
    // Una lista con agujeros que no se anuncian se lee como una lista completa.
    if (historyResult.historyFailures > 0) {
      container.appendChild(buildWarning(
        t('incomplete_history_title'),
        t('incomplete_history_detail', {
          failures: historyResult.historyFailures,
          total: historyResult.addressesQueried,
        })
      ));
    }
    if (historyResult.txSinResolver > 0) {
      container.appendChild(buildWarning(
        t('incomplete_history_title'),
        t('incomplete_history_tx', { count: historyResult.txSinResolver })
      ));
    }
    if (historyResult.chain) {
      container.appendChild(buildChainNote(historyResult.chain));
    }

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

      // La hora que existe es la del bloque, no la del envio; decirlo evita
      // que dos transacciones del mismo bloque parezcan hechas en el mismo
      // segundo por casualidad.
      var date = tx.time
        ? t('history_mined_at', { datetime: new Date(tx.time * 1000).toLocaleString() })
        : t('unconfirmed_label');
      var statusText = tx.height <= 0 && tx.time ? ' ' + t('unconfirmed_label') : '';
      // Sin poder resolver todos los inputs, el signo puede estar invertido:
      // una tx enviada se calcula como recibida. Mejor decir "no se pudo
      // calcular" que mostrar un numero con el signo al reves.
      if (tx.amountUncertain) {
        sign = '?';
        color = 'var(--muted)';
        bg = 'rgba(136,136,160,0.12)';
      }
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
            (tx.amountUncertain ? t('amount_uncertain') : (isPositive ? t('received') : t('sent'))) +
            ' <span style="color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 6px;">' + date + statusText + '</span>' +
            spvBadge(tx.verification) +
          '</div>' +
          '<div style="font-family: monospace; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + escapeHtml(tx.txid) + '">' +
            txidLink(tx.txid) +
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

  // El saldo disponible incluye lo del mempool. Decirlo, sin hacer ruido.
  var pendienteEl = $('#send-balance-unconfirmed');
  if (currentWalletUnconfirmedSats > 0) {
    pendienteEl.textContent = t('includes_unconfirmed', { amount: fmtBch(currentWalletUnconfirmedSats) });
    pendienteEl.classList.remove('hidden');
  } else {
    pendienteEl.classList.add('hidden');
  }

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

  var errEl = $('#send-error');
  var statEl = $('#send-status');
  var resEl = $('#send-result');

  errEl.classList.add('hidden');
  resEl.classList.add('hidden');
  statEl.classList.remove('hidden');
  statEl.textContent = t('building_tx');

  if (!address || !amount) {
    statEl.classList.add('hidden');
    errEl.textContent = t('fill_all_fields');
    errEl.classList.remove('hidden');
    return;
  }

  // Paso 1: calcular la comision real sin tocar claves y mostrarsela al
  // usuario. Enviar es irreversible: tiene que ver a donde va y cuanto sale
  // antes de que la semilla salga del vault.
  var plan;
  try {
    statEl.textContent = t('checking_tx');
    plan = await window.api.prepareSend(selectedWalletId, address, amount);
  } catch (err) {
    statEl.classList.add('hidden');
    errEl.textContent = mensajeDeError(err) || t('send_error');
    errEl.classList.remove('hidden');
    return;
  }

  statEl.classList.add('hidden');

  var fila = function(label, value, cls) {
    return '<div class="tx-review-row">' +
      '<span class="tx-review-label">' + escapeHtml(label) + '</span>' +
      '<span class="tx-review-value' + (cls ? ' ' + cls : '') + '">' + escapeHtml(value) + '</span>' +
      '</div>';
  };
  var bch = function(sats) { return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BCH'; };
  var plural = function(n, claveUno, claveVarios) {
    return n + ' ' + t(n === 1 ? claveUno : claveVarios);
  };

  // Cuantas direcciones se exponen es parte de lo que se aprueba, igual que el
  // monto: unir direcciones publica en la cadena que son del mismo dueño, y eso
  // no se deshace despues.
  var origen = plural(plan.inputCount, 'coin_one', 'coin_many') + ' · ' +
    plural(plan.addressCount, 'address_one', 'address_many');

  var avisos = '<div class="tx-review-note">' + escapeHtml(t('review_warning')) + '</div>';
  if (plan.merged) {
    avisos += '<div class="tx-review-note tx-review-privacy">' +
      escapeHtml(t('review_merge_warning', { addresses: plan.addressCount })) + '</div>';
  }
  if (plan.skippedCount > 0) {
    avisos += '<div class="tx-review-note">' +
      escapeHtml(t('review_dust_skipped', { count: plan.skippedCount, sats: plan.skippedSats })) +
      '</div>';
  }
  // Una direccion 1.../3... no dice de que red es: la misma sirve en BCH y en
  // Bitcoin. Mostramos como la leimos para que el usuario confirme la red.
  if (plan.legacyCashaddr) {
    avisos += '<div class="tx-review-note">' +
      escapeHtml(t('review_legacy_warning', { address: plan.legacyCashaddr })) + '</div>';
  }

  var confirmado = await showConfirm({
    title: t('confirm_send_title'),
    confirmText: t('confirm_send_button'),
    danger: true,
    bodyHtml:
      '<div class="tx-review">' +
        fila(t('review_to'), plan.toAddress) +
        fila(t('review_amount'), bch(plan.amountSats), 'amount') +
        fila(t('review_fee'), bch(plan.feeSats)) +
        fila(t('review_inputs'), origen) +
        (plan.changeSats > 0 ? fila(t('review_change'), bch(plan.changeSats)) : '') +
        fila(t('review_total'), bch(plan.amountSats + plan.feeSats)) +
      '</div>' +
      avisos,
  });

  if (!confirmado) return;

  // Paso 2: recien ahora se saca la semilla del vault y se firma.
  statEl.classList.remove('hidden');
  statEl.textContent = t('building_tx');

  try {
    var res = await window.api.sendBch(selectedWalletId, address, amount);
    delete saldos[selectedWalletId];
    statEl.classList.add('hidden');

    var txid = res && res.txid;
    var enlace = isTxid(txid)
      ? '<a href="https://blockchair.com/bitcoin-cash/transaction/' + encodeURIComponent(txid) + '" style="color: #4CAF50; word-break: break-all;">' + escapeHtml(txid) + '</a>'
      : '<span style="word-break: break-all;">' + escapeHtml(String(txid || '')) + '</span>';

    resEl.innerHTML =
      '<div class="ok" style="color: #4CAF50; font-weight: bold;">' + escapeHtml(t('tx_success')) + '</div>' +
      '<div class="hash" style="margin-top: 10px;">TXID:<br> ' + enlace + '</div>' +
      '<button class="btn" id="btn-back-after-send" style="margin-top: 1rem">' + escapeHtml(t('back_to_home')) + '</button>';
    resEl.classList.remove('hidden');
    document.getElementById('btn-back-after-send').addEventListener('click', function() { goTo('welcome'); });
  } catch (err) {
    statEl.classList.add('hidden');
    errEl.textContent = mensajeDeError(err) || t('send_error');
    errEl.classList.remove('hidden');
  }
});

// =========================== CANDADO DE ARRANQUE ===========================
// La contrasena maestra es la unica que la app pide. Abre el vault entero y no
// se vuelve a pedir en toda la sesion: ni para firmar, ni para ver una semilla,
// ni para guardar una billetera nueva.

function pintarCandado() {
  $('#lock-title').textContent = t(vaultEsNuevo ? 'lock_title_create' : 'lock_title_unlock');
  $('#lock-subtitle').textContent = t(vaultEsNuevo ? 'lock_subtitle_create' : 'lock_subtitle_unlock');
  $('#lock-password-label').textContent = t(vaultEsNuevo ? 'lock_password_new_label' : 'lock_password_label');
  $('#btn-unlock').textContent = t(vaultEsNuevo ? 'lock_create_button' : 'lock_unlock_button');
  $('#lock-warning').textContent = t('lock_no_recovery');
  // La confirmacion y el aviso de "no hay recuperacion" solo tienen sentido
  // cuando la contrasena se esta eligiendo por primera vez.
  $('#lock-confirm-field').classList.toggle('hidden', !vaultEsNuevo);
  $('#lock-warning').classList.toggle('hidden', !vaultEsNuevo);
}

async function abrirVault() {
  var password = $('#lock-password').value;
  var errorEl = $('#lock-error');
  var boton = $('#btn-unlock');
  errorEl.classList.add('hidden');

  var problema = vaultEsNuevo
    ? validarPassword(password, $('#lock-password-confirm').value)
    : (password ? null : t('password_required'));
  if (problema) {
    errorEl.textContent = problema;
    errorEl.classList.remove('hidden');
    return;
  }

  // Derivar la clave son 600.000 vueltas de PBKDF2 y frenan el proceso
  // principal: sin deshabilitar el boton, dos Enter seguidos son dos derivadas.
  var textoBoton = boton.textContent;
  boton.disabled = true;
  boton.textContent = t('lock_working');

  try {
    if (vaultEsNuevo) await window.api.createVault(password);
    else await window.api.unlockVault(password);
  } catch (err) {
    errorEl.textContent = mensajeDeError(err);
    errorEl.classList.remove('hidden');
    $('#lock-password').select();
    return;
  } finally {
    boton.disabled = false;
    boton.textContent = textoBoton;
  }

  // La contrasena no queda en ningun lado del frontend: el vault ya esta
  // abierto en el proceso principal y aca no hace falta nunca mas.
  $('#lock-password').value = '';
  $('#lock-password-confirm').value = '';

  vaultAbierto = true;
  $('#lock-screen').classList.add('hidden');
  loadSavedWallets();
}

$('#btn-unlock').addEventListener('click', abrirVault);
submitOnEnter($('#lock-password'), $('#btn-unlock'));
submitOnEnter($('#lock-password-confirm'), $('#btn-unlock'));

window.api.vaultStatus().then(function(estado) {
  vaultEsNuevo = !estado.inicializado;
  pintarCandado();
  $('#lock-password').focus();

  // Las billeteras de la version con una contrasena por billetera no se pueden
  // abrir con la maestra. El archivo quedo intacto, pero si no lo decimos
  // parecen perdidas.
  if (estado.legadoApartado) {
    showAlert(t('legacy_wallets_moved', { path: estado.legacyPath }));
  }
}).catch(function(err) {
  pintarCandado();
  $('#lock-error').textContent = mensajeDeError(err);
  $('#lock-error').classList.remove('hidden');
});

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

// Tor apagado: no hay red que rotar ni cotizacion que pedir, y decirlo es
// mejor que dejar el cartel de "iniciando" girando para siempre.
function setTorDisconnectedUI() {
  torState = 'disabled';
  torStatusText.textContent = t('tor_disabled');
  torLabel.title = t('tor_disabled');
  torStatusText.style.color = 'var(--muted)';
  torLabel.style.borderColor = 'var(--border)';
  newCircuitBtn.disabled = true;
  renderPriceStatus();
  updateAllFiatDisplays();
}

function setTorConnectedUI() {
  var veniaSinTor = torState !== 'ready';
  torState = 'ready';
  torStatusText.textContent = t('tor_connected');
  torLabel.title = '';
  torStatusText.style.color = 'var(--bch)';
  torLabel.style.borderColor = 'var(--bch)';
  newCircuitBtn.disabled = false;
  renderPriceStatus();
  updateAllFiatDisplays();
  // Los saldos quedaron sin pedir mientras Tor arrancaba: ahora que hay red,
  // se cargan solos y el usuario no tiene que recargar nada.
  if (veniaSinTor) loadSavedWallets();
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
    showAlert(t('circuit_error') + err.message);
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
