import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_CACHE_ENTRIES = 64;
const RECENT_CALLS_LIMIT = 14;

const metricsCache = new Map();
const incrementalMap = new Map();
const dbPathCache = new Map();

function setBounded(map, key, val, max = MAX_CACHE_ENTRIES) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function hasSqliteSupport() {
  return Boolean(DatabaseSync);
}

export function parseProto(buf) {
  let i = 0;
  const out = new Map();
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;

    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > buf.length) break;
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function readUtf8Field(map, fieldNum) {
  const raw = map.get(fieldNum);
  if (!(raw instanceof Uint8Array) || raw.length === 0 || raw.length > 160) return '';
  const str = Buffer.from(raw).toString('utf8').trim();
  return /^[\x20-\x7e]+$/.test(str) ? str : '';
}

function parseGenMetadataRow(row) {
  const top = parseProto(row.data);
  const chatRaw = top.get(1);
  const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map();
  const usageRaw = chat.get(4);
  const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map();
  const chatStartRaw = chat.get(9);
  const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map();
  const ctxWinRaw = chatStart.get(10);
  const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map();
  const ttftRaw = chat.get(11);
  const ttftMap = ttftRaw instanceof Uint8Array ? parseProto(ttftRaw) : new Map();
  const streamRaw = chat.get(12);
  const streamMap = streamRaw instanceof Uint8Array ? parseProto(streamRaw) : new Map();

  const inTok = usage.get(2) || 0;
  const outTok = usage.get(3) || 0;
  const cacheRead = usage.get(5) || 0;
  const thinkTok = usage.get(9) || 0;
  const respTok = usage.get(10) || 0;
  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;
  const modelLabel = readUtf8Field(chat, 21) || readUtf8Field(chat, 19);

  return {
    idx: row.idx,
    inTok,
    outTok,
    cacheRead,
    ctx: inTok + cacheRead,
    maxCtx: ctxWin.get(4) || 0,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream,
    modelLabel
  };
}

function computeCallSpeed(item) {
  const rawStreamTps = item.stream >= 0.5 ? item.outTok / item.stream : 0;
  const e2eTps = item.totDur > 0 ? item.outTok / item.totDur : 0;
  const streamRatio = item.totDur > 0 ? item.stream / item.totDur : 0;
  const useStream =
    rawStreamTps > 0 &&
    rawStreamTps <= 600 &&
    (streamRatio >= 0.15 || (item.stream >= 2.0 && rawStreamTps <= 250));
  const displayTps = useStream ? rawStreamTps : e2eTps;
  return { displayTps, useStream };
}

export function getCandidateConversationsDirs(channel = 'auto') {
  const dirs = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== path.dirname(d); d = path.dirname(d)) {
      if (path.basename(d) !== 'sidecar_data') continue;
      const appData = path.dirname(d);
      const convDir = path.join(appData, 'conversations');
      if (fs.existsSync(convDir)) dirs.push(convDir);
      break;
    }
  }

  const home = os.homedir();
  if (channel !== 'insiders') {
    const stable = path.join(home, '.gemini', 'antigravity', 'conversations');
    if (!dirs.includes(stable) && fs.existsSync(stable)) dirs.push(stable);
  }
  if (channel !== 'stable') {
    const insiders = path.join(home, '.gemini', 'antigravity-insiders', 'conversations');
    if (!dirs.includes(insiders) && fs.existsSync(insiders)) dirs.push(insiders);
  }
  return dirs;
}

function getDbState(cascadeId, conversationsDirs) {
  if (!cascadeId || !UUID_RE.test(cascadeId)) return null;

  const cachedPath = dbPathCache.get(cascadeId);
  const candidates = cachedPath
    ? [cachedPath]
    : conversationsDirs.map((dir) => path.join(dir, `${cascadeId}.db`));

  for (const dbPath of candidates) {
    try {
      const st = fs.statSync(dbPath);
      if (!cachedPath) setBounded(dbPathCache, cascadeId, dbPath, 128);
      let walSig = '';
      try {
        const wst = fs.statSync(dbPath + '-wal');
        walSig = `:${wst.size}:${Math.trunc(wst.mtimeMs)}`;
      } catch {}
      const sig = `${st.size}:${Math.trunc(st.mtimeMs)}${walSig}`;
      return { dbPath, sig };
    } catch {
      if (cachedPath) dbPathCache.delete(cascadeId);
    }
  }
  return null;
}

export function getDbSignature(cascadeId, conversationsDirs) {
  const state = getDbState(cascadeId, conversationsDirs);
  return state ? state.sig : null;
}

export function parseConversationMetrics(cascadeId, conversationsDirs, config = {}) {
  if (!DatabaseSync) return { cascadeId, hasData: false, error: 'sqlite_missing' };
  const state = getDbState(cascadeId, conversationsDirs);
  if (!state) return { cascadeId, hasData: false };

  const { dbPath, sig } = state;
  const cfgKey = `${config.contextLimit || 256000}:${config.contextLimitOverride || 0}`;
  const cacheSig = `${sig}|${cfgKey}`;
  const cached = metricsCache.get(dbPath);
  if (cached && cached.sig === cacheSig) {
    return cached.payload;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
    const metaStat = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata').get();
    const rowCount = metaStat?.cnt ?? 0;
    const maxIdx = metaStat?.maxIdx ?? -1;

    if (rowCount === 0 || maxIdx < 0) {
      db.close();
      db = null;
      incrementalMap.delete(dbPath);
      const empty = { cascadeId, hasData: false };
      setBounded(metricsCache, dbPath, { sig: cacheSig, payload: empty });
      return empty;
    }

    const userStat = db
      .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS lastIdx FROM steps WHERE step_type = 14')
      .get();
    const lastUserStepIdx = userStat?.lastIdx ?? -1;
    const userStepsCount = userStat?.cnt ?? 0;
    const turnStat = db
      .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 15 AND idx > ?')
      .get(lastUserStepIdx);
    const rawTurnSteps = turnStat?.cnt ?? 0;

    let inc = incrementalMap.get(dbPath);
    if (
      inc &&
      (rowCount < inc.rowCount ||
        maxIdx < inc.maxIdx ||
        userStepsCount < inc.userStepsCount ||
        lastUserStepIdx < inc.lastUserStepIdx ||
        (lastUserStepIdx !== inc.lastUserStepIdx && userStepsCount <= inc.userStepsCount))
    ) {
      inc = null;
    }

    if (inc) {
      const startIdx = inc.maxIdx;
      const deltaRows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC').all(startIdx);
      while (inc.items.length > 0 && inc.items[inc.items.length - 1].idx >= startIdx) {
        const popped = inc.items.pop();
        inc.totalIn -= popped.inTok;
        inc.totalCache -= popped.cacheRead;
        inc.totalOut -= popped.outTok;
        inc.totalThink -= popped.thinkTok;
        inc.totalResp -= popped.respTok;
        inc.totalTtft -= popped.ttft;
        inc.totalStream -= popped.stream;
      }
      while (inc.validItems.length > 0 && inc.validItems[inc.validItems.length - 1].idx >= startIdx) {
        inc.validItems.pop();
      }
      if (inc.items.length + deltaRows.length === rowCount) {
        for (const row of deltaRows) {
          const p = parseGenMetadataRow(row);
          inc.items.push(p);
          inc.totalIn += p.inTok;
          inc.totalCache += p.cacheRead;
          inc.totalOut += p.outTok;
          inc.totalThink += p.thinkTok;
          inc.totalResp += p.respTok;
          inc.totalTtft += p.ttft;
          inc.totalStream += p.stream;
          if (p.ctx > 0 || p.outTok > 0) inc.validItems.push(p);
        }
        inc.rowCount = rowCount;
        inc.maxIdx = maxIdx;
        inc.userStepsCount = userStepsCount;
        inc.lastUserStepIdx = lastUserStepIdx;
      } else {
        inc = null;
      }
    }

    if (!inc) {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      const items = [];
      const validItems = [];
      let totalIn = 0;
      let totalCache = 0;
      let totalOut = 0;
      let totalThink = 0;
      let totalResp = 0;
      let totalTtft = 0;
      let totalStream = 0;
      for (const row of rows) {
        const p = parseGenMetadataRow(row);
        items.push(p);
        totalIn += p.inTok;
        totalCache += p.cacheRead;
        totalOut += p.outTok;
        totalThink += p.thinkTok;
        totalResp += p.respTok;
        totalTtft += p.ttft;
        totalStream += p.stream;
        if (p.ctx > 0 || p.outTok > 0) validItems.push(p);
      }
      inc = {
        rowCount: rows.length,
        maxIdx: rows.length > 0 ? rows[rows.length - 1].idx : -1,
        userStepsCount,
        lastUserStepIdx,
        items,
        validItems,
        totalIn,
        totalCache,
        totalOut,
        totalThink,
        totalResp,
        totalTtft,
        totalStream
      };
    }

    db.close();
    db = null;
    setBounded(incrementalMap, dbPath, inc);

    const { validItems: valid, totalIn, totalCache, totalOut, totalThink, totalResp, totalTtft, totalStream } = inc;
    if (valid.length === 0) {
      const empty = { cascadeId, hasData: false };
      setBounded(metricsCache, dbPath, { sig: cacheSig, payload: empty });
      return empty;
    }

    const turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
    const turnSteps = turnSlice.length;
    let turnOut = 0;
    let turnThink = 0;
    let turnResp = 0;
    let turnDur = 0;
    for (const item of turnSlice) {
      turnOut += item.outTok;
      turnThink += item.thinkTok;
      turnResp += item.respTok;
      turnDur += item.totDur;
    }

    // Session speed summary (average & peak across valid calls)
    let speedSum = 0;
    let speedCount = 0;
    let peakTps = 0;
    let ttftSum = 0;
    for (const item of valid) {
      const sp = computeCallSpeed(item);
      if (sp.displayTps > 0) {
        speedSum += sp.displayTps;
        speedCount++;
        if (sp.displayTps > peakTps) peakTps = sp.displayTps;
      }
      ttftSum += item.ttft;
    }
    const avgTps = speedCount > 0 ? speedSum / speedCount : 0;
    const avgTtft = valid.length > 0 ? ttftSum / valid.length : 0;

    const last = valid[valid.length - 1];
    const fallbackLimit = Number(config.contextLimit) > 0 ? Number(config.contextLimit) : 256000;
    const contextLimit =
      Number(config.contextLimitOverride) > 0
        ? Number(config.contextLimitOverride)
        : last.maxCtx > 0
          ? last.maxCtx
          : fallbackLimit;

    const { displayTps, useStream } = computeCallSpeed(last);
    const ctxPct = Math.round((last.ctx / contextLimit) * 100);

    const startRecent = Math.max(0, valid.length - RECENT_CALLS_LIMIT);
    const recentCalls = [];
    for (let i = valid.length - 1; i >= startRecent; i--) {
      const item = valid[i];
      const sp = computeCallSpeed(item);
      recentCalls.push({
        gen: i + 1,
        model: item.modelLabel || '',
        tps: Number(sp.displayTps.toFixed(1)),
        isEndToEnd: !sp.useStream,
        ttft: Number(item.ttft.toFixed(2)),
        stream: Number(item.stream.toFixed(2)),
        total: Number(item.totDur.toFixed(2)),
        ctx: item.ctx,
        newTok: item.inTok,
        cached: item.cacheRead,
        outTok: item.outTok,
        thinkTok: item.thinkTok,
        respTok: item.respTok,
        cachePct: item.ctx > 0 ? Number(((item.cacheRead / item.ctx) * 100).toFixed(1)) : 0
      });
    }

    const payload = {
      cascadeId,
      hasData: true,
      model: last.modelLabel || '',
      inline: {
        tps: Math.round(displayTps),
        latencyType: useStream ? 'ttft' : 'hold',
        latencySec: Number(last.ttft.toFixed(1)),
        ctxPct,
        ctxLevel: ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'warn' : 'ok'
      },
      tooltip: {
        genCount: valid.length,
        speed: {
          tps: Number(displayTps.toFixed(1)),
          avgTps: Number(avgTps.toFixed(1)),
          peakTps: Number(peakTps.toFixed(1)),
          isEndToEnd: !useStream
        },
        latency: {
          ttft: Number(last.ttft.toFixed(2)),
          stream: Number(last.stream.toFixed(2)),
          total: Number(last.totDur.toFixed(2)),
          avgTtft: Number(avgTtft.toFixed(2))
        },
        context: {
          total: last.ctx,
          newTok: last.inTok,
          cached: last.cacheRead,
          cachePct: last.ctx > 0 ? Number(((last.cacheRead / last.ctx) * 100).toFixed(1)) : 0
        },
        stepOutput: {
          total: last.outTok,
          thinking: last.thinkTok,
          text: last.respTok
        },
        turn: {
          steps: turnSteps,
          output: turnOut,
          thinking: turnThink,
          text: turnResp,
          duration: Number(turnDur.toFixed(1))
        },
        session: {
          turns: Math.max(userStepsCount, 1),
          calls: valid.length,
          ctx: last.ctx,
          ctxLimit: contextLimit,
          ctxPct,
          ctxRemaining: Math.max(0, contextLimit - last.ctx),
          totalIn,
          totalCache,
          cacheHitPct: totalIn + totalCache > 0 ? Number(((totalCache / (totalIn + totalCache)) * 100).toFixed(1)) : 0,
          totalOut,
          totalThink,
          totalResp,
          totalTtft: Number(totalTtft.toFixed(1)),
          totalStream: Number(totalStream.toFixed(1)),
          totalDuration: Number((totalTtft + totalStream).toFixed(1))
        }
      },
      recentCalls
    };

    setBounded(metricsCache, dbPath, { sig: cacheSig, payload });
    return payload;
  } catch {
    return { cascadeId, hasData: false };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}
