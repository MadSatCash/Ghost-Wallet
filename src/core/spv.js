// Verificacion SPV de transacciones.
//
// Responde una sola pregunta, pero la responde sin creerle a nadie:
// ¿esta esta transaccion realmente en el bloque que dicen?
//
// Como: un bloque agrupa sus transacciones en un arbol de hashes, y la raiz de
// ese arbol —el merkle root— va adentro de la cabecera. El servidor manda los
// hashes hermanos del camino desde la transaccion hasta la raiz; hasheando para
// arriba se llega al root, o no se llega.
//
// Lo importante es de donde sale el root con el que se compara. Si saliera del
// mismo servidor que manda la prueba, no se verifico nada: te da una cabecera
// falsa, un root falso, y una rama coherente con la mentira. Aca el root sale de
// chain.js, o sea de una cabecera con proof-of-work y dificultad ASERT ya
// verificados. Por eso el proof vale.
//
// Consecuencia practica: la prueba se le puede pedir a UN solo servidor. Una
// prueba adulterada no reconstruye el root y se detecta sola.

const chain = require('./chain');

// Reconstruye el merkle root subiendo por la rama.
//
// `pos` es el indice de la transaccion dentro del bloque, y su bit menos
// significativo dice de que lado va el hermano en cada nivel.
function merkleRootFromProof(txid, pos, branch) {
  let hash = Buffer.from(txid, 'hex').reverse();
  let index = pos;

  for (const hermanoHex of branch) {
    const hermano = Buffer.from(hermanoHex, 'hex').reverse();
    hash = (index & 1)
      ? chain.sha256d(Buffer.concat([hermano, hash]))
      : chain.sha256d(Buffer.concat([hash, hermano]));
    index >>= 1;
  }

  return Buffer.from(hash).reverse().toString('hex');
}

// proof: lo que devuelve blockchain.transaction.get_merkle,
//        { merkle: [hex...], block_height, pos }
//
// Devuelve { verified, reason, detail }. `verified` en true significa que la
// transaccion esta en un bloque de la cadena con proof-of-work verificado.
function verifyTransaction(txid, height, proof) {
  if (!proof || !Array.isArray(proof.merkle) || typeof proof.pos !== 'number') {
    return {
      verified: false,
      reason: 'prueba-invalida',
      detail: 'El servidor no devolvio una prueba de inclusion utilizable.',
    };
  }

  if (proof.block_height !== undefined && proof.block_height !== height) {
    return {
      verified: false,
      reason: 'altura-discrepante',
      detail: `La prueba dice bloque ${proof.block_height} pero el historial dice ${height}.`,
    };
  }

  const rootVerificado = chain.merkleRootAt(height);
  if (!rootVerificado) {
    return {
      verified: false,
      reason: 'sin-cabecera',
      detail: `Todavia no tengo verificada la cabecera del bloque ${height}.`,
    };
  }

  const rootCalculado = merkleRootFromProof(txid, proof.pos, proof.merkle);
  if (rootCalculado !== rootVerificado) {
    return {
      verified: false,
      reason: 'no-coincide',
      detail: `La prueba reconstruye ${rootCalculado.slice(0, 16)}… pero la cabecera ` +
              `verificada dice ${rootVerificado.slice(0, 16)}…. La transaccion no esta en ese bloque.`,
    };
  }

  return {
    verified: true,
    reason: null,
    detail: `Incluida en el bloque ${height}, verificado por proof-of-work.`,
  };
}

module.exports = {
  merkleRootFromProof,
  verifyTransaction,
};
