// Prueba de conectividad con la red BCH (servidores Fulcrum).
// Valida ademas el calculo del "scripthash" comparando dos formas de
// preguntar el saldo: por scripthash (lo que calculamos nosotros) y por
// address (lo calcula el servidor). Si coinciden, nuestro calculo es correcto.

import { ElectrumClient } from '@electrum-cash/network';
import { cashAddressToLockingBytecode, sha256, binToHex } from '@bitauth/libauth';

function addressToScripthash(address) {
  const res = cashAddressToLockingBytecode(address);
  if (typeof res === 'string') throw new Error('addr invalida: ' + res);
  const hash = sha256.hash(res.bytecode);
  return binToHex(hash.slice().reverse());
}

const servers = [
  ['bch.imaginary.cash', 50004],
  ['fulcrum.fountainhead.cash', 50004],
  ['bch.loping.net', 50004],
  ['blackie.c3-soft.com', 50004],
];

// Direccion conocida (clave privada = 1, comprimida).
const addr = 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h';
const sh = addressToScripthash(addr);
console.log('direccion :', addr);
console.log('scripthash:', sh);

for (const [host, port] of servers) {
  let client;
  try {
    console.log(`\nProbando ${host}:${port} ...`);
    client = new ElectrumClient('BCHWallet', '1.4.1', host, { port, timeout: 8000 });
    await client.connect();

    const bySh = await client.request('blockchain.scripthash.get_balance', sh);
    if (bySh instanceof Error) throw bySh;
    let byAddr;
    try {
      byAddr = await client.request('blockchain.address.get_balance', addr);
      if (byAddr instanceof Error) byAddr = '(no soportado por este server)';
    } catch { byAddr = '(no soportado)'; }

    console.log('  saldo por scripthash:', JSON.stringify(bySh));
    console.log('  saldo por address   :', JSON.stringify(byAddr));
    await client.disconnect();
    console.log('  >>> CONEXION OK con', host);
    process.exit(0);
  } catch (e) {
    console.log('  fallo:', e && e.message ? e.message : String(e));
    try { if (client) await client.disconnect(); } catch {}
  }
}
console.log('\nNingun servidor respondio.');
process.exit(1);
