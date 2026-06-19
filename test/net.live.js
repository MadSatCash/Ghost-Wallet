// Prueba EN VIVO de la capa de red (necesita internet). No corre en `npm test`.
// Correr con:  node test/net.live.js

const net = require('../src/core/network');

async function main() {
  const addr = 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h'; // clave=1, comprimida
  console.log('Consultando saldo de', addr, '...');
  const bal = await net.getBalance(addr);
  console.log('  servidor :', net.serverName());
  console.log('  confirmado:', bal.confirmed, 'sats');
  console.log('  pendiente :', bal.unconfirmed, 'sats');
  console.log('  formateado:', net.formatBch(bal.confirmed));
  if (typeof bal.confirmed !== 'number') throw new Error('saldo no numerico');
  await net.disconnect();
  console.log('\nCAPA DE RED OK');
  process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
