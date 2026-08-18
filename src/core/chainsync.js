// Sincronizacion de la cadena de cabeceras.
//
// Une las dos mitades: network.js las trae, chain.js las verifica y las guarda.
// Aca esta la parte que decide desde donde arrancar, en que tandas, y que hacer
// cuando la punta guardada deja de enganchar.
//
// Regla que ordena todo lo demas: al almacen NUNCA entra una cabecera sin
// verificar. Se baja una tanda, se verifica entera, y recien si pasa se guarda.
// Si falla, se descarta completa — no se guardan "las que estaban bien".

const chain = require('./chain');
const network = require('./network');

// Tamaño de tanda. Ni tan chico que multiplique los guardados a disco, ni tan
// grande que la primera sincronizacion no muestre progreso.
const TANDA = 20000;

// Cuanto se retrocede ante una reorg antes de rendirse y bajar todo de nuevo.
// Las reorgs reales en BCH son de uno o dos bloques; veinte es holgado.
const ROLLBACK_MAX = 20;

let _sincronizando = null;
let _estado = {
  fase: 'sin-empezar',   // sin-empezar | bajando | listo | error
  bajadas: 0,
  total: 0,
  tipVerificado: 0,
  error: null,
};

function estado() {
  return { ..._estado, ...chain.status() };
}

function setEstado(parcial) {
  _estado = { ..._estado, ...parcial };
}

// Desde donde arranca una cadena vacia.
//
// Con checkpoint, desde el checkpoint mismo: su hash esta en el codigo, asi que
// es un punto de partida que no depende de ningun servidor.
//
// Sin checkpoint hay que ir al ancla ASERT, y se arranca un bloque antes porque
// la formula necesita el timestamp del padre para el primer bloque posterior.
function alturaInicial() {
  return chain.CHECKPOINT.hash
    ? chain.CHECKPOINT.height
    : chain.ASERT_ANCHOR.height - 1;
}

// La primera cabecera de una cadena que arranca en el checkpoint tiene que ser
// EL checkpoint. Si no, lo que sirve el servidor no es la cadena que esperamos
// y no se guarda nada.
function verificarCheckpoint(headers) {
  if (!chain.CHECKPOINT.hash) return null;
  const primera = headers.subarray(0, chain.HEADER_SIZE);
  const hash = chain.headerHash(primera);
  if (hash !== chain.CHECKPOINT.hash) {
    return `El bloque ${chain.CHECKPOINT.height} que sirve la red tiene hash ${hash}, ` +
           `pero el checkpoint del codigo dice ${chain.CHECKPOINT.hash}. ` +
           `O la red esta mintiendo, o el checkpoint quedo mal.`;
  }
  return null;
}

// Sincroniza hasta la punta de la cadena.
//
// Es idempotente y no se pisa a si misma: si ya hay una corriendo, devuelve esa.
async function sync(onProgress) {
  if (_sincronizando) return _sincronizando;

  _sincronizando = (async () => {
    try {
      chain.load();

      // Lo guardado tiene que empezar donde manda el checkpoint actual. Si el
      // checkpoint cambio (git pull), lo viejo no sirve y se baja de nuevo.
      if (chain.tipHeight() > 0 && !chain.checkpointMatches()) {
        chain.reset();
      }

      const tipRed = await network.getTipHeight();
      let alturaLocal = chain.tipHeight();
      let rollbacks = 0;

      setEstado({ fase: 'bajando', error: null });

      while (true) {
        const vacia = chain.tipHeight() === 0;
        const desde = vacia ? alturaInicial() : chain.tipHeight() + 1;

        if (desde > tipRed) break;

        const hasta = Math.min(desde + TANDA - 1, tipRed);
        setEstado({ total: tipRed - desde + 1, bajadas: 0 });

        const headers = await network.getBlockHeaders(desde, hasta, (hechos, totalTramos) => {
          setEstado({ bajadas: Math.round((hechos / totalTramos) * (hasta - desde + 1)) });
          if (onProgress) onProgress(estado());
        });

        const cantidad = headers.length / chain.HEADER_SIZE;
        if (cantidad === 0) break;

        // Con la cadena vacia y checkpoint, la primera cabecera es el ancla de
        // confianza: se compara contra el hash del codigo.
        if (vacia) {
          const problema = verificarCheckpoint(headers);
          if (problema) throw new Error(problema);
        }

        // La cabecera anterior a la tanda, para encadenar y para ASERT.
        const previa = vacia ? null : chain.headerAt(desde - 1);
        const veredicto = chain.verifyHeaders(headers, desde, previa);

        if (!veredicto.ok) {
          // Si falla en la primera cabecera de una tanda incremental, lo mas
          // probable es una reorg: la punta que teniamos quedo huerfana.
          const esProbableReorg = !vacia && veredicto.checked === 0 && rollbacks < ROLLBACK_MAX;
          if (esProbableReorg) {
            rollbacks++;
            chain.truncate(1);
            continue;
          }
          throw new Error(veredicto.error);
        }

        chain.append(headers, desde);
        alturaLocal = chain.tipHeight();
        setEstado({ tipVerificado: alturaLocal });
        if (onProgress) onProgress(estado());
      }

      setEstado({ fase: 'listo', tipVerificado: chain.tipHeight(), error: null });
      return estado();
    } catch (e) {
      // Una sincronizacion fallida no rompe la wallet: se sigue con el cruce
      // entre operadores y se avisa que la verificacion por PoW no esta.
      setEstado({ fase: 'error', error: String(e.message || e) });
      return estado();
    } finally {
      _sincronizando = null;
    }
  })();

  return _sincronizando;
}

// ¿Se puede verificar por proof-of-work un bloque de esta altura?
function puedeVerificar(height) {
  return chain.hasHeight(height);
}

module.exports = {
  TANDA,
  sync,
  estado,
  alturaInicial,
  puedeVerificar,
};
