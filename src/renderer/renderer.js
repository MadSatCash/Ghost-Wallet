// Frontend de la wallet. Solo maneja la interfaz; toda la criptografia la
// pide al proceso principal via window.api (ver preload.js). Sin acceso a Node.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Navegacion entre pantallas ---
function goTo(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  
  if (name === 'welcome') {
    loadSavedWallets();
    // Limpiar pantalla Crear
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
    
    // Limpiar pantalla Importar
    $('#import-input').value = '';
    $('#import-hint').textContent = '';
    $('#import-hint').className = 'hint';
    $('#import-result').classList.add('hidden');
    $('#save-import-section').classList.add('hidden');
    $('#save-import-name').value = '';
    $('#save-import-password').value = '';
    $('#save-import-error').classList.add('hidden');
  }
}
$$('[data-go]').forEach((el) => el.addEventListener('click', () => goTo(el.dataset.go)));

// --- Utilidades de UI ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addressBox(label, address, note) {
  const box = document.createElement('div');
  box.className = 'address-box';
  box.innerHTML = `
    <div class="lbl">${escapeHtml(label)}</div>
    <div class="row">
      <span class="addr">${escapeHtml(address)}</span>
      <button class="copy">Copiar</button>
    </div>
    ${note ? `<div class="muted-note">${escapeHtml(note)}</div>` : ''}`;
  const btn = box.querySelector('.copy');
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(address);
    btn.textContent = 'Copiado!';
    setTimeout(() => (btn.textContent = 'Copiar'), 1200);
  });
  return box;
}

function fmtBch(sats) {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BCH';
}

// Encabezado grande con el saldo total.
function balanceHead(confirmed, unconfirmed) {
  const total = (confirmed || 0) + (unconfirmed || 0);
  const el = document.createElement('div');
  el.className = 'balance-head';
  el.innerHTML = `
    <div class="balance-label">Saldo total</div>
    <div class="balance-amount">${escapeHtml(fmtBch(total))}</div>
    ${unconfirmed ? `<div class="balance-pending">Incluye ${escapeHtml(fmtBch(unconfirmed))} sin confirmar</div>` : ''}`;
  return el;
}

// =========================== CREAR ===========================
let createType = 'mnemonic';
let currentMnemonic = '';
let currentSecret = '';

// Selector de tipo de wallet a crear (frase de palabras vs secreto de 64).
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  createType = b.dataset.ctype;
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  $('#field-words').classList.toggle('hidden', createType !== 'mnemonic');
  $('#field-hex').classList.toggle('hidden', createType !== 'hex');
  $('#btn-generate').textContent = createType === 'mnemonic'
    ? 'Generar frase secreta'
    : 'Generar secreto de 64';
  $('#create-result').classList.add('hidden');
}));

$('#btn-generate').addEventListener('click', async () => {
  const grid = $('#mnemonic-grid');
  const secretBox = $('#secret-box');
  grid.innerHTML = '';
  secretBox.innerHTML = '';
  $('#create-address').classList.add('hidden');
  $('#create-address').innerHTML = '';
  $('#save-create-section').classList.add('hidden');

  if (createType === 'mnemonic') {
    $('#btn-copy-mnemonic').classList.remove('hidden');
    const words = Number($('#word-count').value);
    currentMnemonic = await window.api.generateMnemonic(words);
    currentSecret = '';
    $('#create-warning').innerHTML = '&#9888; Anota estas palabras en papel y guardalas. ' +
      'Son la UNICA forma de recuperar tu plata. No se las muestres a nadie ni les saques foto.';
    currentMnemonic.split(' ').forEach((word, i) => {
      const el = document.createElement('div');
      el.className = 'word';
      el.innerHTML = `<span class="num">${i + 1}</span>${escapeHtml(word)}`;
      grid.appendChild(el);
    });
  } else {
    currentSecret = await window.api.generateHexSecret();
    currentMnemonic = '';
    $('#create-warning').innerHTML = '&#9888; Guarda este secreto en un lugar muy seguro. ' +
      'Es la UNICA forma de acceder a tu plata. No se lo muestres a nadie.';
    const box = document.createElement('div');
    box.className = 'secret-box';
    box.innerHTML = `
      <div class="lbl">Tu secreto (64 caracteres)</div>
      <div class="row">
        <span class="secret">${escapeHtml(currentSecret)}</span>
        <button class="copy" id="copy-secret">Copiar</button>
      </div>`;
    secretBox.appendChild(box);
    box.querySelector('#copy-secret').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(currentSecret);
      e.target.textContent = 'Copiado!';
      setTimeout(() => (e.target.textContent = 'Copiar'), 1200);
    });
    $('#btn-copy-mnemonic').classList.add('hidden'); // Ocultar boton genérico
  }

  $('#create-result').classList.remove('hidden');
});

$('#btn-copy-mnemonic').addEventListener('click', async (e) => {
  if (currentMnemonic) {
    await navigator.clipboard.writeText(currentMnemonic);
    const originalText = e.target.textContent;
    e.target.textContent = '¡Copiado!';
    setTimeout(() => (e.target.textContent = originalText), 1200);
  }
});

$('#btn-saved').addEventListener('click', async () => {
  const target = $('#create-address');
  target.classList.remove('hidden');
  target.innerHTML = '<div class="loading">Calculando tu direccion...</div>';

  let address, label;
  if (createType === 'mnemonic') {
    const addrs = await window.api.fromMnemonic(currentMnemonic, { count: 1 });
    address = addrs[0].address;
    label = 'Tu primera direccion para recibir BCH';
  } else {
    const cands = await window.api.fromHex(currentSecret);
    address = cands.find((c) => c.recipe === 'compressed').address;
    label = 'Tu direccion para recibir BCH (formato estandar)';
  }

  target.innerHTML = '';
  const box = addressBox(label, address, 'Comparti esta direccion para recibir pagos.');
  target.appendChild(box);

  // Mostrar saldo (recien creada: 0, pero confirma que la red responde).
  const bal = document.createElement('div');
  bal.className = 'muted-note';
  bal.textContent = 'Consultando saldo...';
  box.appendChild(bal);
  try {
    const b = await window.api.getBalance(address);
    bal.textContent = 'Saldo: ' + fmtBch((b.confirmed || 0) + (b.unconfirmed || 0));
  } catch {
    bal.textContent = 'Saldo: no pude conectar a la red en este momento.';
  }

  // Mostrar sección de guardado
  $('#save-create-name').value = '';
  $('#save-create-password').value = '';
  $('#save-create-error').classList.add('hidden');
  $('#save-create-section').classList.remove('hidden');
});

// =========================== IMPORTAR ===========================
const importInput = $('#import-input');
const importHint = $('#import-hint');

let hintTimer = null;
importInput.addEventListener('input', () => {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateHint, 150);
});

async function updateHint() {
  const val = importInput.value.trim();
  if (!val) { importHint.textContent = ''; importHint.className = 'hint'; return; }
  const type = await window.api.detectInput(val);
  const map = {
    hex: ['Secreto de 64 caracteres detectado.', 'ok'],
    mnemonic: ['Frase de palabras valida detectada.', 'ok'],
    'mnemonic-invalid': ['Parece una frase, pero hay alguna palabra mal escrita.', 'bad'],
    unknown: ['No reconozco el formato todavia.', 'bad'],
  };
  const [msg, cls] = map[type] || ['', 'hint'];
  importHint.textContent = msg;
  importHint.className = 'hint ' + cls;
}

$('#btn-import').addEventListener('click', async () => {
  const val = importInput.value.trim();
  const out = $('#import-result');
  out.classList.remove('hidden');
  if (!val) { out.innerHTML = '<div class="error">Pega tu frase o tu secreto primero.</div>'; return; }
  $('#save-import-section').classList.add('hidden');

  const type = await window.api.detectInput(val);
  if (type !== 'hex' && type !== 'mnemonic') {
    out.innerHTML = '<div class="error">No pude reconocer eso como una frase valida ' +
      'ni como un secreto de 64 caracteres. Revisalo e intenta de nuevo.</div>';
    return;
  }

  out.innerHTML = '<div class="loading">Conectando a la red BCH y consultando tu saldo...</div>';

  try {
    if (type === 'hex') {
      // Auto-deteccion: prueba las dos recetas y elige la que tenga fondos.
      const r = await window.api.resolveHexSecret(val);
      const chosen = r.candidates.find((c) => c.recipe === r.chosenRecipe);
      const other = r.candidates.find((c) => c.recipe !== r.chosenRecipe);
      const total = chosen.confirmed + chosen.unconfirmed;

      out.innerHTML = '';
      out.appendChild(balanceHead(chosen.confirmed, chosen.unconfirmed));
      const note = total > 0
        ? 'Detectamos tu saldo en la version "' + chosen.label.toLowerCase() + '".'
        : 'No encontramos saldo en ninguna de las dos versiones todavia.';
      out.appendChild(addressBox('Tu direccion (' + chosen.label + ')', chosen.address, note));
      if (other) {
        out.appendChild(addressBox(
          'Otra version posible (' + other.label + ')',
          other.address,
          'Saldo aqui: ' + fmtBch(other.confirmed + other.unconfirmed),
        ));
      }
      if (r.server) out.appendChild(serverNote(r.server));

      currentImportedSecret = val;
      currentImportedType = 'hex';
      currentImportedAddress = chosen.address;

      // Mostrar sección de guardado
      $('#save-import-name').value = '';
      $('#save-import-password').value = '';
      $('#save-import-error').classList.add('hidden');
      $('#save-import-section').classList.remove('hidden');
      return;
    }

    // mnemonic
    const r = await window.api.mnemonicReport(val, 5);
    out.innerHTML = '';
    out.appendChild(balanceHead(r.total.confirmed, r.total.unconfirmed));
    const title = document.createElement('p');
    title.className = 'subtitle';
    title.textContent = 'Tus primeras direcciones:';
    out.appendChild(title);
    r.addresses.forEach((a) => out.appendChild(addressBox(
      'Direccion #' + (a.index + 1),
      a.address,
      'Saldo: ' + fmtBch((a.confirmed || 0) + (a.unconfirmed || 0)),
    )));
    if (r.server) out.appendChild(serverNote(r.server));

    currentImportedSecret = val;
    currentImportedType = 'mnemonic';
    currentImportedAddress = r.addresses[0].address;

    // Mostrar sección de guardado
    $('#save-import-name').value = '';
    $('#save-import-password').value = '';
    $('#save-import-error').classList.add('hidden');
    $('#save-import-section').classList.remove('hidden');
  } catch (err) {
    out.innerHTML = '<div class="error">' + escapeHtml(err.message || String(err)) + '</div>';
  }
});

function serverNote(server) {
  const el = document.createElement('div');
  el.className = 'server-note';
  el.textContent = 'Conectado a ' + server;
  return el;
}

// =========================== PERSISTENCIA Y DETALLES ===========================
let currentImportedSecret = '';
let currentImportedType = '';
let currentImportedAddress = '';
let selectedWalletId = '';
let currentWalletBalanceSats = 0;

async function loadSavedWallets() {
  const wallets = await window.api.listWallets();
  const section = $('#saved-wallets-section');
  const list = $('#saved-wallets-list');
  list.innerHTML = '';

  if (wallets.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  wallets.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'wallet-item';
    item.innerHTML = `
      <div class="wallet-item-info">
        <span class="wallet-item-name">${escapeHtml(w.name)}</span>
        <span class="wallet-item-addr">${escapeHtml(w.address)}</span>
        <span class="wallet-item-type">${w.type === 'hex' ? 'secreto 64' : 'semilla'}</span>
      </div>
      <div class="wallet-item-balance" id="bal-${w.id}">... BCH</div>
    `;
    item.addEventListener('click', () => showWalletDetails(w.id));
    list.appendChild(item);

    // Consulta de saldo asíncrona en segundo plano
    window.api.getBalance(w.address).then((b) => {
      const balEl = document.getElementById(`bal-${w.id}`);
      if (balEl) {
        balEl.textContent = fmtBch((b.confirmed || 0) + (b.unconfirmed || 0));
      }
    }).catch(() => {
      const balEl = document.getElementById(`bal-${w.id}`);
      if (balEl) {
        balEl.textContent = 'Error';
      }
    });
  });
}

async function showWalletDetails(id) {
  selectedWalletId = id;
  const wallets = await window.api.listWallets();
  const w = wallets.find((x) => x.id === id);
  if (!w) return;

  goTo('wallet-details');

  $('#details-wallet-name').textContent = w.name;
  $('#details-wallet-type').textContent = `Tipo: ${w.type === 'hex' ? 'Secreto de 64 (Munia)' : 'Frase semilla'}`;
  
  const addrContainer = $('#details-address-container');
  const hdContainer = $('#hd-addresses-container');
  addrContainer.innerHTML = '';
  
  if (w.type === 'hex') {
    addrContainer.appendChild(addressBox('Dirección pública de Bitcoin Cash', w.address, 'Compartí esta dirección para recibir pagos.'));
    addrContainer.classList.remove('hidden');
    hdContainer.classList.add('hidden');
  } else {
    addrContainer.classList.add('hidden');
    hdContainer.classList.remove('hidden');
    $('#hd-addresses-list').innerHTML = '<div class="loading">Cargando direcciones...</div>';
  }

  const balContainer = $('#details-balance-container');
  balContainer.innerHTML = '<div class="loading">Consultando saldo de la red...</div>';

  // Ocultar sección de revelar clave por defecto
  $('#reveal-password-field').classList.add('hidden');
  $('#btn-reveal-secret').classList.remove('hidden');
  $('#revealed-secret-container').classList.add('hidden');
  $('#revealed-secret-container').innerHTML = '';
  $('#reveal-password').value = '';

  try {
    let b;
    if (w.type === 'hex') {
      b = await window.api.getBalance(w.address);
    } else {
      b = await window.api.getHdBalance(w.id);
      
      // Renderizar listado HD
      const list = $('#hd-addresses-list');
      list.innerHTML = '';
      b.receiveAddresses.forEach(a => {
        const div = document.createElement('div');
        div.style.padding = '0.5rem';
        div.style.borderBottom = '1px solid #444';
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        
        // Check if this address has any balance in the details array
        const detail = b.details.find(d => d.address === a.address);
        const balText = detail ? ` (Saldo: ${fmtBch(detail.confirmed + detail.unconfirmed)})` : ' (Sin uso)';
        
        div.innerHTML = `<span style="font-family: monospace; font-size: 0.9em; user-select: all;">${a.address}</span>
                         <span style="color: ${detail ? '#4caf50' : '#888'}; font-size: 0.8em;">${balText}</span>`;
        list.appendChild(div);
      });
    }

    currentWalletBalanceSats = (b.confirmed || 0) + (b.unconfirmed || 0);
    balContainer.innerHTML = '';
    balContainer.appendChild(balanceHead(b.confirmed, b.unconfirmed));
  } catch (err) {
    currentWalletBalanceSats = 0;
    balContainer.innerHTML = `<div class="error">No pude conectar a la red para ver el saldo: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

$('#btn-generate-address').addEventListener('click', async () => {
  const wallets = await window.api.listWallets();
  const w = wallets.find((x) => x.id === selectedWalletId);
  if (!w || w.type !== 'mnemonic') return;
  
  // Actually, we need a backend function to update the receiveIndex.
  // Wait, I didn't expose updateWallet or similar.
  // We can just add an ipc handler 'wallet:incrementReceiveIndex'
  await window.api.incrementReceiveIndex(w.id);
  showWalletDetails(w.id);
});

// Guardado de wallet creada
$('#btn-save-created').addEventListener('click', async () => {
  const name = $('#save-create-name').value.trim();
  const password = $('#save-create-password').value;
  const errorEl = $('#save-create-error');
  errorEl.classList.add('hidden');

  if (!password) {
    errorEl.textContent = 'La contraseña es requerida para encriptar tu clave.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    let secret = createType === 'mnemonic' ? currentMnemonic : currentSecret;
    let address;
    if (createType === 'mnemonic') {
      const addrs = await window.api.fromMnemonic(currentMnemonic, { count: 1 });
      address = addrs[0].address;
    } else {
      const cands = await window.api.fromHex(currentSecret);
      address = cands.find((c) => c.recipe === 'compressed').address;
    }

    await window.api.saveWallet({
      name,
      address,
      type: createType,
      secret,
      password
    });

    goTo('welcome');
  } catch (err) {
    errorEl.textContent = err.message || 'Error al guardar la billetera.';
    errorEl.classList.remove('hidden');
  }
});

// Guardado de wallet importada
$('#btn-save-imported').addEventListener('click', async () => {
  const name = $('#save-import-name').value.trim();
  const password = $('#save-import-password').value;
  const errorEl = $('#save-import-error');
  errorEl.classList.add('hidden');

  if (!password) {
    errorEl.textContent = 'La contraseña es requerida para encriptar tu clave.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await window.api.saveWallet({
      name: name,
      address: currentImportedAddress,
      type: currentImportedType,
      secret: currentImportedSecret,
      password
    });

    goTo('welcome');
  } catch (err) {
    errorEl.textContent = err.message || 'Error al guardar la billetera.';
    errorEl.classList.remove('hidden');
  }
});

// Revelar claves
$('#btn-reveal-secret').addEventListener('click', () => {
  $('#reveal-password-field').classList.remove('hidden');
  $('#btn-reveal-secret').classList.add('hidden');
  $('#reveal-password').focus();
});

$('#btn-cancel-reveal').addEventListener('click', () => {
  $('#reveal-password-field').classList.add('hidden');
  $('#btn-reveal-secret').classList.remove('hidden');
  $('#reveal-password').value = '';
});

$('#btn-confirm-reveal').addEventListener('click', async () => {
  const password = $('#reveal-password').value;
  const container = $('#revealed-secret-container');
  container.classList.add('hidden');
  container.innerHTML = '';

  if (!password) {
    alert('Por favor ingresá tu contraseña.');
    return;
  }

  try {
    const decrypted = await window.api.decryptWallet(selectedWalletId, password);
    container.classList.remove('hidden');
    
    const wallets = await window.api.listWallets();
    const w = wallets.find((x) => x.id === selectedWalletId);
    
    if (w.type === 'hex') {
      container.innerHTML = `
        <div class="secret-box">
          <div class="lbl">Tu secreto (64 caracteres)</div>
          <div class="row">
            <span class="secret">${escapeHtml(decrypted)}</span>
            <button class="copy" id="copy-revealed">Copiar</button>
          </div>
        </div>`;
    } else {
      const gridHtml = decrypted.split(' ').map((word, i) => `
        <div class="word"><span class="num">${i + 1}</span>${escapeHtml(word)}</div>
      `).join('');
      container.innerHTML = `
        <div class="warning">⚠️ Anotá estas palabras en papel y no se las muestres a nadie.</div>
        <div class="mnemonic-grid">${gridHtml}</div>
      `;
    }

    const copyBtn = container.querySelector('.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(decrypted);
        e.target.textContent = 'Copiado!';
        setTimeout(() => (e.target.textContent = 'Copiar'), 1200);
      });
    }

    $('#reveal-password-field').classList.add('hidden');
  } catch (err) {
    alert(err.message || 'Error al descifrar.');
  }
});

// Eliminar wallet
$('#btn-delete-wallet').addEventListener('click', async () => {
  if (!confirm('¿Estás seguro de que querés eliminar esta billetera de tu computadora? Asegurate de tener anotado el secreto/semilla, o perderás el acceso a tus fondos para siempre.')) {
    return;
  }
  await window.api.deleteWallet(selectedWalletId);
  goTo('welcome');
});

// =========================== HISTORIAL ===========================
$('#btn-go-history').addEventListener('click', async () => {
  goTo('history');
  
  const wallets = await window.api.listWallets();
  const w = wallets.find((x) => x.id === selectedWalletId);
  if (!w) return;
  
  $('#history-wallet-name').textContent = w.name;
  const container = $('#history-container');
  container.innerHTML = '<div class="loading">Descargando el historial detallado de la red (esto puede demorar unos segundos)...</div>';
  
  try {
    const history = await window.api.getHistory(w.id);
    container.innerHTML = '';
    
    if (history.length === 0) {
      container.innerHTML = '<div class="hint" style="text-align: center; padding: 2rem;">No tenés transacciones en esta billetera todavía.</div>';
      return;
    }
    
    history.forEach(tx => {
      const isPositive = tx.netSats > 0;
      const bch = (Math.abs(tx.netSats) / 1e8).toFixed(8).replace(/\.?0+$/, '');
      const sign = isPositive ? '+' : '-';
      const color = isPositive ? 'var(--bch)' : 'var(--warn-text)';
      const bg = isPositive ? 'rgba(10,193,142,0.1)' : 'rgba(255,107,107,0.1)';
      
      const date = new Date(tx.time * 1000).toLocaleString();
      const statusText = tx.height <= 0 ? '(Sin confirmar)' : '';
      
      const div = document.createElement('div');
      div.style.background = 'var(--panel)';
      div.style.border = '1px solid var(--border)';
      div.style.borderRadius = '10px';
      div.style.padding = '14px';
      div.style.marginBottom = '10px';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      
      div.innerHTML = `
        <div style="flex: 1; overflow: hidden; margin-right: 15px;">
          <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">
            ${isPositive ? 'Recibido' : 'Enviado'} <span style="color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 6px;">${date} ${statusText}</span>
          </div>
          <div style="font-family: monospace; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tx.txid}">
            <a href="https://blockchair.com/bitcoin-cash/transaction/${tx.txid}" target="_blank" style="color: var(--muted); text-decoration: none;">${tx.txid}</a>
          </div>
        </div>
        <div style="background: ${bg}; color: ${color}; padding: 6px 12px; border-radius: 8px; font-weight: bold; font-family: monospace; font-size: 15px; white-space: nowrap;">
          ${sign}${bch} BCH
        </div>
      `;
      container.appendChild(div);
    });
    
  } catch (err) {
    container.innerHTML = `<div class="error">Hubo un error cargando el historial: ${escapeHtml(err.message)}</div>`;
  }
});

// =========================== ENVIAR BCH ===========================
$('#btn-go-send').addEventListener('click', () => {
  $('#send-address').value = '';
  $('#send-amount').value = '';
  $('#send-password').value = '';
  $('#send-error').classList.add('hidden');
  $('#send-status').classList.add('hidden');
  $('#send-result').classList.add('hidden');
  
  const nameEl = $('#details-wallet-name').textContent;
  $('#send-wallet-name').textContent = nameEl;

  // Actualizar saldo disponible y satoshis
  $('#send-wallet-balance').textContent = (currentWalletBalanceSats / 1e8).toFixed(8).replace(/\.?0+$/, '');
  $('#send-satoshis').textContent = '0 satoshis';

  goTo('send');
});

$('#send-amount').addEventListener('input', (e) => {
  // Solo permitir números y un separador decimal (. o ,)
  let val = e.target.value.replace(/[^0-9.,]/g, '');
  val = val.replace(',', '.'); // Normalizar coma a punto
  
  // Evitar múltiples puntos
  const parts = val.split('.');
  if (parts.length > 2) {
    val = parts[0] + '.' + parts.slice(1).join('');
  }
  
  if (val !== e.target.value) {
    e.target.value = val;
  }

  const bch = parseFloat(val) || 0;
  const sats = Math.floor(bch * 1e8);
  // Formato con separadores de miles
  $('#send-satoshis').textContent = new Intl.NumberFormat('es-AR').format(sats) + ' satoshis';
});

$('#btn-send-max').addEventListener('click', (e) => {
  e.preventDefault();
  // Asumimos un fee generoso de 500 satoshis (para asegurar que pase incluso con varios inputs)
  // En BCH los fees son bajísimos, usualmente < 300 sats.
  const estimatedFeeSats = 500;
  let maxSats = currentWalletBalanceSats - estimatedFeeSats;
  if (maxSats < 0) maxSats = 0;
  
  const maxBch = (maxSats / 1e8).toFixed(8);
  $('#send-amount').value = maxBch;
  $('#send-satoshis').textContent = new Intl.NumberFormat('es-AR').format(maxSats) + ' satoshis';
});

$('#btn-confirm-send').addEventListener('click', async () => {
  const address = $('#send-address').value.trim();
  const amount = $('#send-amount').value;
  const password = $('#send-password').value;
  
  const errEl = $('#send-error');
  const statEl = $('#send-status');
  const resEl = $('#send-result');

  errEl.classList.add('hidden');
  resEl.classList.add('hidden');
  statEl.classList.remove('hidden');
  statEl.textContent = 'Construyendo transacción y conectando a la red...';

  if (!address || !amount || !password) {
    statEl.classList.add('hidden');
    errEl.textContent = 'Por favor completá todos los campos.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const txid = await window.api.sendBch(selectedWalletId, password, address, amount);
    statEl.classList.add('hidden');
    resEl.innerHTML = `
      <div class="ok" style="color: #4CAF50; font-weight: bold;">¡Transacción enviada con éxito!</div>
      <div class="hash" style="margin-top: 10px;">TXID:<br> <a href="https://blockchair.com/bitcoin-cash/transaction/${txid}" target="_blank" style="color: #4CAF50; word-break: break-all;">${txid}</a></div>
      <button class="btn" style="margin-top: 1rem" onclick="document.querySelector('.back[data-go=\\'welcome\\']').click()">Volver al inicio</button>
    `;
    resEl.classList.remove('hidden');
  } catch (err) {
    statEl.classList.add('hidden');
    errEl.textContent = err.message || 'Error al enviar BCH.';
    errEl.classList.remove('hidden');
  }
});

// Cargar billeteras guardadas al iniciar la app
loadSavedWallets();

// Añadir botón de mostrar/ocultar a todos los campos de contraseña
document.querySelectorAll('input[type="password"]').forEach(input => {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';
  
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = 'Mostrar';
  toggleBtn.style.position = 'absolute';
  toggleBtn.style.right = '10px';
  toggleBtn.style.background = 'none';
  toggleBtn.style.border = 'none';
  toggleBtn.style.color = 'var(--bch)';
  toggleBtn.style.cursor = 'pointer';
  toggleBtn.style.fontSize = '12px';
  toggleBtn.style.fontWeight = 'bold';
  
  // Evitar que el texto del input se superponga con el botón
  input.style.paddingRight = '60px';
  
  toggleBtn.addEventListener('click', () => {
    if (input.type === 'password') {
      input.type = 'text';
      toggleBtn.textContent = 'Ocultar';
    } else {
      input.type = 'password';
      toggleBtn.textContent = 'Mostrar';
    }
  });
  
  wrapper.appendChild(toggleBtn);
});

// =========================== TOR ===========================
const torCheckbox = $('#tor-checkbox');
const torStatusText = $('#tor-status-text');
const torLabel = $('#tor-toggle-label');
const newCircuitBtn = $('#btn-new-circuit');

function setTorConnectedUI() {
  torStatusText.textContent = 'Tor Conectado';
  torStatusText.style.color = 'var(--bch)';
  torLabel.style.borderColor = 'var(--bch)';
  newCircuitBtn.classList.remove('hidden');
}

function setTorDisconnectedUI() {
  torStatusText.textContent = 'Tor Desactivado';
  torStatusText.style.color = '';
  torLabel.style.borderColor = 'var(--border)';
  newCircuitBtn.classList.add('hidden');
}

torCheckbox.addEventListener('change', async (e) => {
  const enable = e.target.checked;
  torCheckbox.disabled = true;
  
  if (enable) {
    torStatusText.textContent = 'Iniciando Tor...';
    torStatusText.style.color = 'var(--warn-text)';
    
    try {
      await window.api.enableTor();
      setTorConnectedUI();
    } catch (err) {
      alert('Error al iniciar Tor: ' + err.message);
      torCheckbox.checked = false;
      setTorDisconnectedUI();
    }
  } else {
    torStatusText.textContent = 'Desconectando...';
    await window.api.disableTor();
    setTorDisconnectedUI();
  }
  
  torCheckbox.disabled = false;
});

newCircuitBtn.addEventListener('click', async () => {
  newCircuitBtn.disabled = true;
  newCircuitBtn.textContent = 'Rotando...';
  try {
    await window.api.torNewCircuit();
    newCircuitBtn.textContent = '✓ Circuito nuevo';
    setTimeout(() => { newCircuitBtn.textContent = '↻ Nuevo circuito'; }, 2000);
  } catch (err) {
    alert('Error al rotar circuito: ' + err.message);
    newCircuitBtn.textContent = '↻ Nuevo circuito';
  }
  newCircuitBtn.disabled = false;
});

window.api.onTorProgress((msg) => {
  if (torCheckbox.checked && msg) {
    torStatusText.textContent = msg;
  }
});

window.api.torStatus().then(async status => {
  // Solo la primera vez que se abre la app
  const isDownloaded = await window.api.isTorDownloaded();
  
  if (isDownloaded) {
    // Ya lo tiene. Forzamos auto-activación siempre que arranca.
    if (!status.enabled) {
      torCheckbox.checked = true;
      torStatusText.textContent = 'Iniciando...';
      torStatusText.style.color = 'var(--warn-text)';
      try {
        await window.api.enableTor();
        setTorConnectedUI();
      } catch (err) {
        alert('Error al iniciar Tor: ' + err.message);
        console.error(err);
        torCheckbox.checked = false;
        setTorDisconnectedUI();
      }
    } else {
      if (status.ready) setTorConnectedUI();
    }
  } else {
    // Es la primera vez que usa la app
    const msg = "Esta billetera está diseñada para proteger tu privacidad ruteando todo su tráfico a través de la red Tor.\n\n" +
                "¿Deseás descargar e instalar el motor de Tor ahora? (Se bajará la versión oficial de torproject.org)";
    if (confirm(msg)) {
      torCheckbox.checked = true;
      torStatusText.textContent = 'Preparando descarga...';
      torStatusText.style.color = 'var(--warn-text)';
      try {
        await window.api.enableTor();
        setTorConnectedUI();
      } catch (err) {
        alert('Error al instalar Tor: ' + err.message);
        torCheckbox.checked = false;
        setTorDisconnectedUI();
      }
    } else {
      alert("Alerta: Optaste por no usar Tor. La billetera no se conectará a la red por razones de privacidad extrema (el modo directo está deshabilitado).");
      torCheckbox.checked = false;
      setTorDisconnectedUI();
    }
  }
});
