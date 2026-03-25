import http from 'http';
import { webcrypto } from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '.stuf-mcp.json');

function generateDeviceToken() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`);
}

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>stuf MCP Pairing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #242424; color: #e0e0e0; font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #999; margin-bottom: 1.5rem; text-align: center; }
    #reader { width: 100%; max-width: 400px; border-radius: 12px; overflow: hidden; }
    .success { color: #4ade80; font-size: 1.2rem; margin-top: 1rem; }
    .error { color: #ef4444; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>stuf MCP Pairing</h1>
  <p>Open stuf on your phone → Settings → Add Device<br>Then scan the QR code here</p>
  <div id="reader"></div>
  <div id="status"></div>

  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <script>
    const scanner = new Html5Qrcode("reader");
    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 300, height: 300 } },
      async (text) => {
        try {
          const data = JSON.parse(text);
          if (!data.url || !data.encryptionKey || !data.inviteToken) throw new Error('Invalid QR');
          scanner.stop();
          document.getElementById('status').innerHTML = '<p class="success">Pairing...</p>';
          const res = await fetch('/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          const result = await res.json();
          if (result.success) {
            document.getElementById('status').innerHTML = '<p class="success">Paired! You can close this window.</p>';
          } else {
            document.getElementById('status').innerHTML = '<p class="error">Failed: ' + result.error + '</p>';
          }
        } catch (e) {
          // Not a valid QR, ignore
        }
      }
    );
  </script>
</body>
</html>`;

export function startPairingServer() {
  return new Promise((resolve, reject) => {
    let onPaired;
    const paired = new Promise(r => { onPaired = r; });

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/pair') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { url, encryptionKey, inviteToken } = JSON.parse(body);
            const deviceToken = generateDeviceToken();

            const pairRes = await fetch(`${url}/api/pair/invite`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inviteToken, deviceToken })
            });

            if (!pairRes.ok) {
              const err = await pairRes.json().catch(() => ({}));
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: err.error || 'Pairing failed' }));
              return;
            }

            const config = {
              serverUrl: url,
              deviceToken,
              encryptionKey
            };

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));

            setTimeout(() => {
              server.close();
              onPaired(config);
            }, 1000);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, () => {
      const port = server.address().port;
      const url = `http://localhost:${port}`;
      openBrowser(url);
      resolve({ url, paired });
    });

    server.on('error', reject);
  });
}
