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
//     en la comparacion estricta.

// Operadores que deben coincidir para dar un dato por verificado.
const QUORUM_MIN = 2;

// Marcas de altura que Electrum usa para lo que todavia no esta en un bloque.
const HEIGHT_MEMPOOL = 0;
const HEIGHT_UNCONFIRMED_PARENT = -1;

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

// UTXOs. Devuelve solo los confirmados que pasaron el consenso: son los unicos
// con los que tiene sentido firmar una transaccion.
function resolveUtxos(responses) {
  const cutoffHeight = commonCutoffHeight(responses.map(r => r.height));
  const verdict = resolve(
    responses,
    r => utxoFingerprint(r.value, cutoffHeight),
    members => (members[0].value || []).filter(
      u => isConfirmed(u.height) && u.height <= cutoffHeight
    )
  );
  verdict.cutoffHeight = cutoffHeight;
  return verdict;
}

// Historial. Igual que UTXOs, pero conserva las entradas de mempool del grupo
// ganador al final: sirven para mostrar "pendiente" en la UI sin afirmar nada.
function resolveHistory(responses) {
  const cutoffHeight = commonCutoffHeight(responses.map(r => r.height));
  const verdict = resolve(
    responses,
    r => historyFingerprint(r.value, cutoffHeight),
    members => {
      const confirmed = (members[0].value || []).filter(
        e => isConfirmed(e.height) && e.height <= cutoffHeight
      );
      const pending = (members[0].value || []).filter(
        e => e.height === HEIGHT_MEMPOOL || e.height === HEIGHT_UNCONFIRMED_PARENT
      );
      return [...confirmed, ...pending];
    }
  );
  verdict.cutoffHeight = cutoffHeight;
  return verdict;
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
  tally,
  resolveBalance,
  resolveUtxos,
  resolveHistory,
  describeVerdict,
};
