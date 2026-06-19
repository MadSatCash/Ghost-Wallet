# Ghost Wallet 👻

**Privacy by default. Leave no network trace.**

Ghost Wallet es una billetera SPV (Simplified Payment Verification) para Bitcoin Cash (BCH) construida con Electron y diseñada desde cero con una filosofía de **privacidad extrema**.

A diferencia de las billeteras tradicionales que filtran la dirección IP del usuario a los servidores públicos al consultar saldos, Ghost Wallet integra el motor de red **Tor** de forma nativa e invisible.

## Características Principales

*   **🕵️‍♂️ Privacidad de Red (Tor Integrado):** Todo el tráfico de red de la billetera viaja forzosamente a través de la red Tor mediante un SOCKS5 Proxy local. El demonio de Tor se gestiona automáticamente.
*   **🛡️ Fail-Closed por defecto:** La billetera bloquea matemáticamente cualquier intento de conexión directa a Internet (ClearNet). Si Tor no está disponible, la billetera simplemente no se conecta.
*   **🔄 Rotación de Circuitos:** Permite forzar un "Nuevo Circuito" (`SIGNAL NEWNYM`) para cambiar la identidad de red al instante sin tener que reiniciar la app.
*   **🔒 Criptografía Local:** Las claves privadas (Frases semilla BIP39 o Secretos Crudos Hexadecimales) nunca abandonan la computadora. La firma de transacciones se realiza de forma 100% offline.
*   **⚙️ Nodos Fulcrum (SPV):** Utiliza la potente librería `@electrum-cash/network` para interactuar con servidores públicos SPV de forma descentralizada.
*   **💾 Encriptación AES-256-GCM:** Todas tus billeteras se almacenan localmente encriptadas con contraseña.

## Instalación y Uso

### Prerrequisitos
*   [Node.js](https://nodejs.org/) (v16 o superior recomendado)
*   NPM (viene incluido con Node.js)

### Instrucciones

1. Cloná este repositorio:
   ```bash
   git clone https://github.com/TU-USUARIO/ghost-wallet.git
   cd ghost-wallet
   ```

2. Instalá las dependencias:
   ```bash
   npm install
   ```

3. Compilá los estilos (CSS):
   ```bash
   npm run build:css
   ```

4. Ejecutá la billetera:
   ```bash
   npm start
   ```

## Arquitectura de Seguridad
La billetera implementa varias protecciones contra ataques laterales y filtraciones de metadatos:
*   **CookieAuthentication:** El ControlPort de Tor requiere autenticación por cookie de 32 bytes, impidiendo que procesos locales maliciosos controlen el circuito.
*   **Socks5h:** La resolución DNS se realiza en el nodo de salida de Tor (remote DNS resolution), evitando fugas de DNS.
*   **Content-Security-Policy estricta:** La UI bloquea recursos externos o scripts cruzados.
*   **Bloqueo de Navegación:** El proceso principal de Electron previene la apertura de links en el navegador externo por accidente.

## Contribuir
Cualquier auditoría de seguridad o *Pull Request* es bienvenido. Al ser un software que maneja criptomonedas, la revisión de código por parte de la comunidad es el pilar más importante.

---
*Disclaimer: Este software se provee "tal cual". Usalo bajo tu propia responsabilidad.*
