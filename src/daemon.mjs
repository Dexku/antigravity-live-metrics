import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCALES } from './i18n.mjs';
import {
  getCandidateConversationsDirs,
  getDbSignature,
  hasSqliteSupport,
  parseConversationMetrics
} from './telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.homedir(), '.antigravity-live-metrics');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');

const args = process.argv.slice(2);
const ONCE_MODE = args.includes('--once');
const UNINSTALL_MODE = args.includes('--uninstall');

const DEFAULT_CONFIG = {
  channel: 'auto',
  lang: 'auto',
  contextLimit: 256000,
  contextLimitOverride: 0
};

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function getPortCandidates(channel = 'auto') {
  const home = os.homedir();
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');

  const endpoints = [];
  if (channel !== 'insiders') {
    endpoints.push({
      channel: 'stable',
      portFile: path.join(appData, 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222
    });
  }
  if (channel !== 'stable') {
    endpoints.push({
      channel: 'insiders',
      portFile: path.join(appData, 'Antigravity - Insiders', 'DevToolsActivePort'),
      fallbackPort: 9223
    });
  }
  return endpoints;
}

function readPortFile(portFile) {
  try {
    const first = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
    const port = Number(first);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function fetchTargets(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: 1200 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function buildBundle(config) {
  const css = fs.readFileSync(path.join(PKG_ROOT, 'src', 'style.css'), 'utf8');
  const runtimeTpl = fs.readFileSync(path.join(PKG_ROOT, 'src', 'runtime.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const boot = {
    version: pkg.version || '1.0.0',
    css,
    locales: LOCALES,
    config
  };
  const hash = crypto.createHash('sha1').update(JSON.stringify(boot)).digest('hex').slice(0, 8);
  const version = `${boot.version}-${hash}`;
  boot.version = version;
  const script = runtimeTpl.replace('__AG_METRICS_BOOT__', () => JSON.stringify(boot));
  return { version, script };
}

const attachedTargets = new Map();

function isValidPageTarget(t) {
  if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl || !t.url) return false;
  const u = String(t.url);
  return !u.startsWith('devtools://') && !u.startsWith('plugin:') && !u.startsWith('data:') && !u.startsWith('about:');
}

function attachTarget(target, endpoint, getBundle, getConfig) {
  if (!isValidPageTarget(target) || attachedTargets.has(target.id)) return;

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();
  let currentCascadeId = '';
  let lastDbSig = null;
  let lastVersion = '';
  let pollTimer = null;

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) return resolve(null);
      const id = msgId++;
      pending.set(id, resolve);
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch {
        pending.delete(id);
        resolve(null);
      }
    });

  const pushMetrics = async (force = false) => {
    if (!currentCascadeId) return;
    const cfg = getConfig();
    const dirs = getCandidateConversationsDirs(cfg.channel);
    const sig = getDbSignature(currentCascadeId, dirs);
    if (!force && sig === lastDbSig) return;
    lastDbSig = sig;
    const payload = parseConversationMetrics(currentCascadeId, dirs, cfg);
    if (!payload) return;
    await send('Runtime.evaluate', {
      expression: `window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload)})`,
      returnByValue: false
    });
  };

  const inject = async (force = false) => {
    const bundle = getBundle();
    if (!force && lastVersion === bundle.version) return;
    await send('Runtime.evaluate', { expression: bundle.script, returnByValue: false });
    lastVersion = bundle.version;
    await pushMetrics(true);
  };

  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    attachedTargets.delete(target.id);
    try {
      ws.close();
    } catch {}
  };

  ws.addEventListener('message', async (evt) => {
    let msg;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result || null);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agRequestMetrics') {
      const cid = String(msg.params.payload || '').trim();
      if (cid) {
        currentCascadeId = cid;
        lastDbSig = null;
        await pushMetrics(true);
      }
    }
  });

  ws.addEventListener('open', async () => {
    await send('Runtime.enable');
    await send('Runtime.addBinding', { name: '__agRequestMetrics' });

    if (UNINSTALL_MODE) {
      await send('Runtime.evaluate', {
        expression: 'window.__ag_metrics_cleanup && window.__ag_metrics_cleanup()',
        returnByValue: false
      });
      cleanup();
      return;
    }

    await inject(true);

    if (ONCE_MODE) {
      cleanup();
      return;
    }

    pollTimer = setInterval(async () => {
      try {
        const res = await send('Runtime.evaluate', {
          expression: 'JSON.stringify({ v: window.__ag_metrics_version || "", p: location.pathname })',
          returnByValue: true
        });
        const info = res?.result?.value ? JSON.parse(res.result.value) : null;
        if (!info) return;
        const m = String(info.p || '').match(/\/c\/([0-9a-f-]{36})/i);
        const cid = m ? m[1] : '';
        if (cid !== currentCascadeId) {
          currentCascadeId = cid;
          lastDbSig = null;
        }
        const bundle = getBundle();
        if (info.v !== bundle.version) {
          await inject(true);
        } else {
          await pushMetrics(false);
        }
      } catch {}
    }, 1000);
  });

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
  attachedTargets.set(target.id, { ws, cleanup });
}

async function main() {
  if (!hasSqliteSupport() && !UNINSTALL_MODE) {
    console.error('[antigravity-live-metrics] Node.js >= 22.13.0 with node:sqlite is required.');
    process.exit(1);
  }

  let config = readConfig();
  let bundle = buildBundle(config);
  let lastConfigMtime = 0;
  try {
    lastConfigMtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {}

  const syncOnce = async () => {
    try {
      const st = fs.statSync(CONFIG_PATH);
      if (st.mtimeMs !== lastConfigMtime) {
        lastConfigMtime = st.mtimeMs;
        config = readConfig();
        bundle = buildBundle(config);
      }
    } catch {}

    const endpoints = getPortCandidates(config.channel);
    for (const ep of endpoints) {
      const port = readPortFile(ep.portFile) || ep.fallbackPort;
      const targets = await fetchTargets(port);
      for (const t of targets) {
        if (t.type === 'page' && t.webSocketDebuggerUrl) {
          attachTarget(
            t,
            ep,
            () => bundle,
            () => config
          );
        }
      }
    }
  };

  if (!ONCE_MODE && !UNINSTALL_MODE) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    const cleanPid = () => {
      try {
        if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
          fs.unlinkSync(PID_FILE);
        }
      } catch {}
      process.exit(0);
    };
    process.on('SIGINT', cleanPid);
    process.on('SIGTERM', cleanPid);
  }

  await syncOnce();

  if (ONCE_MODE || UNINSTALL_MODE) {
    setTimeout(() => process.exit(0), 1200);
    return;
  }

  setInterval(syncOnce, 2500);
}

main();
