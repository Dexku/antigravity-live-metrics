import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { LOCALES } from './i18n.mjs';
import {
  getCandidateConversationsDirs,
  getDbSignature,
  hasSqliteSupport,
  parseConversationMetrics
} from './telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.antigravity-live-metrics');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const UUID_RE = /^[0-9a-f-]{36}$/i;
const VALID_LANGS = new Set(['auto', 'en', 'zh-CN', 'zh-TW', 'ja']);

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

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8']
};

const app = new SidecarApp();

app.page('/', () => fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(fs.readFileSync(path.join(__dirname, file), 'utf8'), { contentType }),
    'GET'
  );
}

app.api(
  '/api/init',
  () => ({
    locales: LOCALES,
    config: readConfig(),
    sqliteSupported: hasSqliteSupport()
  }),
  'GET'
);

app.api(
  '/api/metrics',
  (data) => {
    const conv = String(data.conversationId || app.config.conversationId || '').trim();
    const cfg = readConfig();
    if (!conv || !UUID_RE.test(conv)) {
      return { conversationId: null, hasData: false, config: cfg };
    }
    if (!hasSqliteSupport()) {
      return { conversationId: conv, hasData: false, error: 'sqlite_missing', config: cfg };
    }

    const dirs = getCandidateConversationsDirs(cfg.channel);
    const dbSig = getDbSignature(conv, dirs);
    const cfgKey = `${cfg.contextLimit || 256000}:${cfg.contextLimitOverride || 0}:${cfg.lang || 'auto'}`;
    const fullSig = dbSig ? `${dbSig}|${cfgKey}` : `empty|${cfgKey}`;

    if (data.sig && data.sig === fullSig) {
      return { conversationId: conv, unchanged: true, sig: fullSig };
    }

    const metrics = parseConversationMetrics(conv, dirs, cfg);
    // Keep `sig: fullSig` AFTER spreading `metrics` so `unchanged` cache checks always match.
    return {
      ...(metrics || { hasData: false }),
      conversationId: conv,
      config: cfg,
      sig: fullSig
    };
  },
  'GET'
);

app.api(
  '/api/config',
  (data) => {
    const patch = {};
    if (typeof data.lang === 'string' && VALID_LANGS.has(data.lang)) {
      patch.lang = data.lang;
    }
    const config = writeConfig(patch);
    return { ok: true, config };
  },
  'POST'
);

app.run();
