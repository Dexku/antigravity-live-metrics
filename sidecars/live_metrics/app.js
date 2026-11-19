(() => {
  'use strict';

  const POLL_MS = 1000;
  const $ = (id) => document.getElementById(id);

  const state = {
    locales: {},
    config: { lang: 'auto' },
    sqliteSupported: true,
    lastSig: '',
    lastPayload: null,
    langLockUntil: 0,
    timer: null
  };

  const params = new URLSearchParams(window.location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ---------- Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style']
  });

  // ---------- Interest-Triggered Tooltips / Toggletips Wiring ----------
  const supportsInterest = 'interestForElement' in HTMLButtonElement.prototype;
  const ownedTriggers = new WeakSet();
  const hoverCloseTimers = new WeakMap();

  const hintProbe = document.createElement('div');
  hintProbe.popover = 'hint';
  if (hintProbe.popover !== 'hint') {
    document.addEventListener(
      'beforetoggle',
      (evt) => {
        const target = evt.target;
        if (
          evt.newState === 'open' &&
          target?.getAttribute?.('popover') === 'hint' &&
          document.querySelector(`[popovertarget="${CSS.escape(target.id)}"]`)
        ) {
          target.popover = 'auto';
        }
      },
      true
    );
  }

  document.addEventListener(
    'toggle',
    (evt) => {
      const pop = evt.target;
      if (!pop || !pop.id) return;
      const open = evt.newState === 'open';
      document.querySelectorAll(`[interestfor="${CSS.escape(pop.id)}"]`).forEach((btn) => {
        if (ownedTriggers.has(btn)) {
          btn.setAttribute('aria-expanded', String(open));
        }
        btn.classList.toggle('interest-source', open);
      });
    },
    true
  );

  function positionFallbackPopover(trigger, pop) {
    if (CSS.supports('position-area: block-end')) return;
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth || 260;
    const ph = pop.offsetHeight || 140;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - pw - 12));
    const spaceBelow = window.innerHeight - r.bottom;
    const top = spaceBelow >= ph + 12 ? r.bottom + 6 : Math.max(12, r.top - ph - 6);
    pop.style.position = 'fixed';
    pop.style.inset = 'auto';
    pop.style.margin = '0';
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function wireInterestHints(root = document) {
    root.querySelectorAll('[interestfor]').forEach((trigger) => {
      const targetId = trigger.getAttribute('interestfor');
      if (!targetId) return;
      const pop = document.getElementById(targetId);
      if (!pop || !pop.hasAttribute('popover')) return;

      if (!pop.hasAttribute('role')) {
        pop.setAttribute('role', 'tooltip');
      }
      if (trigger.hasAttribute('popovertarget')) {
        if (!trigger.hasAttribute('aria-expanded')) {
          trigger.setAttribute('aria-expanded', String(pop.matches(':popover-open')));
          ownedTriggers.add(trigger);
        }
      } else if (!trigger.hasAttribute('aria-describedby')) {
        trigger.setAttribute('aria-describedby', targetId);
      }

      if (trigger.dataset.lmWired) return;
      trigger.dataset.lmWired = '1';

      if (!supportsInterest) {
        const clearClose = () => {
          const t = hoverCloseTimers.get(pop);
          if (t) {
            clearTimeout(t);
            hoverCloseTimers.delete(pop);
          }
        };
        const openPop = () => {
          clearClose();
          try {
            if (!pop.matches(':popover-open')) {
              pop.showPopover();
            }
            positionFallbackPopover(trigger, pop);
          } catch {}
        };
        const scheduleClose = () => {
          clearClose();
          const t = setTimeout(() => {
            try {
              if (pop.matches(':popover-open')) pop.hidePopover();
            } catch {}
          }, 140);
          hoverCloseTimers.set(pop, t);
        };

        trigger.addEventListener('mouseenter', openPop);
        trigger.addEventListener('focus', openPop);
        trigger.addEventListener('mouseleave', scheduleClose);
        trigger.addEventListener('blur', scheduleClose);
        pop.addEventListener('mouseenter', clearClose);
        pop.addEventListener('mouseleave', scheduleClose);
      }
    });
  }

  // ---------- Formatters ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTok(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtNum(n) {
    return (n || 0).toLocaleString('en-US');
  }

  function fmtCeil(tokens) {
    if (tokens >= 1000000) return `${Number((tokens / 1000000).toFixed(1))}M`;
    return `${Math.round(tokens / 1000)}k`;
  }

  function fmtDur(sec) {
    if (!sec || sec < 0) return '0s';
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  }

  function tpl(str, vars) {
    return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  }

  function resolveLocale() {
    const pref = state.config?.lang || 'auto';
    if (pref !== 'auto' && state.locales[pref]) return state.locales[pref];

    const navLang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
    if (navLang.startsWith('zh-tw') || navLang.startsWith('zh-hk') || navLang.startsWith('zh-hant')) {
      return state.locales['zh-TW'] || state.locales.en || {};
    }
    if (navLang.startsWith('zh')) {
      return state.locales['zh-CN'] || state.locales.en || {};
    }
    if (navLang.startsWith('ja')) {
      return state.locales.ja || state.locales.en || {};
    }
    return state.locales.en || {};
  }

  function syncLangButtons(t) {
    const cur = state.config?.lang || 'auto';
    document.querySelectorAll('#lang-group .lang-btn').forEach((btn) => {
      const code = btn.dataset.lang;
      btn.setAttribute('aria-pressed', String(code === cur));
      if (code === 'auto' && t.langAuto && btn.textContent !== t.langAuto) {
        btn.textContent = t.langAuto;
      }
    });
  }

  function popRow(k, v) {
    return `<div class="pop-row"><span class="pop-k">${esc(k)}</span><span class="pop-v">${v}</span></div>`;
  }

  function renderSparkline(calls) {
    const svg = $('sparkline');
    if (!svg || !calls.length) return;
    const ordered = [...calls].reverse();
    const values = ordered.map((c) => c.tps || 0);
    const maxVal = Math.max(...values, 1);
    const minVal = Math.min(...values);
    const W = 360;
    const H = 40;
    const padX = 6;
    const padY = 5;

    if (ordered.length === 1) {
      svg.innerHTML = `<line x1="${padX}" y1="${H / 2}" x2="${W - padX}" y2="${H / 2}" stroke="var(--lm-blue)" stroke-width="2" stroke-linecap="round"/><circle cx="${W / 2}" cy="${H / 2}" r="3" fill="var(--lm-blue)"/>`;
      $('spark-range').textContent = `${Math.round(values[0])} tok/s`;
      return;
    }

    const span = Math.max(maxVal - minVal, maxVal * 0.25, 1);
    const pts = values.map((v, i) => {
      const x = padX + (i / (values.length - 1)) * (W - padX * 2);
      const norm = (v - Math.max(0, minVal - span * 0.15)) / (span * 1.25);
      const y = H - padY - Math.max(0, Math.min(1, norm)) * (H - padY * 2);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });

    const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
    const areaD = `${lineD} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z`;
    const lastPt = pts[pts.length - 1];

    svg.innerHTML = `
      <defs>
        <linearGradient id="lmSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--lm-blue)" stop-opacity="0.24"/>
          <stop offset="100%" stop-color="var(--lm-blue)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#lmSparkFill)"/>
      <path d="${lineD}" fill="none" stroke="var(--lm-blue)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="3" fill="var(--lm-blue)"/>
    `;
    $('spark-range').textContent = `${Math.round(minVal)} – ${Math.round(maxVal)} tok/s`;
  }

  function applyStaticLabels(t) {
    $('panel-title').textContent = t.title || 'Live Metrics';
    $('live-text').textContent = t.live || 'Live';
    $('latest-title').textContent = t.latestCall || 'Latest Call';
    $('session-title').textContent = t.sessionTotal || 'Session Total';
    $('ctx-win-lbl').textContent = t.contextWindow || 'Context Window';
    $('recent-title').textContent = t.recentCalls || 'Recent Calls';
    $('kpi-speed-lbl').textContent = t.speed || 'Speed';
    $('kpi-ctx-lbl').textContent = t.ctxShort || 'Context';
    $('kpi-cache-lbl').textContent = t.cacheHit || 'Cache Hit';
    $('lbl-latency').textContent = t.latency || 'Latency';
    $('lbl-output').textContent = t.stepOutput || 'Output';
    $('th-gen').textContent = t.colGen || '#';
    $('th-speed').textContent = t.colSpeed || 'Speed';
    $('th-ttft').textContent = t.colTtft || 'TTFT';
    $('th-total').textContent = t.colTotal || 'Total';
    $('th-out').textContent = t.colOut || 'Output';
    $('th-cache').textContent = t.colCache || 'Cache';
    syncLangButtons(t);
  }

  function renderEmpty(t, mode) {
    $('dashboard').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    $('live-badge').classList.add('is-idle');
    $('model-badge').classList.add('hidden');

    if (mode === 'sqlite_missing') {
      $('empty-title').textContent = t.title || 'Live Metrics';
      $('empty-desc').textContent = t.sqliteMissing || 'Node.js >= 22.13.0 required.';
    } else if (mode === 'no_conv') {
      $('empty-title').textContent = t.noConvTitle || 'No active conversation';
      $('empty-desc').textContent = t.noConvDesc || '';
    } else {
      $('empty-title').textContent = t.waitingTitle || 'Waiting for metrics';
      $('empty-desc').textContent = t.waitingDesc || '';
    }
  }

  function render(payload) {
    const t = resolveLocale();
    applyStaticLabels(t);

    if (!state.sqliteSupported || payload?.error === 'sqlite_missing') {
      renderEmpty(t, 'sqlite_missing');
      return;
    }

    if (!currentConv()) {
      renderEmpty(t, 'no_conv');
      return;
    }

    if (!payload || !payload.hasData || !payload.tooltip || !payload.inline) {
      renderEmpty(t, 'waiting');
      return;
    }

    $('empty-state').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('live-badge').classList.remove('is-idle');

    const modelBadge = $('model-badge');
    if (payload.model) {
      modelBadge.textContent = payload.model;
      modelBadge.classList.remove('hidden');
    } else {
      modelBadge.classList.add('hidden');
    }

    const { inline, tooltip: tip, recentCalls = [] } = payload;

    // ---- 4 KPI Cards ----
    $('kpi-tps').textContent = String(inline.tps);
    $('kpi-speed-mode').textContent = tip.speed.isEndToEnd ? t.endToEnd : t.streamRate;
    $('kpi-speed-sub').textContent = `${t.avg} ${Math.round(tip.speed.avgTps || 0)} · ${t.peak} ${Math.round(tip.speed.peakTps || 0)}`;
    $('tip-speed').innerHTML = `
      <div class="pop-title"><span>${esc(t.tipSpeedTitle)}</span><span class="badge">${esc(tip.speed.isEndToEnd ? t.endToEnd : t.streamRate)}</span></div>
      <div class="pop-grid">
        ${popRow(t.latestCall, `${tip.speed.tps.toFixed(1)} tok/s`)}
        ${popRow(t.avg, `${(tip.speed.avgTps || 0).toFixed(1)} tok/s`)}
        ${popRow(t.peak, `${(tip.speed.peakTps || 0).toFixed(1)} tok/s`)}
        ${payload.model ? popRow(t.model, esc(payload.model)) : ''}
      </div>
    `;

    $('kpi-lat-lbl').textContent = inline.latencyType === 'ttft' ? t.ttftShort : t.holdShort;
    $('kpi-lat').textContent = inline.latencySec.toFixed(1);
    $('kpi-lat-sub').textContent = `${t.total} ${tip.latency.total.toFixed(1)}s · ${t.avg} ${(tip.latency.avgTtft || 0).toFixed(1)}s`;
    $('tip-lat').innerHTML = `
      <div class="pop-title"><span>${esc(t.tipLatTitle)}</span></div>
      <div class="pop-grid">
        ${popRow(t.wait, `${tip.latency.ttft.toFixed(2)}s`)}
        ${popRow(t.stream, `${tip.latency.stream.toFixed(2)}s`)}
        ${popRow(t.total, `${tip.latency.total.toFixed(2)}s`)}
        ${popRow(`${t.avg} ${t.ttftShort}`, `${(tip.latency.avgTtft || 0).toFixed(2)}s`)}
      </div>
    `;

    const ctxPctEl = $('kpi-ctx-pct');
    ctxPctEl.textContent = `${inline.ctxPct}%`;
    ctxPctEl.className = inline.ctxLevel === 'crit' ? 'ctx-crit' : inline.ctxLevel === 'warn' ? 'ctx-warn' : 'ctx-ok';
    $('kpi-ctx-sub').textContent = `${fmtTok(tip.session.ctx)} / ${fmtCeil(tip.session.ctxLimit)}`;
    $('tip-ctx').innerHTML = `
      <div class="pop-title"><span>${esc(t.tipCtxTitle)}</span><span>${inline.ctxPct}%</span></div>
      <div class="pop-grid">
        ${popRow(t.context, fmtNum(tip.context.total))}
        ${popRow(t.newTok, fmtNum(tip.context.newTok))}
        ${popRow(t.cached, `${fmtNum(tip.context.cached)} (${tip.context.cachePct}%)`)}
        ${popRow(t.contextWindow, `${fmtNum(tip.session.ctxLimit)}`)}
      </div>
    `;

    $('kpi-cache-pct').textContent = `${tip.session.cacheHitPct}%`;
    $('kpi-cache-sub').textContent = `${t.lastCallCache} ${tip.context.cachePct}% · ${fmtTok(tip.session.totalCache)}`;
    $('tip-cache').innerHTML = `
      <div class="pop-title"><span>${esc(t.tipCacheTitle)}</span><span>${tip.session.cacheHitPct}%</span></div>
      <div class="pop-grid">
        ${popRow(t.lastCallCache, `${tip.context.cachePct}% (${fmtNum(tip.context.cached)})`)}
        ${popRow(`${t.sessionTotal} ${t.cached}`, fmtNum(tip.session.totalCache))}
        ${popRow(`${t.sessionTotal} ${t.newTok}`, fmtNum(tip.session.totalIn))}
      </div>
    `;

    // ---- Left Card: Latest Call (clean inline legends + footer) ----
    $('gen-badge').textContent = tpl(t.genBadge, { n: tip.genCount });
    $('val-lat-total').textContent = `${tip.latency.total.toFixed(2)}s`;

    const latSum = Math.max(tip.latency.ttft + tip.latency.stream, 0.001);
    const waitPct = Math.round((tip.latency.ttft / latSum) * 100);
    const streamPct = 100 - waitPct;
    $('bar-wait').style.width = `${waitPct}%`;
    $('bar-stream').style.width = `${streamPct}%`;
    $('lat-legend').innerHTML = `
      <span class="legend-items">
        <span class="legend-item"><span class="dot dot-wait"></span>${esc(t.wait)} <span class="legend-val">${tip.latency.ttft.toFixed(2)}s</span></span>
        <span class="legend-item"><span class="dot dot-stream"></span>${esc(t.stream)} <span class="legend-val">${tip.latency.stream.toFixed(2)}s</span></span>
      </span>
      <span>${waitPct}% / ${streamPct}%</span>
    `;

    $('val-out-total').textContent = `${fmtNum(tip.stepOutput.total)} tok`;
    const outSum = Math.max(tip.stepOutput.thinking + tip.stepOutput.text, 1);
    const thinkPct = Math.round((tip.stepOutput.thinking / outSum) * 100);
    const respPct = 100 - thinkPct;
    $('bar-think').style.width = `${thinkPct}%`;
    $('bar-resp').style.width = `${respPct}%`;
    $('out-legend').innerHTML = `
      <span class="legend-items">
        <span class="legend-item"><span class="dot dot-think"></span>${esc(t.thinking)} <span class="legend-val">${fmtNum(tip.stepOutput.thinking)}</span></span>
        <span class="legend-item"><span class="dot dot-resp"></span>${esc(t.text)} <span class="legend-val">${fmtNum(tip.stepOutput.text)}</span></span>
      </span>
      <span>${thinkPct}% / ${respPct}%</span>
    `;

    const latestFoot = $('latest-foot');
    if (tip.turn.steps > 1) {
      latestFoot.innerHTML = `
        <span>${esc(t.turnTotal)} · ${esc(tpl(t.stepsCount, { n: tip.turn.steps }))}</span>
        <span class="card-foot-val">${esc(fmtTok(tip.turn.output))} <span class="metric-sub">(${esc(fmtTok(tip.turn.thinking))} + ${esc(fmtTok(tip.turn.text))}) · ${fmtDur(tip.turn.duration)}</span></span>
      `;
    } else {
      latestFoot.innerHTML = `
        <span>${esc(t.context)}</span>
        <span class="card-foot-val">${esc(fmtTok(tip.context.total))} <span class="metric-sub">(${esc(t.newTok)} ${esc(fmtTok(tip.context.newTok))} · ${tip.context.cachePct}%)</span></span>
      `;
    }

    // ---- Right Card: Session Total (balanced height + footer) ----
    $('turns-badge').textContent = tpl(t.turnsCalls, {
      turns: tip.session.turns,
      calls: tip.session.calls
    });
    $('ctx-win-val').textContent = `${fmtTok(tip.session.ctx)} / ${fmtCeil(tip.session.ctxLimit)}`;

    const limit = Math.max(tip.session.ctxLimit, 1);
    const cachedBarW = Math.min(100, (tip.context.cached / limit) * 100);
    const newBarW = Math.min(100 - cachedBarW, (tip.context.newTok / limit) * 100);
    const track = $('ctx-bar-role');
    track.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, tip.session.ctxPct))));
    track.className =
      tip.session.ctxPct >= 90
        ? 'bar-track is-crit'
        : tip.session.ctxPct >= 75
          ? 'bar-track is-warn'
          : 'bar-track';
    $('ctx-bar-cached').style.width = `${cachedBarW.toFixed(2)}%`;
    $('ctx-bar-new').style.width = `${newBarW.toFixed(2)}%`;

    $('ctx-legend').innerHTML = `
      <span class="legend-items">
        <span class="legend-item"><span class="dot dot-cached"></span>${esc(t.cached)} <span class="legend-val">${esc(fmtTok(tip.context.cached))}</span></span>
        <span class="legend-item"><span class="dot dot-new"></span>${esc(t.newTok)} <span class="legend-val">${esc(fmtTok(tip.context.newTok))}</span></span>
      </span>
      <span>${esc(tpl(t.remaining, { n: fmtTok(tip.session.ctxRemaining) }))}</span>
    `;

    const totalAllIn = tip.session.totalIn + tip.session.totalCache;
    $('session-tiles').innerHTML = `
      <div class="stat-tile">
        <span class="stat-tile-lbl">${esc(t.totalInput)}</span>
        <span class="stat-tile-val">${esc(fmtTok(totalAllIn))}</span>
        <span class="stat-tile-sub">${esc(t.newTok)} ${esc(fmtTok(tip.session.totalIn))}<br>${esc(t.cached)} ${esc(fmtTok(tip.session.totalCache))}</span>
      </div>
      <div class="stat-tile">
        <span class="stat-tile-lbl">${esc(t.totalOutput)}</span>
        <span class="stat-tile-val">${esc(fmtTok(tip.session.totalOut))}</span>
        <span class="stat-tile-sub">${esc(t.thinking)} ${esc(fmtTok(tip.session.totalThink))}<br>${esc(t.text)} ${esc(fmtTok(tip.session.totalResp))}</span>
      </div>
      <div class="stat-tile">
        <span class="stat-tile-lbl">${esc(t.totalTime)}</span>
        <span class="stat-tile-val">${esc(fmtDur(tip.session.totalDuration || 0))}</span>
        <span class="stat-tile-sub">${esc(t.wait)} ${esc(fmtDur(tip.session.totalTtft || 0))}<br>${esc(t.stream)} ${esc(fmtDur(tip.session.totalStream || 0))}</span>
      </div>
    `;

    const calls = Math.max(tip.session.calls, 1);
    const avgOutPerCall = Math.round(tip.session.totalOut / calls);
    const avgDurPerCall = (tip.session.totalDuration || 0) / calls;
    $('session-foot').innerHTML = `
      <span>${esc(t.avgPerCall)}</span>
      <span class="card-foot-val">${esc(fmtTok(avgOutPerCall))} ${esc(t.outShort)} · ${fmtDur(avgDurPerCall)}</span>
    `;

    // ---- Recent Calls + Sparkline + Per-Row Hover Popover ----
    const recentCard = $('recent-card');
    if (recentCalls.length > 0) {
      recentCard.classList.remove('hidden');
      $('recent-count').textContent = String(recentCalls.length);
      renderSparkline(recentCalls);

      $('recent-body').innerHTML = recentCalls
        .map((c) => {
          const popId = `tip-call-${c.gen}`;
          return `<tr>
            <td>
              <button type="button" class="row-tip-btn" interestfor="${popId}" popovertarget="${popId}" popovertargetaction="show">#${c.gen}</button>
              <div id="${popId}" popover="hint" class="hint-popover">
                <div class="pop-title"><span>${esc(tpl(t.callDetailTitle, { n: c.gen }))}</span><span class="badge">${esc(c.isEndToEnd ? t.endToEnd : t.streamRate)}</span></div>
                <div class="pop-grid">
                  ${c.model ? popRow(t.model, esc(c.model)) : ''}
                  ${popRow(t.speed, `${c.tps.toFixed(1)} tok/s`)}
                  ${popRow(t.latency, `${esc(t.wait)} ${c.ttft.toFixed(2)}s · ${esc(t.stream)} ${c.stream.toFixed(2)}s`)}
                  ${popRow(t.stepOutput, `${fmtNum(c.outTok)} (${esc(t.thinking)} ${fmtNum(c.thinkTok)} + ${esc(t.text)} ${fmtNum(c.respTok)})`)}
                  ${popRow(t.context, `${fmtNum(c.ctx)} (${esc(t.newTok)} ${fmtNum(c.newTok)} · ${esc(t.cached)} ${c.cachePct}%)`)}
                </div>
              </div>
            </td>
            <td>${Math.round(c.tps)} <span class="metric-sub">tok/s</span></td>
            <td>${c.ttft.toFixed(1)}s</td>
            <td>${c.total.toFixed(1)}s</td>
            <td>${esc(fmtTok(c.outTok))}</td>
            <td>${Math.round(c.cachePct)}%</td>
          </tr>`;
        })
        .join('');
    } else {
      recentCard.classList.add('hidden');
    }

    wireInterestHints(document);
  }

  async function pollOnce(force = false) {
    if (document.hidden && !force) return;
    const conv = currentConv();
    if (!conv) {
      render(null);
      return;
    }
    try {
      const qs = new URLSearchParams({ conversationId: conv });
      if (!force && state.lastSig) qs.set('sig', state.lastSig);
      const data = await apiGet(`/api/metrics?${qs.toString()}`);
      if (data.unchanged) return;
      state.lastSig = data.sig || '';
      if (data.config) {
        const preservedLang = Date.now() < state.langLockUntil ? state.config.lang : data.config.lang;
        state.config = { ...data.config, lang: preservedLang };
      }
      state.lastPayload = data;
      render(data);
    } catch {
      // Keep last good render on transient error
    }
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => pollOnce(false), POLL_MS);
  }

  async function boot() {
    wireInterestHints(document);

    try {
      const init = await apiGet('/api/init');
      state.locales = init.locales || {};
      state.config = init.config || { lang: 'auto' };
      state.sqliteSupported = init.sqliteSupported !== false;
    } catch {}

    const langGroup = $('lang-group');
    if (langGroup) {
      langGroup.addEventListener('click', async (evt) => {
        const btn = evt.target.closest('.lang-btn');
        if (!btn) return;
        const lang = btn.dataset.lang;
        if (!lang || lang === state.config.lang) return;
        state.config = { ...state.config, lang };
        state.langLockUntil = Date.now() + 2500;
        render(state.lastPayload);
        try {
          await apiPost('/api/config', { lang });
          state.lastSig = '';
        } catch {}
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollOnce(false);
    });

    await pollOnce(true);
    startPolling();
  }

  boot();
})();
