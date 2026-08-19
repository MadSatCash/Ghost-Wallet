// Barrido de UTXOs para firmar.
//
// Por que vive aparte de main.js: la regla que aplica —para firmar, "no se" NO
// es "no hay"— ya se rompio una vez en produccion, en silencio, y una regla asi
// necesita tests. Aca la consulta de red entra por parametro, asi que se puede
// probar con dobles y sin tocar la red.
//
// Que salio mal la primera vez: el barrido consultaba las direcciones de la
// wallet, contaba las que fallaban, y solo abortaba si los fallos pasaban la
// mitad. Con una wallet de 75 direcciones y una sola con fondos, el timeout de
// esa unica direccion contaba 1 de 75. Nunca llegaba al umbral, la lista salia
// vacia, y rio abajo se leia como "No hay fondos suficientes (0 UTXOs)".
//
// El umbral proporcional es la parte que estaba mal de raiz, no el numero: mide
// cuantas fallaron, no si fallo alguna que importaba. Y como una wallet acumula
// direcciones vacias con el uso, el techo sube con el tiempo — el fallo de la
// unica direccion con fondos se vuelve cada vez mas facil de no ver.
//
// La regla que lo reemplaza no admite grados: o se consultaron todas, o no se
// firma. Una direccion sin respuesta puede tener toda la plata de la wallet.

// Cuantas vueltas se le da a una direccion que no contesto antes de rendirse.
// Un timeout suelto por Tor es normal y se arregla reintentando; que la misma
// direccion falle tres veces seguidas ya no es ruido.
const UTXO_QUERY_ATTEMPTS = 3;

// Junta los UTXOs gastables de un conjunto de direcciones.
//
//   addresses            direcciones a consultar: { address, change, index }
//   getUtxos             (address) => Promise<utxo[]>. Si lanza con
//                        e.consensusFailure, es una discrepancia entre
//                        operadores y no se reintenta.
//   discoveryFailures    cuantas direcciones no se pudieron consultar al
//                        BUSCAR las direcciones de la wallet
//   discoveryIncomplete  true si esa busqueda se corto por tope
//
// Devuelve { utxos } con todas, o lanza. No hay resultado parcial.
async function collectSpendableUtxos({
  addresses,
  getUtxos,
  discoveryFailures = 0,
  discoveryIncomplete = false,
  attempts = UTXO_QUERY_ATTEMPTS,
}) {
  // El barrido previo decide QUE direcciones se consultan. Si quedo incompleto,
  // la lista de UTXOs puede estar perfectamente armada sobre un universo
  // equivocado, y eso no se nota mirando el resultado.
  if (discoveryFailures > 0) {
    throw new Error(
      `No se pudo consultar el historial de ${discoveryFailures} direccion(es) al buscar las de esta wallet, ` +
      'asi que la busqueda pudo haber terminado antes de tiempo y dejar fondos sin ver. No se firma nada. Reintenta.'
    );
  }
  if (discoveryIncomplete) {
    throw new Error(
      'Esta wallet tiene mas direcciones activas de las que se pueden barrer de una vez, ' +
      'asi que no se puede afirmar que estos sean todos sus fondos. No se firma nada.'
    );
  }

  const total = addresses.length;
  const utxos = [];
  const disputadas = [];
  // Direcciones que todavia no contestaron. Arranca con todas y se va vaciando.
  let pendientes = addresses;

  for (let intento = 1; intento <= attempts && pendientes.length > 0; intento++) {
    const fallaron = [];

    await Promise.all(pendientes.map(async (a) => {
      try {
        const u = await getUtxos(a.address);
        if (u && u.length > 0) {
          u.forEach(x => utxos.push({ ...x, address: a.address, change: a.change, index: a.index }));
        }
      } catch (e) {
        // Discrepancia entre operadores != timeout. La primera no se arregla
        // reintentando y el usuario tiene que verla; la segunda si.
        if (e && e.consensusFailure) disputadas.push({ address: a.address, detail: e.message });
        else fallaron.push(a);
      }
    }));

    // Una discrepancia no mejora reintentando: cortar ya y mostrarla.
    if (disputadas.length > 0) break;
    pendientes = fallaron;
  }

  if (disputadas.length > 0) {
    throw new Error(
      'Los servidores no coinciden sobre los fondos de esta wallet, asi que no se firma nada.\n\n' +
      disputadas.map(d => '· ' + d.detail).join('\n\n')
    );
  }

  if (pendientes.length > 0) {
    throw new Error(
      `No se pudieron consultar los fondos de ${pendientes.length} de ${total} direcciones ` +
      `despues de ${attempts} intentos. Cualquiera de ellas puede tener fondos, asi que no se firma nada. ` +
      'Revisa la conexion con Tor y reintenta.'
    );
  }

  return { utxos };
}

module.exports = { collectSpendableUtxos, UTXO_QUERY_ATTEMPTS };
