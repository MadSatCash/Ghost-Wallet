const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');
const tar = require('tar');

const TOR_VERSION = '14.0.4';
const TOR_URL = `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/tor-expert-bundle-windows-x86_64-${TOR_VERSION}.tar.gz`;
const EXPECTED_SHA256 = '2d8cd74b24cd87ba7a797b989cff7d6cd7c22ee55ab0a9ee3e99cba637af48e4';

const torDir = path.join(app.getPath('userData'), 'tor-bin');
const torExe = path.join(torDir, 'tor', 'tor.exe');
const dataDir = path.join(torDir, 'data');

let torProcess = null;
let isReady = false;

function verifyHash(filePath, expectedHash) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => {
      const result = hash.digest('hex');
      resolve(result === expectedHash);
    });
  });
}

async function downloadAndExtractTor(onProgress) {
  if (fs.existsSync(torExe)) {
    return true; // Ya existe
  }

  if (!fs.existsSync(torDir)) fs.mkdirSync(torDir, { recursive: true });

  const tarballPath = path.join(torDir, 'tor.tar.gz');
  
  return new Promise((resolve, reject) => {
    onProgress('Descargando motor de red Tor...');
    
    const file = fs.createWriteStream(tarballPath);
    https.get(TOR_URL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('Error al descargar Tor: ' + res.statusCode));
      }
      
      const totalBytes = parseInt(res.headers['content-length'], 10);
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress(`Descargando Tor... ${percent}%`);
        }
      });

      res.pipe(file);
      
      file.on('finish', async () => {
        file.close();
        onProgress('Verificando integridad (hash SHA256)...');
        
        try {
          const isValid = await verifyHash(tarballPath, EXPECTED_SHA256);
          if (!isValid) {
            throw new Error('FALLO DE SEGURIDAD: El hash SHA256 del binario de Tor descargado no coincide con el hash oficial hardcodeado. Posible ataque MITM. Descarga abortada.');
          }
          
          onProgress('Hash verificado. Extrayendo...');
          await tar.x({
            file: tarballPath,
            cwd: torDir
          });
          fs.unlinkSync(tarballPath);
          onProgress('Tor instalado correctamente.');
          resolve();
        } catch (err) {
          fs.unlink(tarballPath, () => {});
          reject(err);
        }
      });
    }).on('error', (err) => {
      fs.unlink(tarballPath, () => {});
      reject(err);
    });
  });
}

let activeSocksPort = null;
let activeControlPort = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startTor(onLog) {
  if (torProcess) {
    if (isReady) return;
    return;
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const cookiePath = path.join(dataDir, 'control_auth_cookie');

  // Buscar dos puertos libres al azar
  try {
    activeSocksPort = await getFreePort();
    activeControlPort = await getFreePort();
  } catch (e) {
    throw new Error('No se pudieron asignar puertos locales libres para Tor.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(bootstrapTimer);
      fn(val);
    }

    onLog(`Iniciando proceso Tor en puertos dinámicos SOCKS:${activeSocksPort} y Control:${activeControlPort}...`);
    torProcess = spawn(torExe, [
      '--SocksPort', `127.0.0.1:${activeSocksPort}`,
      '--ControlPort', `127.0.0.1:${activeControlPort}`,
      '--CookieAuthentication', '1',
      '--CookieAuthFile', cookiePath,
      '--DataDirectory', dataDir
    ]);

    // Timeout: si no llega a Bootstrap 100% en 60 segundos, abortar.
    const bootstrapTimer = setTimeout(() => {
      onLog('Timeout: Tor no pudo conectarse en 60 segundos.');
      stopTor();
      finish(reject, new Error('Tor no pudo conectarse a la red en 60 segundos.'));
    }, 60000);

    torProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.includes('Bootstrapped 100%')) {
        isReady = true;
        onLog('¡Conectado a la red Tor al 100%!');
        finish(resolve);
      }
    });

    torProcess.stderr.on('data', (data) => {
      onLog('Tor Error: ' + data.toString().trim());
    });

    torProcess.on('close', (code) => {
      torProcess = null;
      isReady = false;
      finish(reject, new Error('Tor se cerró inesperadamente (código ' + code + ').'));
    });

    torProcess.on('error', (err) => {
      torProcess = null;
      isReady = false;
      finish(reject, new Error('No se pudo iniciar Tor: ' + err.message));
    });
  });
}

function stopTor() {
  if (torProcess) {
    torProcess.kill();
    torProcess = null;
    isReady = false;
  }
}

// Solicitar un nuevo circuito Tor (equivalente a "New Identity").
// Lee la cookie de autenticación y la envía en formato hexadecimal
// al ControlPort antes de emitir SIGNAL NEWNYM.
// Timeout de 5 segundos. Siempre cierra el socket al terminar.
function newCircuit() {
  return new Promise((resolve, reject) => {
    if (!isReady) return reject(new Error('Tor no está conectado'));

    const cookiePath = path.join(dataDir, 'control_auth_cookie');
    let cookieHex;
    try {
      const cookieBytes = fs.readFileSync(cookiePath);
      cookieHex = cookieBytes.toString('hex');
    } catch (err) {
      return reject(new Error('No se pudo leer la cookie de autenticación de Tor: ' + err.message));
    }

    let settled = false;
    function finish(fn, val) {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      fn(val);
    }

    const net = require('net');
    const sock = net.createConnection(activeControlPort, '127.0.0.1', () => {
      sock.write(`AUTHENTICATE ${cookieHex}\r\n`);
      sock.write('SIGNAL NEWNYM\r\n');
      sock.write('QUIT\r\n');
    });

    sock.setTimeout(5000);

    let response = '';
    sock.on('data', d => response += d.toString());

    sock.on('end', () => {
      if (response.includes('250')) finish(resolve);
      else finish(reject, new Error('ControlPort rechazó el comando: ' + response.trim()));
    });

    sock.on('timeout', () => {
      finish(reject, new Error('Timeout esperando respuesta del ControlPort de Tor.'));
    });

    sock.on('error', (err) => {
      finish(reject, new Error('Error de conexión al ControlPort: ' + err.message));
    });

    sock.on('close', () => {
      // Si nadie resolvió todavía, el socket se cerró inesperadamente
      finish(reject, new Error('Conexión al ControlPort cerrada inesperadamente.'));
    });
  });
}

function isTorDownloaded() {
  return fs.existsSync(torExe);
}

module.exports = {
  downloadAndExtractTor,
  startTor,
  stopTor,
  newCircuit,
  isTorDownloaded,
  isReady: () => isReady,
  getSocksPort: () => activeSocksPort
};
