// Comparacion de respuestas de varios servidores Electrum.
//
// Por que existe: un servidor Electrum ve tu direccion y te dice cuanta plata
// tenes. Si miente, la wallet no tiene forma de darse cuenta sola — el saldo no
// esta firmado por nadie. La defensa barata es preguntarle a varios operadores
// distintos y exigir que coincidan.
//
// Todo lo de aca es logica pura, sin red: entra un array de respuestas, sale un
// veredicto. Asi se puede testear con vectores fijos.
//
// El problema real no es comparar, es no gritar por diferencias legitimas:
//
//   - Desfase de altura: un servidor puede ir un bloque adelantado. Los datos
//     con altura se recortan a una altura comun antes de comparar.
//   - Mempool: lo no confirmado se propaga desparejo por la red. Nunca entra
//     en la comparacion estricta. Para firmar tiene su propia regla —lo ven
//     QUORUM_MIN operadores o no entra—, porque en BCH no hay RBF y el 0-conf
//     es gastable por diseño: exigirle consenso estricto seria confundir la
//     propagacion con un desacuerdo y dejar la plata inmovil.

// Operadores que deben coincidir para dar un dato por verificado.
const QUORUM_MIN = 2;

// Marca de altura que Electrum usa para lo que todavia no esta en un bloque:
// 0 en el mempool, -1 si ademas depende de un padre sin confirmar. Las dos
// quedan por debajo de la linea, que es lo unico que hace falta distinguir.
const HEIGHT_MEMPOOL = 0;

function isConfirmed(height) {
  return typeof height === 'number' && height > HEIGHT_MEMPOOL;
}

// Altura de corte: la mas baja que reporto algun operador. Comparar por debajo
// de esa linea hace que un servidor adelantado no cuente como discrepancia.
function commonCutoffHeight(heights) {
  const valid = (heights || []).filter(h => typeof h === 'number' && h > 0);
  return valid.length ? Math.min(...valid) : 0;
}

// --- Huellas: convierten una respuesta en un string comparable ---

// Saldo: solo lo confirmado. El unconfirmed viene del mempool y diverge sin que
// nadie este mintiendo.
function balanceFingerprint(balance) {
  return String((balance && balance.confirmed) || 0);
}

// UTXOs: los confirmados hasta el corte, ordenados para que el orden en que los
// devuelve cada servidor no cambie la huella.
function utxoFingerprint(utxos, cutoffHeight) {
  return (utxos || [])
    .filter(u => isConfirmed(u.height) && u.height <= cutoffHeight)
    .map(u => `${u.tx_hash}:${u.tx_pos}:${u.value}`)
    .sort()
    .join('|');
}

// Historial: mismo criterio que UTXOs.
function historyFingerprint(entries, cutoffHeight) {
  return (entries || [])
    .filter(e => isConfirmed(e.height) && e.height <= cutoffHeight)
    .map(e => `${e.tx_hash}:${e.height}`)
    .sort()
    .join('|');
}

// --- Votacion ---

// responses: [{ operator, value, height }]
// Devuelve el grupo mas votado y quien quedo afuera.
//
// Un operador vale un voto aunque tenga varios hostnames: si el mismo dueño
// corre dos servidores, mentir en los dos le cuesta lo mismo que en uno.
function tally(responses, fingerprintOf) {
  const groups = new Map();

  for (const r of responses) {
    const fingerprint = fingerprintOf(r);
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(r);
  }

  let winner = null;
  for (const [fingerprint, members] of groups) {
    if (!winner || members.length > winner.members.length) {
      winner = { fingerprint, members };
    }
  }

  if (!winner) return { winner: null, agreedBy: [], dissentBy: [], groups: 0 };

  const dissentBy = responses
    .filter(r => !winner.members.includes(r))
    .map(r => ({ operator: r.operator, fingerprint: fingerprintOf(r) }));

  return {
    winner,
    agreedBy: winner.members.map(r => r.operator),
    dissentBy,
    groups: groups.size,
  };
}

// Envoltorio comun: corre la votacion y arma el veredicto que consume la wallet.
//
// `verified` es la unica bandera que importa aguas arriba:
//   true  -> al menos QUORUM_MIN operadores independientes dijeron lo mismo
//   false -> o respondio muy poca gente, o los que respondieron se contradicen
function resolve(responses, fingerprintOf, pickValue) {
  if (!responses || responses.length === 0) {
    return {
      value: null,
      verified: false,
      reason: 'sin-respuestas',
      agreedBy: [],
      dissentBy: [],
      queried: 0,
    };
  }

  const { winner, agreedBy, dissentBy } = tally(responses, fingerprintOf);
  const enoughVotes = agreedBy.length >= QUORUM_MIN;
  const noDissent = dissentBy.length === 0;

  let reason = null;
  if (!enoughVotes) reason = responses.length < QUORUM_MIN ? 'pocos-operadores' : 'sin-mayoria';
  else if (!noDissent) reason = 'discrepancia';

  return {
    value: pickValue(winner.members),
    verified: enoughVotes && noDissent,
    reason,
    agreedBy,
    dissentBy,
    queried: responses.length,
  };
}

// --- Entradas publicas, una por tipo de consulta ---

// Saldo. El confirmado sale del consenso; el no confirmado NO se vota: se toma
// el mas conservador (el menor) para no mostrar plata que quiza no llegue.
function resolveBalance(responses) {
  const verdict = resolve(
    responses,
    r => balanceFingerprint(r.value),
    members => ({
      confirmed: members[0].value.confirmed || 0,
      unconfirmed: Math.min(...members.map(m => m.value.unconfirmed || 0)),
    })
  );
  return verdict;
}

// UTXOs que vieron al menos QUORUM_MIN operadores distintos, con el mismo
// outpoint y el mismo monto, sin importar a que altura los reporte cada uno.
//
// No entran en la votacion del fingerprint a proposito. Dos operadores difieren
// sobre una moneda reciente porque uno todavia no la recibio o todavia no
// proceso el bloque, no porque alguien mienta; meter eso en la comparacion
// estricta convertiria la propagacion normal en una discrepancia. Se cuentan
// aparte: que dos operadores independientes vean el mismo outpoint por el mismo
// monto ya dice que existe, que es lo unico que hacia falta saber.
//
// Para el mempool esto alcanza porque en BCH no hay RBF: una tx sin confirmar
// no se puede reemplazar por otra que pague mas, asi que el 0-conf es parte del
// diseño de la red y no una apuesta.
//
// Y la misma regla tapa un agujero que tenia el recorte por altura: una moneda
// del mempool que dos operadores veian era gastable, pero apenas la minaban —si
// justo un operador iba un bloque atras— se caia del lado confirmado por estar
// arriba del corte y dejaba de poder gastarse. Confirmarse la volvia menos
// gastable, que es exactamente al reves. Contar avistajes no distingue entre
// "esta en el mempool" y "esta en un bloque que vos todavia no viste": las dos
// son la misma moneda vista por dos testigos.
//
// Se cuenta por operador, no por respuesta: dos hosts del mismo dueño son un
// testigo, igual que en tally().
function utxosConQuorum(responses) {
  const vistos = new Map();

  for (const r of responses) {
    for (const u of r.value || []) {
      const clave = `${u.tx_hash}:${u.tx_pos}:${u.value}`;
      if (!vistos.has(clave)) vistos.set(clave, { utxo: u, operadores: new Set() });
      vistos.get(clave).operadores.add(r.operator);
    }
  }

  return [...vistos.values()]
    .filter(v => v.operadores.size >= QUORUM_MIN)
    .map(v => v.utxo);
}

// UTXOs con los que se puede firmar: los confirmados que pasaron el consenso,
// mas los que vieron QUORUM_MIN operadores aunque no coincidan en la altura.
//
// La votacion no cambia: sigue comparando lo confirmado hasta la altura comun,
// y si ahi hay una discrepancia el veredicto sale sin verificar y getUtxos()
// no firma nada. Lo que cambia es que el VALOR no se limita a ese recorte, que
// era mas angosto que la evidencia disponible.
//
// Sumar avistajes no afloja la vara: una moneda inventada sigue necesitando dos
// operadores independientes que la sostengan, igual que todo lo demas aca, y
// una inventada por debajo del corte ademas rompe el fingerprint y corta la
// firma entera.
//
// Nota sobre el caso raro de un solo operador conectado: ahi nada llega a
// QUORUM_MIN y no entra ningun UTXO. No hace falta un caso especial porque con
// un operador no se firma NADA: resolve() marca `pocos-operadores`, `verified`
// sale en false y getUtxos() corta antes de mirar esta lista. La regla hereda
// el piso que ya existia, no lo baja.
function resolveUtxos(responses) {
  const cutoffHeight = commonCutoffHeight(responses.map(r => r.height));
  const conQuorum = utxosConQuorum(responses);
  const verdict = resolve(
    responses,
    r => utxoFingerprint(r.value, cutoffHeight),
    members => {
      const votados = (members[0].value || []).filter(
        u => isConfirmed(u.height) && u.height <= cutoffHeight
      );
      const porOutpoint = new Map();
      for (const u of [...votados, ...conQuorum]) {
        porOutpoint.set(`${u.tx_hash}:${u.tx_pos}:${u.value}`, u);
      }
      return [...porOutpoint.values()];
    }
  );
  verdict.cutoffHeight = cutoffHeight;
  verdict.sinConfirmar = conQuorum.filter(u => !isConfirmed(u.height)).length;
  return verdict;
}

// Historial. La comparacion es la misma que en UTXOs —solo lo confirmado hasta
// el corte—, pero el valor que devuelve NO es ese recorte: es todo lo que vio
// el grupo ganador, unido y sin repetidos.
//
// La diferencia importa, y costo un bug: el corte existe para que un operador
// atrasado no cuente como discrepancia, no para borrar datos de la respuesta.
// Cuando la tx mas reciente cae por encima del corte —el que ya proceso el
// bloque la reporta a esa altura, el que no la sigue viendo en el mempool— el
// recorte la dejaba afuera de las dos listas y el historial volvia vacio. Una
// direccion recien estrenada quedaba indistinguible de una sin usar, y quien
// use eso para no preguntar el saldo (el barrido HD) muestra la billetera en
// cero teniendo fondos.
//
// Se unen los miembros en vez de tomar el primero por el mismo motivo: arriba
// del corte discrepan de forma legitima, y quedarse con uno cualquiera tira lo
// que vieron los otros. Unir no abre la puerta a transacciones inventadas
// abajo del corte —ahi el fingerprint no perdona y el que miente no entra al
// grupo ganador—; arriba del corte, lo peor que puede colar un operador es una
// tx de mas, que se ve como pendiente y hace que preguntemos un saldo. Firmar
// no pasa por aca: getUtxos() compara aparte y es fail-closed.
function resolveHistory(responses) {
  const cutoffHeight = commonCutoffHeight(responses.map(r => r.height));
  const verdict = resolve(
    responses,
    r => historyFingerprint(r.value, cutoffHeight),
    members => unirHistoriales(members.map(m => m.value))
  );
  verdict.cutoffHeight = cutoffHeight;
  return verdict;
}

// Une los historiales de varios operadores en una sola lista sin repetidos.
//
// Cuando la misma tx viene con dos alturas distintas gana la confirmada: es la
// version mas informativa y la unica con la que despues se puede pedir una
// prueba de inclusion. Si esa altura fuera mentira, la prueba no cierra y se
// nota; al reves —dar por pendiente algo que ya esta en un bloque— no se nota.
function unirHistoriales(historiales) {
  const porTx = new Map();
  for (const entries of historiales) {
    for (const e of entries || []) {
      const previa = porTx.get(e.tx_hash);
      if (!previa || (!isConfirmed(previa.height) && isConfirmed(e.height))) {
        porTx.set(e.tx_hash, e);
      }
    }
  }
  return [...porTx.values()];
}

// Mensaje para el usuario. La wallet no puede decir "algo anda mal" y dejarlo
// ahi: tiene que decir que vio y con quien.
function describeVerdict(verdict) {
  if (verdict.verified) {
    return `Verificado por ${verdict.agreedBy.length} operadores: ${verdict.agreedBy.join(', ')}.`;
  }
  switch (verdict.reason) {
    case 'sin-respuestas':
      return 'Ningun servidor respondio.';
    case 'pocos-operadores':
      return `Solo respondio ${verdict.queried} operador. Hacen falta ${QUORUM_MIN} para verificar el dato.`;
    case 'sin-mayoria':
      return `Los ${verdict.queried} servidores consultados dieron respuestas distintas entre si.`;
    case 'discrepancia':
      return `${verdict.agreedBy.length} operadores coinciden (${verdict.agreedBy.join(', ')}) pero ` +
             `${verdict.dissentBy.length} responde distinto: ${verdict.dissentBy.map(d => d.operator).join(', ')}.`;
    default:
      return 'Estado de verificacion desconocido.';
  }
}

module.exports = {
  QUORUM_MIN,
  commonCutoffHeight,
  balanceFingerprint,
  utxoFingerprint,
  historyFingerprint,
  utxosConQuorum,
  tally,
  resolveBalance,
  resolveUtxos,
  resolveHistory,
  describeVerdict,
};
