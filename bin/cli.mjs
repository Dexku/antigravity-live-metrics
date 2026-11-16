#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasSqliteSupport } from '../src/telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DAEMON_PATH = path.join(PKG_ROOT, 'src', 'daemon.mjs');
const DATA_DIR = path.join(os.homedir(), '.antigravity-live-metrics');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');
const PLIST_LABEL = 'com.antigravity.live-metrics';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

const [cmd = 'help', ...rest] = process.argv.slice(2);

function ensureConfig(overrides = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let current = {
    channel: 'auto',
    lang: 'auto',
    contextLimit: 256000,
    contextLimitOverride: 0
  };
  try {
    current = { ...current, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {}
  const next = { ...current, ...overrides };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function getActivePort() {
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

  for (const name of ['Antigravity', 'Antigravity - Insiders']) {
    const portFile = path.join(appData, name, 'DevToolsActivePort');
    try {
      const p = Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]);
      if (Number.isInteger(p) && p > 0) return p;
    } catch {}
  }
  return 9222;
}

function fetchTargets(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function inspectLiveState() {
  const port = getActivePort();
  const targets = await fetchTargets(port);
  const page = targets.find((t) => {
    if (t.type !== 'page' || !t.webSocketDebuggerUrl || !t.url) return false;
    const u = String(t.url);
    return !u.startsWith('devtools://') && !u.startsWith('plugin:') && !u.startsWith('data:') && !u.startsWith('about:');
  });
  if (!page) return { reachable: false, port };

  return new Promise((resolve) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ reachable: true, port, title: page.title, state: null });
    }, 2000);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `JSON.stringify({
              version: window.__ag_metrics_version || null,
              hasStyle: !!document.getElementById('ag-lm-style'),
              pillMounted: !!document.getElementById('ag-lm-pill'),
              pillParentRight: !!(document.getElementById('ag-lm-pill') && document.getElementById('ag-lm-pill').parentElement && document.getElementById('ag-lm-pill').parentElement.nextElementSibling === null),
              pillText: (document.getElementById('ag-lm-text') && document.getElementById('ag-lm-text').textContent) || null
            })`,
            returnByValue: true
          }
        })
      );
    });

    ws.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          const state = msg.result?.result?.value ? JSON.parse(msg.result.result.value) : null;
          resolve({ reachable: true, port, title: page.title, state });
        }
      } catch {}
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ reachable: false, port });
    });
  });
}

function stopDaemon() {
  if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
    } catch {}
  } else if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/delete', '/tn', 'AntigravityLiveMetrics', '/f'], { stdio: 'ignore' });
    } catch {}
  }
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (pid > 0) process.kill(pid, 'SIGTERM');
  } catch {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

function startService() {
  const nodeBin = process.execPath;
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${DAEMON_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
    fs.writeFileSync(PLIST_PATH, plist, 'utf8');
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
    } catch {}
    execFileSync('launchctl', ['load', '-w', PLIST_PATH], { stdio: 'inherit' });
    return { platform: 'darwin', service: PLIST_PATH };
  }

  if (process.platform === 'win32') {
    const tr = `"${nodeBin}" --disable-warning=ExperimentalWarning "${DAEMON_PATH}"`;
    execFileSync('schtasks', ['/create', '/tn', 'AntigravityLiveMetrics', '/sc', 'onlogon', '/tr', tr, '/f'], {
      stdio: 'inherit'
    });
    return { platform: 'win32', service: 'schtasks:AntigravityLiveMetrics' };
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, 'antigravity-live-metrics.service');
  const unit = `[Unit]
Description=Antigravity Live Metrics Daemon
After=default.target

[Service]
ExecStart=${nodeBin} --disable-warning=ExperimentalWarning ${DAEMON_PATH}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf8');
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'antigravity-live-metrics.service'], { stdio: 'inherit' });
  return { platform: 'linux', service: unitPath };
}

async function run() {
  if (cmd === 'doctor') {
    const live = await inspectLiveState();
    console.log(
      JSON.stringify(
        {
          ok: hasSqliteSupport(),
          nodeVersion: process.version,
          sqliteSupported: hasSqliteSupport(),
          configPath: CONFIG_PATH,
          live
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'install') {
    const config = ensureConfig();
    stopDaemon();
    const service = startService();
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON_PATH, '--once'], {
      stdio: 'inherit'
    });
    const live = await inspectLiveState();
    console.log(JSON.stringify({ ok: true, config, service, live }, null, 2));
    return;
  }

  if (cmd === 'verify') {
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON_PATH, '--once'], {
      stdio: 'inherit'
    });
    const live = await inspectLiveState();
    console.log(JSON.stringify({ ok: Boolean(live.state?.pillMounted), live }, null, 2));
    return;
  }

  if (cmd === 'lang') {
    const nextLang = rest[0] || 'auto';
    const valid = ['auto', 'en', 'zh-CN', 'zh-TW', 'ja'];
    if (!valid.includes(nextLang)) {
      console.error(`Invalid language "${nextLang}". Supported: ${valid.join(', ')}`);
      process.exit(1);
    }
    const config = ensureConfig({ lang: nextLang });
    console.log(JSON.stringify({ ok: true, config }, null, 2));
    return;
  }

  if (cmd === 'uninstall') {
    stopDaemon();
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON_PATH, '--uninstall'], {
      stdio: 'inherit'
    });
    if (process.platform === 'darwin' && fs.existsSync(PLIST_PATH)) {
      fs.unlinkSync(PLIST_PATH);
    }
    console.log(JSON.stringify({ ok: true, uninstalled: true }, null, 2));
    return;
  }

  console.log(`antigravity-live-metrics CLI

Usage:
  node bin/cli.mjs install           Install and start the background metrics daemon
  node bin/cli.mjs verify            Inject once and verify live status
  node bin/cli.mjs doctor            Check Node.js SQLite support and live window
  node bin/cli.mjs lang <locale>     Set tooltip language (auto | en | zh-CN | zh-TW | ja)
  node bin/cli.mjs uninstall         Stop daemon and remove injected UI
`);
}

run();
