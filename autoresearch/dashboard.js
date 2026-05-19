/* Autoresearch live dashboard — polls autoresearch/state.json every 2s.
   Read-only view of the orchestrator's state file.
   Renders 4 ECharts line charts (LCP, FCP, TBT, Perf score), a status banner,
   a current-iteration card, and an iteration log table.

   Robustness:
   - 404 state.json -> show "Waiting for orchestrator..."
   - Partial schema -> defensive defaults everywhere
   - Polling failure -> keep last known state, surface "last update Xs ago"
*/

(function () {
  'use strict';

  // ── Palette (mirrors dashboard.css :root) ───────────────────────────
  var COLOR = {
    paper:       '#f1e8d2',
    paperSoft:   '#ece1c3',
    ink:         '#1a1611',
    inkSoft:     '#2a221a',
    muted:       '#7a6a4c',
    scarlet:     '#e25034',
    scarletDeep: '#c33d22',
    cobalt:      '#1d3da8',
    ochre:       '#e8b94a',
    forest:      '#3a5a3a',
    rule:        '#1a1611',
  };

  var POLL_MS = 2000;
  var STATE_URL = 'state.json';

  // ── ECharts instances ───────────────────────────────────────────────
  var charts = {};
  var CHART_DEFS = [
    { key: 'lcp_ms', el: 'ar-chart-lcp', label: 'LCP (ms)',  lowerBetter: true,  fmt: function (v) { return Math.round(v) + ' ms'; } },
    { key: 'fcp_ms', el: 'ar-chart-fcp', label: 'FCP (ms)',  lowerBetter: true,  fmt: function (v) { return Math.round(v) + ' ms'; } },
    { key: 'tbt_ms', el: 'ar-chart-tbt', label: 'TBT (ms)',  lowerBetter: true,  fmt: function (v) { return Math.round(v) + ' ms'; } },
    { key: 'perf',   el: 'ar-chart-perf',label: 'Perf score',lowerBetter: false, fmt: function (v) { return Number(v).toFixed(2); } },
  ];

  function makeChartOption(def, xs, ys, baselineVal) {
    var markLines = [];
    if (baselineVal !== null && baselineVal !== undefined && !isNaN(baselineVal)) {
      markLines.push({
        yAxis: baselineVal,
        lineStyle: { color: COLOR.muted, type: 'dashed', width: 1 },
        label: {
          formatter: 'baseline ' + def.fmt(baselineVal),
          color: COLOR.muted,
          fontFamily: 'Space Mono, monospace',
          fontSize: 10,
          position: 'insideEndTop',
        },
      });
    }
    return {
      animation: false,
      grid: { left: 44, right: 16, top: 14, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: COLOR.paper,
        borderColor: COLOR.rule,
        borderWidth: 1,
        textStyle: { color: COLOR.ink, fontFamily: 'Space Mono, monospace', fontSize: 11 },
        formatter: function (params) {
          if (!params || !params.length) return '';
          var p = params[0];
          var iter = p.axisValue === 0 ? 'baseline' : 'iter ' + p.axisValue;
          return iter + '<br/>' + def.label + ': <b>' + def.fmt(p.value) + '</b>';
        },
      },
      xAxis: {
        type: 'category',
        data: xs,
        axisLine: { lineStyle: { color: COLOR.rule } },
        axisTick: { show: false },
        axisLabel: {
          color: COLOR.muted,
          fontFamily: 'Space Mono, monospace',
          fontSize: 10,
          formatter: function (v) { return v === '0' || v === 0 ? 'base' : v; },
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: 'rgba(26,22,17,0.10)' } },
        axisLabel: {
          color: COLOR.muted,
          fontFamily: 'Space Mono, monospace',
          fontSize: 10,
          formatter: function (v) { return def.key === 'perf' ? Number(v).toFixed(2) : Math.round(v); },
        },
      },
      series: [{
        type: 'line',
        data: ys,
        smooth: false,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { color: COLOR.scarlet, width: 2 },
        itemStyle: { color: COLOR.scarlet, borderColor: COLOR.paper, borderWidth: 1.5 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(226,80,52,0.18)' },
              { offset: 1, color: 'rgba(226,80,52,0.0)' },
            ],
          },
        },
        markLine: markLines.length ? { silent: true, symbol: 'none', data: markLines } : undefined,
      }],
    };
  }

  function initCharts() {
    CHART_DEFS.forEach(function (def) {
      var el = document.getElementById(def.el);
      if (!el) return;
      charts[def.key] = echarts.init(el, null, { renderer: 'canvas' });
      charts[def.key].setOption(makeChartOption(def, ['0'], [null], null));
    });
    window.addEventListener('resize', function () {
      Object.keys(charts).forEach(function (k) { charts[k].resize(); });
    });
  }

  function updateCharts(state) {
    var baseline = state.baseline || {};
    var iters = Array.isArray(state.iterations) ? state.iterations : [];
    CHART_DEFS.forEach(function (def) {
      var c = charts[def.key];
      if (!c) return;
      var baseVal = baseline[def.key];
      var xs = ['0'];
      var ys = [baseVal === undefined || baseVal === null ? null : baseVal];
      iters.forEach(function (it) {
        var n = it && it.n !== undefined ? it.n : xs.length;
        xs.push(String(n));
        var m = (it && it.metrics) ? it.metrics[def.key] : null;
        ys.push((m === undefined || m === null) ? null : m);
      });
      c.setOption(makeChartOption(def, xs, ys, baseVal == null ? null : baseVal), true);
    });
  }

  // ── Status banner ──────────────────────────────────────────────────
  var STATUS_CLASSES = ['ar-status-idle','ar-status-running','ar-status-complete','ar-status-paused','ar-status-error'];
  function setBannerStatus(status) {
    var b = document.getElementById('ar-status-banner');
    if (!b) return;
    STATUS_CLASSES.forEach(function (c) { b.classList.remove(c); });
    var cls = 'ar-status-' + (status || 'idle');
    if (STATUS_CLASSES.indexOf(cls) === -1) cls = 'ar-status-idle';
    b.classList.add(cls);
  }

  function renderBanner(state) {
    var status = (state.status || 'idle').toLowerCase();
    setBannerStatus(status);
    setText('ar-status-label', status.toUpperCase());
    setText('ar-status-phase', 'phase: ' + (state.phase || '—'));
    var iter = state.current_iter;
    setText('ar-status-iter', 'iter ' + (iter === undefined || iter === null ? '—' : iter));
    var hyp = state.current_hypothesis;
    var hypText = '—';
    if (hyp && (hyp.id || hyp.name)) {
      hypText = (hyp.id ? hyp.id + ' · ' : '') + (hyp.name || '');
    }
    setText('ar-status-hyp', hypText);
  }

  // ── Current iteration card ─────────────────────────────────────────
  function renderCurrent(state) {
    var status = (state.status || 'idle').toLowerCase();
    var hyp = state.current_hypothesis;
    var empty = document.getElementById('ar-current-empty');
    var body = document.getElementById('ar-current-body');
    if (status !== 'running' || !hyp) {
      if (empty) empty.hidden = false;
      if (body) body.hidden = true;
      if (empty) {
        empty.textContent = (status === 'complete')
          ? 'Loop complete.'
          : (status === 'paused')
            ? 'Paused (STOP sentinel detected).'
            : (status === 'error')
              ? 'Error — see orchestrator log.'
              : 'Waiting for orchestrator…';
      }
      return;
    }
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;

    setText('ar-current-id', hyp.id || '—');
    setText('ar-current-name', hyp.name || '—');
    setText('ar-current-phase', 'phase ' + (state.phase || '—'));

    // Live iteration (in-progress) is not yet appended to state.iterations.
    // The orchestrator may stash files_changed on current_hypothesis itself,
    // OR we can introspect a pending record. Support both shapes.
    var pending = state.current_iter_record || null;
    var filesChanged = (hyp.files_changed) || (pending && pending.files_changed) || [];
    var fileList = document.getElementById('ar-current-files');
    if (fileList) {
      fileList.innerHTML = '';
      if (!filesChanged.length) {
        var li = document.createElement('li');
        li.style.opacity = '0.6';
        li.textContent = '(none yet)';
        fileList.appendChild(li);
      } else {
        filesChanged.forEach(function (f) {
          var li = document.createElement('li');
          li.textContent = f;
          fileList.appendChild(li);
        });
      }
    }

    // Before→after deltas (only available after perf_gate completes)
    var deltasWrap = document.getElementById('ar-current-deltas-wrap');
    var deltasBody = document.getElementById('ar-current-deltas');
    var liveMetrics = (pending && pending.metrics) || null;
    var lastKept = lastKeptMetrics(state);
    if (liveMetrics && lastKept) {
      deltasWrap.hidden = false;
      deltasBody.innerHTML = '';
      [
        { key: 'lcp_ms', label: 'LCP', unit: 'ms', lowerBetter: true },
        { key: 'fcp_ms', label: 'FCP', unit: 'ms', lowerBetter: true },
        { key: 'tbt_ms', label: 'TBT', unit: 'ms', lowerBetter: true },
        { key: 'perf',   label: 'Perf',unit: '',   lowerBetter: false },
      ].forEach(function (m) {
        var b = lastKept[m.key];
        var a = liveMetrics[m.key];
        if (b === undefined || a === undefined) return;
        var d = a - b;
        var goodDir = m.lowerBetter ? (d < 0) : (d > 0);
        var sign = d > 0 ? '+' : '';
        var fmt = function (v) { return m.key === 'perf' ? Number(v).toFixed(2) : Math.round(v); };
        var deltaCls = (d === 0) ? '' : (goodDir ? 'ar-delta-pos' : 'ar-delta-neg');
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + m.label + '</td>'
          + '<td>' + fmt(b) + ' → ' + fmt(a) + '</td>'
          + '<td class="' + deltaCls + '">' + sign + fmt(d) + (m.unit ? ' ' + m.unit : '') + '</td>';
        deltasBody.appendChild(tr);
      });
    } else {
      deltasWrap.hidden = true;
    }
  }

  function lastKeptMetrics(state) {
    if (!state) return null;
    var iters = Array.isArray(state.iterations) ? state.iterations : [];
    for (var i = iters.length - 1; i >= 0; i--) {
      if (iters[i] && iters[i].decision === 'KEEP' && iters[i].metrics) return iters[i].metrics;
    }
    return state.baseline || null;
  }

  // ── Iteration log table ────────────────────────────────────────────
  function renderLog(state) {
    var tbody = document.getElementById('ar-log-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    var baseline = state.baseline;
    var iters = Array.isArray(state.iterations) ? state.iterations : [];

    if (!baseline && !iters.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="ar-log-empty">No iterations yet.</td></tr>';
      return;
    }

    // Row 0: baseline
    if (baseline) {
      var tr = document.createElement('tr');
      tr.className = 'ar-row-baseline';
      tr.innerHTML =
        '<td class="ar-cell-n">0</td>' +
        '<td class="ar-cell-hyp"><span class="ar-hyp-id">BASE</span>baseline</td>' +
        '<td class="ar-cell-visdiff">—</td>' +
        '<td class="ar-cell-metric">' + metricCell('lcp_ms', baseline.lcp_ms, null, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('fcp_ms', baseline.fcp_ms, null, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('tbt_ms', baseline.tbt_ms, null, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('perf',   baseline.perf,   null, false) + '</td>' +
        '<td class="ar-cell-decision"><span class="ar-decision-pill ar-decision-baseline">—</span></td>';
      tbody.appendChild(tr);
    }

    // Iteration rows — delta computed vs prior KEEP (or baseline)
    var lastKept = baseline || null;
    iters.forEach(function (it) {
      var m = it.metrics || {};
      var n = it.n !== undefined ? it.n : '—';
      var hyp = it.hypothesis || {};
      var visDiff = maxVisualDiffPct(it.visual_diff_pct);
      var dec = (it.decision || '').toLowerCase();
      var decClass = 'ar-decision-' + (dec || 'baseline');
      var decLabel = it.decision || '—';

      var deltaBase = lastKept;
      var tr2 = document.createElement('tr');
      tr2.innerHTML =
        '<td class="ar-cell-n">' + escapeHtml(String(n)) + '</td>' +
        '<td class="ar-cell-hyp">'
          + '<span class="ar-hyp-id">' + escapeHtml(hyp.id || '?') + '</span>'
          + escapeHtml(hyp.name || '(unnamed)')
          + '</td>' +
        '<td class="ar-cell-visdiff">' + (visDiff === null ? '—' : (visDiff * 100).toFixed(2) + '%') + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('lcp_ms', m.lcp_ms, deltaBase && deltaBase.lcp_ms, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('fcp_ms', m.fcp_ms, deltaBase && deltaBase.fcp_ms, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('tbt_ms', m.tbt_ms, deltaBase && deltaBase.tbt_ms, true) + '</td>' +
        '<td class="ar-cell-metric">' + metricCell('perf',   m.perf,   deltaBase && deltaBase.perf,   false) + '</td>' +
        '<td class="ar-cell-decision"><span class="ar-decision-pill ' + decClass + '">' + escapeHtml(decLabel) + '</span></td>';
      tbody.appendChild(tr2);

      if (it.decision === 'KEEP' && m && (m.lcp_ms !== undefined || m.perf !== undefined)) {
        lastKept = m;
      }
    });
  }

  function maxVisualDiffPct(vd) {
    if (!vd || typeof vd !== 'object') return null;
    var vals = Object.keys(vd).map(function (k) { return vd[k]; }).filter(function (v) { return typeof v === 'number'; });
    if (!vals.length) return null;
    return Math.max.apply(null, vals);
  }

  function metricCell(key, val, prev, lowerBetter) {
    if (val === undefined || val === null || isNaN(val)) {
      return '<span class="ar-metric-val">—</span>';
    }
    var fmt = (key === 'perf')
      ? function (v) { return Number(v).toFixed(2); }
      : function (v) { return Math.round(v) + ' ms'; };
    var html = '<span class="ar-metric-val">' + fmt(val) + '</span>';
    if (prev !== undefined && prev !== null && !isNaN(prev)) {
      var d = val - prev;
      if (d !== 0) {
        var goodDir = lowerBetter ? (d < 0) : (d > 0);
        var sign = d > 0 ? '+' : '';
        var deltaFmt = (key === 'perf')
          ? sign + d.toFixed(2)
          : sign + Math.round(d);
        var cls = goodDir ? 'ar-delta-pos' : 'ar-delta-neg';
        html += '<span class="ar-metric-delta ' + cls + '">' + deltaFmt + '</span>';
      }
    }
    return html;
  }

  // ── Deploy banner ───────────────────────────────────────────────────
  function renderDeployBanner(state) {
    var b = document.getElementById('ar-deploy-banner');
    if (!b) return;
    b.hidden = ((state.status || '').toLowerCase() !== 'complete');
  }

  // ── Polling loop ───────────────────────────────────────────────────
  var lastState = null;
  var lastUpdateTs = null;     // wall-clock ms of last successful fetch
  var consecutiveFailures = 0;

  function tickAgeIndicator() {
    var el = document.getElementById('ar-last-update');
    if (!el) return;
    if (lastUpdateTs === null) {
      el.textContent = 'last update: —';
      return;
    }
    var ageSec = Math.round((Date.now() - lastUpdateTs) / 1000);
    var stale = (consecutiveFailures > 0) ? ' · stale' : '';
    el.textContent = 'last update: ' + ageSec + 's ago' + stale;
  }

  function poll() {
    fetch(STATE_URL, { cache: 'no-store' })
      .then(function (resp) {
        if (resp.status === 404) {
          consecutiveFailures = 0; // 404 is "not yet" not "broken"
          if (!lastState) showWaiting();
          return null;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (state) {
        if (!state) return;
        lastState = state;
        lastUpdateTs = Date.now();
        consecutiveFailures = 0;
        renderAll(state);
      })
      .catch(function (err) {
        consecutiveFailures++;
        // Keep last good state on screen; just update the age indicator.
        // Don't spam console; show one warn.
        if (consecutiveFailures === 1) console.warn('autoresearch: poll failed', err);
      });
  }

  function showWaiting() {
    setBannerStatus('idle');
    setText('ar-status-label', 'WAITING');
    setText('ar-status-phase', 'phase: —');
    setText('ar-status-iter', 'iter —');
    setText('ar-status-hyp', 'Waiting for orchestrator to start…');
    var empty = document.getElementById('ar-current-empty');
    var body = document.getElementById('ar-current-body');
    if (empty) { empty.hidden = false; empty.textContent = 'Waiting for orchestrator…'; }
    if (body) body.hidden = true;
  }

  function renderAll(state) {
    renderBanner(state);
    renderCurrent(state);
    updateCharts(state);
    renderLog(state);
    renderDeployBanner(state);
  }

  // ── Utilities ───────────────────────────────────────────────────────
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Boot ───────────────────────────────────────────────────────────
  function boot() {
    initCharts();
    showWaiting();
    poll();
    setInterval(poll, POLL_MS);
    setInterval(tickAgeIndicator, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
