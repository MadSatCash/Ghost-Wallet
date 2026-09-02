// Seleccion de monedas: que UTXOs entran en una transaccion y cuales no.
//
// El problema no es de plata, es de privacidad. Firmar varios inputs juntos
// publica on-chain que todas esas direcciones son del mismo dueño: es la
// heuristica mas vieja y mas confiable del analisis de cadena. Barrer la wallet
// entera en cada envio ata todo el historial de una sola vez.
//
// La regla, la misma que usan Electrum y Electron Cash: los UTXOs se agrupan
// por direccion y se gasta de UNA sola direccion siempre que alcance. Recien si
// ninguna alcanza se suman mas, de a una, y el costo de privacidad se le avisa
// al usuario antes de firmar.
//
// El grupo de una direccion se gasta entero. Gastar la mitad no protege nada:
// al firmar ya revelaste que esa direccion es tuya, y dejar el resto adentro
// solo fragmenta la wallet.

// Tamaños en bytes de una tx P2PKH. Un input lleva firma (~72) + pubkey (33) +
// el outpoint; un output, el script mas el monto.
const BASE_SIZE = 10;
const INPUT_SIZE = 149;
const OUTPUT_SIZE = 34;

// Por debajo de esto la red no acepta una salida.
const DUST_LIMIT = 546;

// NO hay tope propio de entradas por transaccion, y no hay que reintroducirlo.
// Electrum y Electron Cash tampoco lo tienen: agrupan por direccion igual que
// aca, pero el borde se lo deja al tamaño maximo de transaccion que aceptan los
// nodos, no a un contador inventado. Un tope propio rechaza envios que la red
// si acepta, y se los presenta al usuario como si el limite fuera de la red.
//
// La defensa de privacidad no la daba ese numero: la da la estructura de
// abajo —una sola direccion cuando alcanza, union de mayor a menor cuando no—
// mas el aviso de `merged` antes de firmar.

function txSize(inputCount, outputCount) {
  return BASE_SIZE + inputCount * INPUT_SIZE + outputCount * OUTPUT_SIZE;
}

function estimateFee(inputCount, outputCount, feeRate = 1) {
  return Math.ceil(txSize(inputCount, outputCount) * feeRate);
}

// Lo que cuesta gastar un UTXO, sin importar cuanto tenga adentro.
function inputCost(feeRate = 1) {
  return Math.ceil(INPUT_SIZE * feeRate);
}

// Un UTXO que vale menos de lo que cuesta gastarlo RESTA: incluirlo agranda la
// transaccion mas de lo que aporta. Ademas es la forma tipica del dust attack —
// te mandan polvo a una direccion para que vos mismo lo unas al resto de tus
// fondos. No se gastan automaticamente nunca.
function isProfitable(utxo, feeRate = 1) {
  return utxo.value > inputCost(feeRate);
}

// Agrupa por direccion. Cada grupo es la unidad indivisible de la seleccion.
function groupByAddress(utxos) {
  const porDireccion = new Map();
  for (const u of utxos) {
    if (!porDireccion.has(u.address)) {
      porDireccion.set(u.address, { address: u.address, utxos: [], total: 0 });
    }
    const grupo = porDireccion.get(u.address);
    grupo.utxos.push(u);
    grupo.total += u.value;
  }
  return Array.from(porDireccion.values());
}

// Calcula comision y cambio para un conjunto de entradas ya elegido.
//
// Dos escenarios: si sobra lo suficiente para una salida de cambio, se paga la
// comision de dos salidas y el resto vuelve; si el resto quedaria por debajo
// del dust —que la red no aceptaria— se va todo en comision y la tx tiene una
// sola salida.
function planFor(selected, amountSats, feeRate = 1) {
  const n = selected.length;
  const totalIn = selected.reduce((s, u) => s + u.value, 0);

  const feeConCambio = estimateFee(n, 2, feeRate);
  const cambio = totalIn - amountSats - feeConCambio;

  if (cambio >= DUST_LIMIT) {
    return { ok: true, feeSats: feeConCambio, changeSats: cambio, totalIn, inputCount: n };
  }

  const feeSinCambio = estimateFee(n, 1, feeRate);
  if (totalIn < amountSats + feeSinCambio) {
    return { ok: false, feeSats: feeSinCambio, changeSats: 0, totalIn, inputCount: n };
  }
  // El remanente por debajo del dust no se puede devolver: se va en comision.
  return { ok: true, feeSats: totalIn - amountSats, changeSats: 0, totalIn, inputCount: n };
}

// Elige que UTXOs gastar para enviar `amountSats`.
//
// Devuelve { inputs, feeSats, changeSats, totalIn, inputCount, addressCount,
//            skipped, merged }, donde `skipped` son los UTXOs descartados por
// no rentables y `merged` dice si hubo que unir mas de una direccion — lo que
// la UI tiene que avisar antes de que el usuario firme.
//
// Tira error solo si de verdad no alcanza el saldo.
function selectCoins({ utxos, amountSats, feeRate = 1 }) {
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error('No hay fondos suficientes (0 UTXOs).');
  }
  if (!Number.isInteger(amountSats) || amountSats < DUST_LIMIT) {
    throw new Error('El monto a enviar esta por debajo del limite dust de la red (546 sats).');
  }

  const rentables = utxos.filter(u => isProfitable(u, feeRate));
  const skipped = utxos.filter(u => !isProfitable(u, feeRate));

  if (rentables.length === 0) {
    throw new Error(
      'Los fondos disponibles estan en montos tan chicos que gastarlos costaria ' +
      'mas comision de lo que valen.'
    );
  }

  const grupos = groupByAddress(rentables);

  // Fase 1: una sola direccion. Entre las que alcanzan solas, la que use menos
  // entradas —menos comision y menos huella— y a igualdad, la mas chica, para
  // no romper una moneda grande cuando una chica hace el mismo trabajo.
  // El desempate por direccion no es cosmetico: los UTXOs llegan de consultas
  // en paralelo, asi que su orden puede cambiar entre la pantalla de
  // confirmacion y el envio. Sin un criterio total, dos grupos identicos
  // podrian elegirse distinto en cada llamada y el usuario terminaria firmando
  // algo que no es lo que aprobo.
  const solitarios = grupos
    .map(g => ({
      address: g.address,
      seleccion: g.utxos,
      plan: planFor(g.utxos, amountSats, feeRate),
    }))
    .filter(c => c.plan.ok)
    .sort((a, b) =>
      a.seleccion.length - b.seleccion.length ||
      a.plan.totalIn - b.plan.totalIn ||
      (a.address < b.address ? -1 : 1)
    );

  if (solitarios.length > 0) {
    const elegido = solitarios[0];
    return {
      inputs: elegido.seleccion,
      ...elegido.plan,
      addressCount: 1,
      merged: false,
      skipped,
    };
  }

  // Fase 2: no queda otra que unir direcciones. De mayor a menor, para juntar
  // el monto exponiendo la menor cantidad de direcciones posible.
  const porTamaño = grupos.slice().sort((a, b) =>
    b.total - a.total ||
    (a.address < b.address ? -1 : 1)
  );
  const acumulados = [];
  let seleccion = [];

  for (const g of porTamaño) {
    acumulados.push(g);
    seleccion = seleccion.concat(g.utxos);
    const plan = planFor(seleccion, amountSats, feeRate);
    if (plan.ok) {
      return {
        inputs: seleccion,
        ...plan,
        addressCount: acumulados.length,
        merged: acumulados.length > 1,
        skipped,
      };
    }
  }

  // Llegar aca es no poder cubrir el monto: se probaron TODAS las direcciones.
  const totalRentable = rentables.reduce((s, u) => s + u.value, 0);
  const totalDescartado = skipped.reduce((s, u) => s + u.value, 0);

  let mensaje = 'No alcanza el saldo para cubrir el monto mas la comision de red.';
  if (totalDescartado > 0) {
    mensaje += ' Quedaron afuera ' + skipped.length + ' monedas por ' + totalDescartado +
      ' sats, que cuestan mas comision de lo que valen.';
  }
  throw new Error(mensaje + ' Disponible gastable: ' + totalRentable + ' sats.');
}

// Cuanto se puede enviar vaciando la wallet: todas las monedas rentables, una
// sola salida, sin cambio. Barrer es explicito aca —es la operacion que el
// usuario pidio— pero se informa cuantas direcciones va a unir.
function planMaxSend({ utxos, feeRate = 1 }) {
  const rentables = (utxos || []).filter(u => isProfitable(u, feeRate));
  const skipped = (utxos || []).filter(u => !isProfitable(u, feeRate));
  const seleccion = rentables;

  const totalIn = seleccion.reduce((s, u) => s + u.value, 0);
  const feeSats = seleccion.length === 0 ? 0 : estimateFee(seleccion.length, 1, feeRate);
  let maxSats = Math.max(0, totalIn - feeSats);
  if (maxSats < DUST_LIMIT) maxSats = 0;

  return {
    maxSats,
    feeSats,
    totalSats: totalIn,
    utxoCount: seleccion.length,
    addressCount: groupByAddress(seleccion).length,
    skipped,
  };
}

module.exports = {
  BASE_SIZE,
  INPUT_SIZE,
  OUTPUT_SIZE,
  DUST_LIMIT,
  txSize,
  estimateFee,
  inputCost,
  isProfitable,
  groupByAddress,
  planFor,
  selectCoins,
  planMaxSend,
};
