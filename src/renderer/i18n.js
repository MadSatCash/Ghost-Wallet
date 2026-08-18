const TRANSLATIONS = {
  es: {
    brand_name: 'Ghost Wallet',
    tor_disabled: 'Tor Desactivado',
    tor_connected: 'Tor Conectado',
    new_circuit: '↻ Nuevo circuito',
    new_circuit_title: 'Cambiar la ruta de conexión por la red Tor (New Identity)',
    version_badge: 'v0.10.0 · Privacidad Total',
    welcome_title: 'Tu billetera Bitcoin Cash',
    welcome_subtitle: 'Simple, rapida y con tus claves siempre en tu compu.',
    create_wallet: 'Crear wallet nueva',
    create_wallet_sub: 'Genera una frase secreta nueva',
    import_wallet: 'Importar wallet',
    import_wallet_sub: '12 / 24 palabras o tu secreto de 64',
    saved_wallets_title: 'Tus billeteras guardadas',
    back: '← Volver',
    create_title: 'Crear wallet nueva',
    type_mnemonic: 'Frase de palabras (BIP39)',
    type_hex: 'Clave cruda de 64 chars (Legacy)',
    type_hex_hd: 'Semilla HD de 64 chars (256 bits)',
    word_count_label: 'Cantidad de palabras',
    words_12: '12 palabras (128 bits de entropía)',
    words_15: '15 palabras (160 bits)',
    words_18: '18 palabras (192 bits)',
    words_21: '21 palabras (224 bits)',
    words_24: '24 palabras (256 bits — máxima seguridad)',
    hex_hint: 'Genera una clave privada Legacy de 64 caracteres hexadecimales para una sola dirección, equivalente a <code>secrets.token_hex(32)</code> en Python.',
    hex_hd_hint: 'Genera una semilla hexadecimal HD de 256 bits. De ella se deriva un árbol BIP32/BIP44 con múltiples direcciones de recepción y cambio.',
    generate_mnemonic: 'Generar frase secreta',
    generate_hex: 'Generar secreto de 64',
    copy_phrase: 'Copiar frase',
    noted_see_address: 'Ya lo anoté → ver mi dirección',
    save_wallet_title: 'Guardar esta billetera en esta compu',
    wallet_name_label: 'Nombre de la billetera',
    wallet_name_placeholder_create: 'Ej: Mi Billetera Principal',
    password_label: 'Contraseña de seguridad (para encriptar la clave privada)',
    password_placeholder: 'Tu contraseña',
    save_button: 'Guardar en la compu',
    import_title: 'Importar wallet',
    import_subtitle: 'Pega tus 12/24 palabras, o tu secreto de 64 caracteres.',
    import_placeholder: 'palabra1 palabra2 ...   o   a1b2c3...(64 caracteres)',
    import_button: 'Importar',
    import_hex_mode_question: '¿Qué tipo de clave de 64 caracteres estás importando?',
    import_hex_legacy: 'Legacy · una dirección',
    import_hex_hd: 'HD · múltiples direcciones',
    import_hex_mode_required: 'Elegí si la clave de 64 caracteres es Legacy o HD.',
    wallet_name_placeholder_import: 'Ej: Importada',
    back_home: '← Volver al inicio',
    wallet_details: 'Detalles de Wallet',
    type_hex_detail: 'Tipo: Clave cruda de 64 caracteres (Legacy)',
    type_hex_hd_detail: 'Tipo: Semilla HD de 64 caracteres (256 bits)',
    type_mnemonic_detail: 'Tipo: Frase semilla',
    receive_addresses_title: 'Direcciones de Recepción',
    receive_hint: 'Usá cualquiera de estas direcciones para recibir BCH. Tu saldo total es la suma de todas ellas.',
    generate_address: 'Generar nueva dirección',
    send_bch: 'Enviar BCH',
    view_history: 'Ver historial de pagos',
    reveal_secret: 'Ver clave privada / semilla',
    enter_password_reveal: 'Ingresa tu contraseña para revelar',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    delete_wallet: 'Eliminar de esta compu',
    back_details: '← Volver a los detalles',
    send_title: 'Enviar BCH',
    sending_from: 'Enviando desde:',
    available_balance: 'Saldo disponible:',
    dest_address_label: 'Dirección de destino (bitcoincash:...)',
    dest_address_placeholder: 'bitcoincash:qrv7g5...',
    amount_label: 'Monto a enviar (BCH)',
    send_max: 'ENVIAR MÁXIMO',
    send_password_label: 'Contraseña de la billetera (para firmar la transacción)',
    confirm_send: 'Confirmar y Enviar',
    history_title: 'Historial de Pagos',
    history_wallet: 'Billetera:',
    created_by: 'Creado por',
    copy: 'Copiar',
    copied: '¡Copiado!',
    total_balance: 'Saldo total',
    includes_unconfirmed: 'Incluye {amount} sin confirmar',
    calculating_address: 'Calculando tu dirección...',
    first_address: 'Tu primera dirección para recibir BCH',
    standard_address: 'Tu dirección para recibir BCH (formato estándar)',
    share_address: 'Compartí esta dirección para recibir pagos.',
    checking_balance: 'Consultando saldo...',
    balance_prefix: 'Saldo: ',
    balance_error: 'Saldo: no pude conectar a la red en este momento.',
    warning_mnemonic: '⚠ Anotá estas palabras en papel y guardalas. Son la ÚNICA forma de recuperar tu plata. No se las muestres a nadie ni les saques foto.',
    warning_hex: '⚠ Guardá este secreto en un lugar muy seguro. Es la ÚNICA forma de acceder a tu plata. No se lo muestres a nadie.',
    warning_hex_hd: '⚠ Guardá esta semilla HD en un lugar muy seguro. Es la ÚNICA forma de reconstruir todas las direcciones y acceder a tu plata.',
    your_secret: 'Tu secreto (64 caracteres)',
    password_required: 'La contraseña es requerida para encriptar tu clave.',
    save_error: 'Error al guardar la billetera.',
    hex_detected: 'Secreto de 64 caracteres detectado.',
    mnemonic_detected: 'Frase de palabras válida detectada.',
    mnemonic_invalid: 'Parece una frase, pero hay alguna palabra mal escrita.',
    unknown_format: 'No reconozco el formato todavía.',
    paste_first: 'Pegá tu frase o tu secreto primero.',
    unrecognized_input: 'No pude reconocer eso como una frase válida ni como un secreto de 64 caracteres. Revisalo e intentá de nuevo.',
    connecting_network: 'Conectando a la red BCH y consultando tu saldo...',
    detected_balance: 'Detectamos tu saldo en la versión “{version}”.',
    no_balance_found: 'No encontramos saldo en ninguna de las dos versiones todavía.',
    your_address: 'Tu dirección ({label})',
    other_version: 'Otra versión posible ({label})',
    balance_here: 'Saldo aquí: ',
    first_addresses: 'Tus primeras direcciones:',
    address_num: 'Dirección #{num}',
    connected_to: 'Conectado a ',
    verify_unverified_title: '⚠ Dato sin verificar',
    spv_verified: '✓ verificada',
    spv_pending: 'pendiente',
    spv_out_of_range: 'histórica',
    spv_failed: '⚠ no coincide',
    chain_syncing: 'Verificando la cadena por proof-of-work… {pct}%',
    chain_ready: 'Cadena verificada por proof-of-work hasta el bloque {height}.',
    chain_error: 'No se pudo verificar la cadena: {error}. Las transacciones siguen cruzadas entre operadores.',
    verify_ok: 'Verificado por varios operadores',
    bch_public_address: 'Dirección pública de Bitcoin Cash',
    share_receive: 'Compartí esta dirección para recibir pagos.',
    loading_addresses: 'Cargando direcciones...',
    loading_balance: 'Consultando saldo de la red...',
    no_use: 'Sin uso',
    balance_network_error: 'No pude conectar a la red para ver el saldo: {error}',
    secret_type_hex: 'secreto 64',
    secret_type_mnemonic: 'semilla',
    wallet_tag_single: '1 direccion',
    wallet_tag_hd: 'HD · múltiples direcciones',
    wallet_tag_hex_hd: '64-char HD · múltiples direcciones',
    loading_bch: '... BCH',
    error_text: 'Error',
    enter_password: 'Por favor ingresá tu contraseña.',
    warning_write_down: '⚠️ Anotá estas palabras en papel y no se las muestres a nadie.',
    decrypt_error: 'Error al descifrar.',
    delete_confirm: '¿Estás seguro de que querés eliminar esta billetera de tu computadora? Asegurate de tener anotado el secreto/semilla, o perderás el acceso a tus fondos para siempre.',
    loading_history: 'Descargando el historial detallado de la red (esto puede demorar unos segundos)...',
    no_transactions: 'No tenés transacciones en esta billetera todavía.',
    received: 'Recibido',
    sent: 'Enviado',
    unconfirmed_label: '(Sin confirmar)',
    history_error: 'Hubo un error cargando el historial: {error}',
    building_tx: 'Construyendo transacción y conectando a la red...',
    fill_all_fields: 'Por favor completá todos los campos.',
    tx_success: '¡Transacción enviada con éxito!',
    back_to_home: 'Volver al inicio',
    send_error: 'Error al enviar BCH.',
    modal_accept: 'Aceptar',
    modal_cancel: 'Cancelar',
    modal_notice: 'Aviso',
    checking_tx: 'Calculando comisión...',
    confirm_send_title: 'Revisá antes de enviar',
    confirm_send_button: 'Confirmar y enviar',
    review_to: 'Destino',
    review_amount: 'Monto',
    review_fee: 'Comisión',
    review_change: 'Vuelto',
    review_total: 'Sale de tu saldo',
    review_warning: 'Esta operación es irreversible. Verificá que la dirección de destino sea exactamente la que te pasaron.',
    review_inputs: 'Se gasta de',
    coin_one: 'moneda',
    coin_many: 'monedas',
    address_one: 'dirección',
    address_many: 'direcciones',
    review_merge_warning: 'Este envío junta {addresses} direcciones tuyas en una sola transacción, y eso publica en la cadena que son del mismo dueño. Pasa porque ninguna alcanzaba sola para este monto.',
    review_dust_skipped: 'Quedaron afuera {count} monedas muy chicas ({sats} sats): gastarlas costaría más comisión de lo que valen.',
    password_too_short: 'La contraseña debe tener al menos 8 caracteres.',
    password_mismatch: 'Las contraseñas no coinciden.',
    password_confirm_label: 'Repetí la contraseña',
    password_confirm_placeholder: 'Repetí tu contraseña',
    show_password: 'Mostrar',
    hide_password: 'Ocultar',
    rotating: 'Rotando...',
    circuit_done: '✓ Circuito nuevo',
    circuit_error: 'Error al rotar circuito: ',
    starting_tor: 'Iniciando Tor...',
    tor_start_error: 'Error al iniciar Tor: ',
    disconnecting: 'Desconectando...',
    starting: 'Iniciando...',
    preparing_download: 'Preparando descarga...',
    tor_install_error: 'Error al instalar Tor: ',
    tor_first_time: 'Esta billetera está diseñada para proteger tu privacidad ruteando todo su tráfico a través de la red Tor.\n\n¿Deseás descargar e instalar el motor de Tor ahora? (Se bajará la versión oficial de torproject.org)',
    tor_declined: 'Alerta: Optaste por no usar Tor. La billetera no se conectará a la red por razones de privacidad extrema (el modo directo está deshabilitado).',
    satoshis: 'satoshis',
    price_loading: 'Cargando cotizacion BCH...',
    price_waiting_tor: 'Activa Tor para ver la cotizacion',
    price_establishing_network: 'Estableciendo red privada...',
    price_retrying: 'No pude cargar la cotizacion. Reintentando...',
    price_ready: '1 BCH \u2248 {price}',
    price_ready_fallback: '1 BCH \u2248 {price} (sin precio en {currency})',
    price_unavailable: 'Cotizaci\u00f3n no disponible',
  },
  en: {
    brand_name: 'Ghost Wallet',
    tor_disabled: 'Tor Disabled',
    tor_connected: 'Tor Connected',
    new_circuit: '↻ New circuit',
    new_circuit_title: 'Change Tor routing path (New Identity)',
    version_badge: 'v0.10.0 · Total Privacy',
    welcome_title: 'Your Bitcoin Cash Wallet',
    welcome_subtitle: 'Simple, fast, and your keys always on your computer.',
    create_wallet: 'Create new wallet',
    create_wallet_sub: 'Generate a new secret phrase',
    import_wallet: 'Import wallet',
    import_wallet_sub: '12 / 24 words or your 64-char secret',
    saved_wallets_title: 'Your saved wallets',
    back: '← Back',
    create_title: 'Create new wallet',
    type_mnemonic: 'Word phrase (BIP39)',
    type_hex: '64-char raw key (Legacy)',
    type_hex_hd: '64-char HD seed (256 bits)',
    word_count_label: 'Number of words',
    words_12: '12 words (128 bits of entropy)',
    words_15: '15 words (160 bits)',
    words_18: '18 words (192 bits)',
    words_21: '21 words (224 bits)',
    words_24: '24 words (256 bits — maximum security)',
    hex_hint: 'Generates a Legacy 64-character private key for a single address, equivalent to <code>secrets.token_hex(32)</code> in Python.',
    hex_hd_hint: 'Generates a 256-bit hexadecimal HD seed. A BIP32/BIP44 tree provides multiple receive and change addresses.',
    generate_mnemonic: 'Generate secret phrase',
    generate_hex: 'Generate 64-char secret',
    copy_phrase: 'Copy phrase',
    noted_see_address: 'I wrote it down → see my address',
    save_wallet_title: 'Save this wallet on this computer',
    wallet_name_label: 'Wallet name',
    wallet_name_placeholder_create: 'e.g.: My Main Wallet',
    password_label: 'Security password (to encrypt the private key)',
    password_placeholder: 'Your password',
    save_button: 'Save to computer',
    import_title: 'Import wallet',
    import_subtitle: 'Paste your 12/24 words, or your 64-character secret.',
    import_placeholder: 'word1 word2 ...   or   a1b2c3...(64 characters)',
    import_button: 'Import',
    import_hex_mode_question: 'What type of 64-character key are you importing?',
    import_hex_legacy: 'Legacy · one address',
    import_hex_hd: 'HD · multiple addresses',
    import_hex_mode_required: 'Choose whether the 64-character key is Legacy or HD.',
    wallet_name_placeholder_import: 'e.g.: Imported wallet',
    back_home: '← Back to home',
    wallet_details: 'Wallet Details',
    type_hex_detail: 'Type: 64-char raw key (Legacy)',
    type_hex_hd_detail: 'Type: 64-char HD seed (256 bits)',
    type_mnemonic_detail: 'Type: Seed phrase',
    receive_addresses_title: 'Receive Addresses',
    receive_hint: 'Use any of these addresses to receive BCH. Your total balance is the sum of all of them.',
    generate_address: 'Generate new address',
    send_bch: 'Send BCH',
    view_history: 'View payment history',
    reveal_secret: 'View private key / seed',
    enter_password_reveal: 'Enter your password to reveal',
    confirm: 'Confirm',
    cancel: 'Cancel',
    delete_wallet: 'Delete from this computer',
    back_details: '← Back to details',
    send_title: 'Send BCH',
    sending_from: 'Sending from:',
    available_balance: 'Available balance:',
    dest_address_label: 'Destination address (bitcoincash:...)',
    dest_address_placeholder: 'bitcoincash:qrv7g5...',
    amount_label: 'Amount to send (BCH)',
    send_max: 'SEND MAX',
    send_password_label: 'Wallet password (to sign the transaction)',
    confirm_send: 'Confirm and Send',
    history_title: 'Payment History',
    history_wallet: 'Wallet:',
    created_by: 'Created by',
    copy: 'Copy',
    copied: 'Copied!',
    total_balance: 'Total balance',
    includes_unconfirmed: 'Includes {amount} unconfirmed',
    calculating_address: 'Calculating your address...',
    first_address: 'Your first address to receive BCH',
    standard_address: 'Your address to receive BCH (standard format)',
    share_address: 'Share this address to receive payments.',
    checking_balance: 'Checking balance...',
    balance_prefix: 'Balance: ',
    balance_error: 'Balance: could not connect to the network right now.',
    warning_mnemonic: '⚠ Write down these words on paper and keep them safe. They are the ONLY way to recover your funds. Do not show them to anyone or take photos.',
    warning_hex: '⚠ Keep this secret in a very safe place. It is the ONLY way to access your funds. Do not show it to anyone.',
    warning_hex_hd: '⚠ Keep this HD seed in a very safe place. It is the ONLY way to rebuild every address and access your funds.',
    your_secret: 'Your secret (64 characters)',
    password_required: 'Password is required to encrypt your key.',
    save_error: 'Error saving wallet.',
    hex_detected: '64-character secret detected.',
    mnemonic_detected: 'Valid word phrase detected.',
    mnemonic_invalid: 'Looks like a phrase, but some word is misspelled.',
    unknown_format: 'Format not recognized yet.',
    paste_first: 'Paste your phrase or secret first.',
    unrecognized_input: 'Could not recognize this as a valid phrase or 64-character secret. Please check and try again.',
    connecting_network: 'Connecting to the BCH network and checking your balance...',
    detected_balance: 'Balance detected in the “{version}” version.',
    no_balance_found: 'No balance found in either version yet.',
    your_address: 'Your address ({label})',
    other_version: 'Other possible version ({label})',
    balance_here: 'Balance here: ',
    first_addresses: 'Your first addresses:',
    address_num: 'Address #{num}',
    connected_to: 'Connected to ',
    verify_unverified_title: '⚠ Unverified data',
    spv_verified: '✓ verified',
    spv_pending: 'pending',
    spv_out_of_range: 'historic',
    spv_failed: '⚠ mismatch',
    chain_syncing: 'Verifying the chain by proof-of-work… {pct}%',
    chain_ready: 'Chain verified by proof-of-work up to block {height}.',
    chain_error: 'Could not verify the chain: {error}. Transactions are still cross-checked across operators.',
    verify_ok: 'Cross-checked across operators',
    bch_public_address: 'Bitcoin Cash public address',
    share_receive: 'Share this address to receive payments.',
    loading_addresses: 'Loading addresses...',
    loading_balance: 'Checking network balance...',
    no_use: 'Unused',
    balance_network_error: 'Could not connect to the network to check balance: {error}',
    secret_type_hex: '64-char secret',
    secret_type_mnemonic: 'seed',
    wallet_tag_single: '1 address',
    wallet_tag_hd: 'HD · multiple addresses',
    wallet_tag_hex_hd: '64-char HD · multiple addresses',
    loading_bch: '... BCH',
    error_text: 'Error',
    enter_password: 'Please enter your password.',
    warning_write_down: '⚠️ Write these words on paper and do not show them to anyone.',
    decrypt_error: 'Error decrypting.',
    delete_confirm: 'Are you sure you want to delete this wallet from your computer? Make sure you have written down the secret/seed, or you will lose access to your funds forever.',
    loading_history: 'Downloading detailed history from the network (this may take a few seconds)...',
    no_transactions: 'No transactions in this wallet yet.',
    received: 'Received',
    sent: 'Sent',
    unconfirmed_label: '(Unconfirmed)',
    history_error: 'Error loading history: {error}',
    building_tx: 'Building transaction and connecting to the network...',
    fill_all_fields: 'Please fill in all fields.',
    tx_success: 'Transaction sent successfully!',
    back_to_home: 'Back to home',
    send_error: 'Error sending BCH.',
    modal_accept: 'OK',
    modal_cancel: 'Cancel',
    modal_notice: 'Notice',
    checking_tx: 'Calculating fee...',
    confirm_send_title: 'Review before sending',
    confirm_send_button: 'Confirm and send',
    review_to: 'To',
    review_amount: 'Amount',
    review_fee: 'Fee',
    review_change: 'Change',
    review_total: 'Leaves your balance',
    review_warning: 'This cannot be undone. Check that the destination address is exactly the one you were given.',
    review_inputs: 'Spends from',
    coin_one: 'coin',
    coin_many: 'coins',
    address_one: 'address',
    address_many: 'addresses',
    review_merge_warning: 'This payment merges {addresses} of your addresses into a single transaction, which publishes on-chain that they share one owner. It happens because no single address held enough for this amount.',
    review_dust_skipped: 'Left out {count} very small coins ({sats} sats): spending them would cost more in fees than they are worth.',
    password_too_short: 'Password must be at least 8 characters.',
    password_mismatch: 'Passwords do not match.',
    password_confirm_label: 'Repeat password',
    password_confirm_placeholder: 'Repeat your password',
    show_password: 'Show',
    hide_password: 'Hide',
    rotating: 'Rotating...',
    circuit_done: '✓ New circuit',
    circuit_error: 'Error rotating circuit: ',
    starting_tor: 'Starting Tor...',
    tor_start_error: 'Error starting Tor: ',
    disconnecting: 'Disconnecting...',
    starting: 'Starting...',
    preparing_download: 'Preparing download...',
    tor_install_error: 'Error installing Tor: ',
    tor_first_time: 'This wallet is designed to protect your privacy by routing all traffic through the Tor network.\n\nWould you like to download and install the Tor engine now? (The official version from torproject.org will be downloaded)',
    tor_declined: 'Warning: You chose not to use Tor. The wallet will not connect to the network for extreme privacy reasons (direct mode is disabled).',
    satoshis: 'satoshis',
    price_loading: 'Loading BCH price...',
    price_waiting_tor: 'Enable Tor to load the price',
    price_establishing_network: 'Establishing network...',
    price_retrying: 'Could not load the price. Retrying...',
    price_ready: '1 BCH \u2248 {price}',
    price_ready_fallback: '1 BCH \u2248 {price} ({currency} unavailable)',
    price_unavailable: 'Price unavailable',
  }
};

const CURRENCIES = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'ARS', symbol: '$', name: 'Peso Argentino' },
  { code: 'BRL', symbol: 'R$', name: 'Real' },
  { code: 'MXN', symbol: '$', name: 'Peso Mexicano' },
  { code: 'CLP', symbol: '$', name: 'Peso Chileno' },
  { code: 'COP', symbol: '$', name: 'Peso Colombiano' },
  { code: 'PEN', symbol: 'S/', name: 'Sol Peruano' },
  { code: 'UYU', symbol: '$U', name: 'Peso Uruguayo' },
  { code: 'PYG', symbol: '₲', name: 'Guaraní' },
  { code: 'BOB', symbol: 'Bs', name: 'Boliviano' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'JPY', symbol: '¥', name: 'Yen' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
];

let _lang = localStorage.getItem('ghost-lang') || 'es';
let _currency = localStorage.getItem('ghost-currency') || 'USD';
let _bchPrices = null;
let _priceMeta = null;
let _priceTimestamp = 0;

function t(key, params) {
  let str = (TRANSLATIONS[_lang] && TRANSLATIONS[_lang][key]) || TRANSLATIONS['es'][key] || key;
  if (params) {
    Object.keys(params).forEach(function(k) {
      str = str.split('{' + k + '}').join(String(params[k]));
    });
  }
  return str;
}

function getLang() { return _lang; }
function getCurrency() { return _currency; }

function getCurrencyInfo(code) {
  var target = code || _currency;
  return CURRENCIES.find(function(c) { return c.code === target; }) || CURRENCIES[0];
}

function setLang(lang) {
  _lang = lang;
  localStorage.setItem('ghost-lang', lang);
  applyTranslations();
}

function setCurrency(cur) {
  _currency = cur;
  localStorage.setItem('ghost-currency', cur);
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    el.title = t(el.dataset.i18nTitle);
  });
  document.documentElement.lang = _lang;
}

function setBchPrices(payload) {
  if (payload && payload.prices) {
    _bchPrices = payload.prices;
    _priceMeta = payload;
    _priceTimestamp = payload.updatedAt || Date.now();
  } else {
    _bchPrices = payload || null;
    _priceMeta = null;
    _priceTimestamp = Date.now();
  }
}

function getBchPricesCached() {
  if (!_bchPrices) return null;
  if (Date.now() - _priceTimestamp > 5 * 60 * 1000) return null;
  return _bchPrices;
}

function getBchPriceForCurrency(code) {
  var prices = getBchPricesCached();
  if (!prices) return null;
  var selected = String(code || _currency).toLowerCase();
  if (prices[selected]) {
    return { code: selected.toUpperCase(), price: prices[selected], fallback: false };
  }
  if (prices.usd) {
    return { code: 'USD', price: prices.usd, fallback: selected !== 'usd' };
  }
  return null;
}

function formatMoney(value, code) {
  var upper = String(code || _currency).toUpperCase();
  var info = getCurrencyInfo(upper);
  var maxDecimals = upper === 'JPY' || upper === 'PYG' || upper === 'CLP' || upper === 'COP' ? 0 : 2;
  var minVisible = maxDecimals === 0 ? 1 : 0.01;
  if (value > 0 && value < minVisible) {
    var minFormatted = minVisible.toLocaleString(undefined, {
      minimumFractionDigits: maxDecimals,
      maximumFractionDigits: maxDecimals
    });
    return '< ' + info.symbol + minFormatted + ' ' + upper;
  }
  var formatted = Number(value).toLocaleString(undefined, {
    minimumFractionDigits: maxDecimals,
    maximumFractionDigits: maxDecimals
  });
  return info.symbol + formatted + ' ' + upper;
}

function fmtFiat(sats) {
  var quote = getBchPriceForCurrency(_currency);
  if (!quote) return '';
  var bch = sats / 1e8;
  return '\u2248 ' + formatMoney(bch * quote.price, quote.code);
}

function fmtPricePerBch() {
  var quote = getBchPriceForCurrency(_currency);
  if (!quote) return '';
  return formatMoney(quote.price, quote.code);
}

function getDisplayedPriceCode() {
  var quote = getBchPriceForCurrency(_currency);
  return quote ? quote.code : _currency;
}

function isUsingFallbackPrice() {
  var quote = getBchPriceForCurrency(_currency);
  return !!(quote && quote.fallback);
}

function getPriceSource() {
  return _priceMeta && _priceMeta.source ? _priceMeta.source : '';
}
