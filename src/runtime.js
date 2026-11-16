(function (boot) {
  'use strict';

  const CSS_TEXT = boot.css || '';
  const LOCALES = boot.locales || {};
  const CONFIG = boot.config || {};
  const VERSION = boot.version || '1.0.0';

  if (window.location.protocol === 'plugin:') return;

  const UUID_RE = /\/c\/([0-9a-f-]{36})/i;
  const INPUT_BOX_ID = 'antigravity.agentSidePanelInputBox';
  const STYLE_ID = 'ag-lm-style';
  const PILL_ID = 'ag-lm-pill';
  const TEXT_ID = 'ag-lm-text';
  const TOOLTIP_ID = 'ag-lm-tooltip';

  // Cleanup previous injection on hot reload
  if (typeof window.__ag_metrics_cleanup === 'function') {
    try {
      window.__ag_metrics_cleanup();
    } catch {}
  }

  // Remove any legacy pill/tooltip from other patches to avoid duplicates
  for (const legacyId of ['ag-live-metrics-pill', 'ag-live-metrics-tooltip', 'ag-live-metrics-style']) {
    const legacy = document.getElementById(legacyId);
    if (legacy) legacy.remove();
  }

  // Inject stylesheet
  const headTarget = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
  let styleEl = document.getElementById(STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    if (headTarget) headTarget.appendChild(styleEl);
  }
  if (styleEl.textContent !== CSS_TEXT) {
    styleEl.textContent = CSS_TEXT;
  }

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

  function tpl(str, vars) {
    return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  }

  function resolveLocale() {
    const pref = CONFIG.lang || 'auto';
    if (pref !== 'auto' && LOCALES[pref]) return LOCALES[pref];

    const navLang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
    if (navLang.startsWith('zh-tw') || navLang.startsWith('zh-hk') || navLang.startsWith('zh-hant')) {
      return LOCALES['zh-TW'] || LOCALES.en;
    }
    if (navLang.startsWith('zh')) {
      return LOCALES['zh-CN'] || LOCALES.en;
    }
    if (navLang.startsWith('ja')) {
      return LOCALES.ja || LOCALES.en;
    }
    return LOCALES.en;
  }

  function extractCascadeId() {
    const m = (window.location.pathname || '').match(UUID_RE);
    return m ? m[1] : '';
  }

  function findFooterRow(box) {
    if (!box) return null;
    const rows = box.querySelectorAll('div');
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      if (el.children.length >= 2 && el.querySelector('button')) {
        const cls = el.className || '';
        if (typeof cls === 'string' && cls.includes('justify-between')) {
          return el;
        }
      }
    }
    return null;
  }

  function ensureTooltip() {
    let tt = document.getElementById(TOOLTIP_ID);
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = TOOLTIP_ID;
      document.body.appendChild(tt);
    }
    return tt;
  }

  function ensureMetricsPill() {
    const box = document.getElementById(INPUT_BOX_ID);
    if (!box) return null;
    const bottomRow = findFooterRow(box);
    if (!bottomRow || bottomRow.children.length < 2) return null;

    const rightGroup = bottomRow.children[bottomRow.children.length - 1];
    if (!rightGroup) return null;

    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      pill.innerHTML = `<span id="${TEXT_ID}"></span>`;

      pill.addEventListener('mouseenter', () => {
        const tt = ensureTooltip();
        if (!tt || !tt.innerHTML) return;
        const r = pill.getBoundingClientRect();
        const ttWidth = tt.offsetWidth || 340;
        const ttHeight = tt.offsetHeight || 220;
        const left = Math.max(12, Math.min(r.right - ttWidth, window.innerWidth - ttWidth - 12));
        const bottomPx = Math.min(window.innerHeight - r.top + 8, window.innerHeight - ttHeight - 12);
        tt.style.left = left + 'px';
        tt.style.bottom = Math.max(8, bottomPx) + 'px';
        tt.setAttribute('data-visible', '1');
      });

      pill.addEventListener('mouseleave', () => {
        const tt = document.getElementById(TOOLTIP_ID);
        if (tt) tt.removeAttribute('data-visible');
      });
    }

    if (pill.parentElement !== rightGroup || pill !== rightGroup.firstElementChild) {
      rightGroup.prepend(pill);
    }

    return pill;
  }

  function renderInlineHtml(inline, t) {
    const latLabel = inline.latencyType === 'ttft' ? t.ttftShort : t.holdShort;
    const ctxCls =
      inline.ctxLevel === 'crit' ? 'ag-ctx-crit' : inline.ctxLevel === 'warn' ? 'ag-ctx-warn' : 'ag-ctx-ok';
    return [
      `<span>${inline.tps} tok/s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>${latLabel} ${inline.latencySec.toFixed(1)}s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>${t.ctxShort} <span class="${ctxCls}">${inline.ctxPct}%</span></span>`
    ].join('');
  }

  function renderTooltipHtml(tip, t) {
    if (!tip) return '';
    const speedSub = tip.speed.isEndToEnd ? `<span class="ag-tt-sub">${t.endToEnd} · </span>` : '';
    const turnRow =
      tip.turn.steps > 1
        ? `<div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.turnTotal} <span class="ag-tt-sub">(${tpl(t.stepsCount, { n: tip.turn.steps })})</span></span>
            <span class="ag-tt-val">${fmtNum(tip.turn.output)} <span class="ag-tt-sub">(${t.thinking} ${fmtNum(tip.turn.thinking)} + ${t.text} ${fmtNum(tip.turn.text)}) · ${tip.turn.duration}s</span></span>
          </div>`
        : '';

    const barCls =
      tip.session.ctxPct >= 90 ? 'is-crit' : tip.session.ctxPct >= 75 ? 'is-warn' : '';
    const barW = Math.min(100, Math.max(0, tip.session.ctxPct));

    return `
      <div class="ag-tt-sec">
        <div class="ag-tt-hdr">
          <span>${t.latestCall}</span>
          <span class="ag-tt-badge">${tpl(t.genBadge, { n: tip.genCount })}</span>
        </div>
        <div class="ag-tt-grid">
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.speed}</span>
            <span class="ag-tt-val">${speedSub}${tip.speed.tps.toFixed(1)} tok/s</span>
          </div>
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.latency}</span>
            <span class="ag-tt-val">${t.wait} ${tip.latency.ttft.toFixed(2)}s · ${t.stream} ${tip.latency.stream.toFixed(2)}s · ${t.total} ${tip.latency.total.toFixed(2)}s</span>
          </div>
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.context}</span>
            <span class="ag-tt-val">${fmtNum(tip.context.total)} <span class="ag-tt-sub">(${t.newTok} ${fmtNum(tip.context.newTok)} · ${t.cached} ${tip.context.cachePct}%)</span></span>
          </div>
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.stepOutput}</span>
            <span class="ag-tt-val">${fmtNum(tip.stepOutput.total)} <span class="ag-tt-sub">(${t.thinking} ${fmtNum(tip.stepOutput.thinking)} + ${t.text} ${fmtNum(tip.stepOutput.text)})</span></span>
          </div>
          ${turnRow}
        </div>
      </div>
      <div class="ag-tt-sec">
        <div class="ag-tt-hdr">
          <span>${t.sessionTotal}</span>
          <span class="ag-tt-badge">${tpl(t.turnsCalls, { turns: tip.session.turns, calls: tip.session.calls })}</span>
        </div>
        <div class="ag-tt-grid">
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.contextWindow}</span>
            <span class="ag-tt-val">${fmtTok(tip.session.ctx)} / ${fmtCeil(tip.session.ctxLimit)} (${tip.session.ctxPct}%) <span class="ag-tt-sub">· ${tpl(t.remaining, { n: fmtTok(tip.session.ctxRemaining) })}</span></span>
          </div>
          <div class="ag-tt-bar-wrap"><div class="ag-tt-bar-fill ${barCls}" style="width:${barW}%"></div></div>
          <div class="ag-tt-row" style="margin-top:4px">
            <span class="ag-tt-lbl">${t.totalInput}</span>
            <span class="ag-tt-val">${fmtTok(tip.session.totalIn)} ${t.newTok} · ${fmtTok(tip.session.totalCache)} ${t.cached} <span class="ag-tt-sub">(${tip.session.cacheHitPct}% ${t.cacheHitRate})</span></span>
          </div>
          <div class="ag-tt-row">
            <span class="ag-tt-lbl">${t.totalOutput}</span>
            <span class="ag-tt-val">${fmtTok(tip.session.totalOut)} <span class="ag-tt-sub">(${t.thinking} ${fmtTok(tip.session.totalThink)} + ${t.text} ${fmtTok(tip.session.totalResp)})</span></span>
          </div>
        </div>
      </div>
    `;
  }

  window.__ag_render_metrics = function (payload) {
    try {
      window.__ag_last_metrics = payload;
      const currentId = extractCascadeId();
      const pill = ensureMetricsPill();
      const ttEl = ensureTooltip();
      if (!pill) return;

      if (!currentId || !payload || !payload.hasData || payload.cascadeId !== currentId) {
        pill.style.display = 'none';
        if (ttEl) ttEl.removeAttribute('data-visible');
        return;
      }

      const t = resolveLocale();
      const textEl = pill.querySelector(`#${TEXT_ID}`);
      const inlineHtml = renderInlineHtml(payload.inline, t);
      if (textEl && textEl.innerHTML !== inlineHtml) {
        textEl.innerHTML = inlineHtml;
      }
      if (ttEl) {
        const tipHtml = renderTooltipHtml(payload.tooltip, t);
        if (ttEl.innerHTML !== tipHtml) {
          ttEl.innerHTML = tipHtml;
        }
      }
      if (pill.style.display !== 'inline-flex') {
        pill.style.display = 'inline-flex';
      }
    } catch {}
  };

  function checkRoute() {
    if (document.hidden) return;
    const cid = extractCascadeId();
    if (!cid) {
      window.__ag_watched_cascade_id = '';
      const pill = document.getElementById(PILL_ID);
      if (pill) pill.style.display = 'none';
      const tt = document.getElementById(TOOLTIP_ID);
      if (tt) tt.removeAttribute('data-visible');
      return;
    }

    if (cid !== window.__ag_watched_cascade_id) {
      window.__ag_watched_cascade_id = cid;
      const pill = ensureMetricsPill();
      if (pill && (!window.__ag_last_metrics || window.__ag_last_metrics.cascadeId !== cid)) {
        pill.style.display = 'none';
      }
      if (typeof window.__agRequestMetrics === 'function') {
        try {
          window.__agRequestMetrics(cid);
        } catch {}
      }
    } else if (window.__ag_last_metrics && window.__ag_last_metrics.cascadeId === cid) {
      const pill = ensureMetricsPill();
      if (pill && window.__ag_last_metrics.hasData && pill.style.display === 'none') {
        window.__ag_render_metrics(window.__ag_last_metrics);
      }
    }
  }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  const onNav = () => setTimeout(checkRoute, 60);
  history.pushState = function (...args) {
    const res = origPush.apply(this, args);
    onNav();
    return res;
  };
  history.replaceState = function (...args) {
    const res = origReplace.apply(this, args);
    onNav();
    return res;
  };
  window.addEventListener('popstate', onNav);

  const pollTimer = setInterval(checkRoute, 1200);
  checkRoute();

  if (window.__ag_last_metrics) {
    window.__ag_render_metrics(window.__ag_last_metrics);
  }

  window.__ag_metrics_version = VERSION;
  window.__ag_metrics_cleanup = () => {
    clearInterval(pollTimer);
    window.removeEventListener('popstate', onNav);
    history.pushState = origPush;
    history.replaceState = origReplace;
    const p = document.getElementById(PILL_ID);
    if (p) p.remove();
    const tt = document.getElementById(TOOLTIP_ID);
    if (tt) tt.remove();
    const st = document.getElementById(STYLE_ID);
    if (st) st.remove();
  };
})(__AG_METRICS_BOOT__);
