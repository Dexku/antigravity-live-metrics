#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasSqliteSupport } from '../sidecars/live_metrics/telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.antigravity-live-metrics');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const LEGACY_PLIST_LABEL = 'com.antigravity.live-metrics';
const LEGACY_PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${LEGACY_PLIST_LABEL}.plist`);
const PLUGIN_DIR = path.join(HOME, '.gemini', 'config', 'plugins', 'live-metrics');
const SIDECAR_LOG = path.join(HOME, '.gemini', 'antigravity', 'sidecar_data', 'live-metrics', 'live_metrics', 'logs', 'sidecar.log');

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

function stopLegacyDaemon() {
  let cleaned = false;
  if (process.platform === 'darwin' && fs.existsSync(LEGACY_PLIST_PATH)) {
    try {
      execFileSync('launchctl', ['unload', LEGACY_PLIST_PATH], { stdio: 'ignore' });
    } catch {}
    try {
      fs.unlinkSync(LEGACY_PLIST_PATH);
      cleaned = true;
    } catch {}
  } else if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/delete', '/tn', 'AntigravityLiveMetrics', '/f'], { stdio: 'ignore' });
      cleaned = true;
    } catch {}
  } else if (process.platform === 'linux') {
    const unitPath = path.join(HOME, '.config', 'systemd', 'user', 'antigravity-live-metrics.service');
    if (fs.existsSync(unitPath)) {
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'antigravity-live-metrics.service'], { stdio: 'ignore' });
      } catch {}
      try {
        fs.unlinkSync(unitPath);
        cleaned = true;
      } catch {}
    }
  }
  try {
    const pid = Number(fs.readFileSync(LEGACY_PID_FILE, 'utf8').trim());
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
      cleaned = true;
    }
  } catch {}
  try {
    if (fs.existsSync(LEGACY_PID_FILE)) fs.unlinkSync(LEGACY_PID_FILE);
  } catch {}
  return cleaned;
}

function copyPluginFiles() {
  fs.mkdirSync(path.join(PLUGIN_DIR, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(PLUGIN_DIR, 'sidecars', 'live_metrics'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'plugin.json'), path.join(PLUGIN_DIR, 'plugin.json'));
  fs.copyFileSync(path.join(PKG_ROOT, 'assets', 'logo.svg'), path.join(PLUGIN_DIR, 'assets', 'logo.svg'));

  const srcSidecar = path.join(PKG_ROOT, 'sidecars', 'live_metrics');
  const dstSidecar = path.join(PLUGIN_DIR, 'sidecars', 'live_metrics');
  for (const name of fs.readdirSync(srcSidecar)) {
    const src = path.join(srcSidecar, name);
    const dst = path.join(dstSidecar, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function getLatestSidecarPort() {
  try {
    const log = fs.readFileSync(SIDECAR_LOG, 'utf8');
    const matches = [...log.matchAll(/127\.0\.0\.1:(\d+)/g)];
    return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
  } catch {
    return null;
  }
}

function run() {
  if (cmd === 'install') {
    const config = ensureConfig();
    const legacyCleaned = stopLegacyDaemon();
    copyPluginFiles();
    console.log(
      JSON.stringify(
        {
          ok: true,
          pluginDir: PLUGIN_DIR,
          configPath: CONFIG_PATH,
          config,
          legacyDaemonRemoved: legacyCleaned
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'uninstall') {
    const legacyCleaned = stopLegacyDaemon();
    const existed = fs.existsSync(PLUGIN_DIR);
    if (existed) {
      fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ok: true, uninstalled: existed, legacyDaemonRemoved: legacyCleaned }, null, 2));
    return;
  }

  if (cmd === 'doctor') {
    console.log(
      JSON.stringify(
        {
          ok: hasSqliteSupport() && fs.existsSync(path.join(PLUGIN_DIR, 'plugin.json')),
          nodeVersion: process.version,
          sqliteSupported: hasSqliteSupport(),
          pluginInstalled: fs.existsSync(path.join(PLUGIN_DIR, 'plugin.json')),
          pluginDir: PLUGIN_DIR,
          configPath: CONFIG_PATH,
          lastKnownSidecarPort: getLatestSidecarPort()
        },
        null,
        2
      )
    );
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

  console.log(`antigravity-live-metrics v2 CLI

Usage:
  node bin/cli.mjs install           Install native Antigravity UI plugin (and clean up legacy v1 daemon)
  node bin/cli.mjs doctor            Check Node.js SQLite support and plugin installation status
  node bin/cli.mjs lang <locale>     Set panel language (auto | en | zh-CN | zh-TW | ja)
  node bin/cli.mjs uninstall         Remove plugin and stop any legacy v1 daemon
`);
}

run();
