/* UI wiring. Everything measurable lives in engine.js; everything numeric
   lives in stats.js. This file only moves values onto the page. */
(function () {
  'use strict';

  var HISTORY_KEY = 'isc-history';
  var HISTORY_MAX = 10;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    phase: $('phase'), bigNum: $('bigNum'), bigUnit: $('bigUnit'),
    bar: $('bar'), barFill: $('barFill'),
    start: $('startBtn'), stop: $('stopBtn'), error: $('error'),
    readiness: $('readiness'),
    down: $('resDown'), up: $('resUp'), ping: $('resPing'), jitter: $('resJitter'),
    loss: $('resLoss'), bloat: $('resBloat'), bloatGrade: $('resBloatGrade'), bloatHint: $('resBloatHint'),
    meta: $('meta'),
    historyTable: $('historyTable'), historyBody: $('historyBody'),
    historyEmpty: $('historyEmpty'), clear: $('clearBtn')
  };
  var ready = {
    streaming: { grade: $('rsGrade'), head: $('rsHead'), detail: $('rsDetail') },
    gaming: { grade: $('rgGrade'), head: $('rgHead'), detail: $('rgDetail') },
    videoCall: { grade: $('rvGrade'), head: $('rvHead'), detail: $('rvDetail') }
  };

  var PHASE_LABEL = {
    latency: 'Measuring latency',
    download: 'Testing download',
    upload: 'Testing upload',
    done: 'Complete'
  };
  // Each phase owns a slice of the progress bar.
  var PHASE_SPAN = { latency: [0, 0.15], download: [0.15, 0.65], upload: [0.65, 1] };

  var controller = null;

  // ── History (this browser only) ──────────────────────────────────────
  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* private mode etc. */ }
  }
  function serverLabel(server) {
    if (!server) return '—';
    var place = [server.city, server.country].filter(Boolean).join(', ');
    return place ? place + (server.colo ? ' (' + server.colo + ')' : '') : (server.colo || server.node || '—');
  }
  function renderHistory() {
    var list = loadHistory();
    el.historyTable.hidden = list.length === 0;
    el.historyEmpty.hidden = list.length !== 0;
    el.clear.hidden = list.length === 0;
    el.historyBody.textContent = '';
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      var when = new Date(r.startedAt);
      var cells = [
        when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        Stats.formatMbps(r.downloadMbps), Stats.formatMbps(r.uploadMbps),
        Stats.formatMs(r.latencyMs), Stats.formatMs(r.jitterMs),
        Stats.formatPct(r.packetLossPct), Stats.bufferbloatGrade(r.bufferbloatMs).grade,
        serverLabel(r.server)
      ];
      cells.forEach(function (text, i) {
        var td = document.createElement('td');
        if (i >= 1 && i <= 6) td.className = 'r';
        td.textContent = text;
        tr.appendChild(td);
      });
      el.historyBody.appendChild(tr);
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function setBar(fraction) {
    var pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    el.barFill.style.width = pct + '%';
    el.bar.setAttribute('aria-valuenow', String(pct));
  }
  function setBig(num, unit) {
    el.bigNum.textContent = num;
    el.bigUnit.textContent = unit;
  }
  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }
  function resetResults() {
    ['down', 'up', 'ping', 'jitter', 'loss', 'bloat'].forEach(function (k) { el[k].textContent = '—'; });
    el.bloatGrade.textContent = '';
    el.bloatHint.textContent = 'Extra latency while the link is busy';
    el.readiness.hidden = true;
    el.meta.hidden = true;
    el.error.hidden = true;
  }
  function setRunning(running) {
    el.start.disabled = running;
    el.start.textContent = running ? 'Testing…' : 'Start test';
    el.stop.hidden = !running;
  }

  function onPhase(name) {
    el.phase.textContent = PHASE_LABEL[name] || name;
    if (name === 'latency') setBig('—', 'ms');
    if (name === 'download' || name === 'upload') setBig('0.00', 'Mbps');
  }

  function onProgress(p) {
    var span = PHASE_SPAN[p.phase];
    if (span) setBar(span[0] + (span[1] - span[0]) * (p.fraction || 0));
    if (p.phase === 'latency' && p.latencyMs != null) setBig(Stats.formatMs(p.latencyMs), 'ms');
    if ((p.phase === 'download' || p.phase === 'upload') && p.mbps != null) setBig(Stats.formatMbps(p.mbps), 'Mbps');
  }

  function showReadiness(r) {
    var scores = Stats.readiness(r);
    Object.keys(ready).forEach(function (key) {
      var s = scores[key], slot = ready[key];
      slot.grade.textContent = s.grade;
      slot.grade.setAttribute('data-grade', s.grade);
      slot.head.textContent = s.headline;
      slot.detail.textContent = s.detail;
    });
    el.readiness.hidden = false;
  }

  function showResult(r) {
    el.down.textContent = Stats.formatMbps(r.downloadMbps);
    el.up.textContent = Stats.formatMbps(r.uploadMbps);
    el.ping.textContent = Stats.formatMs(r.latencyMs);
    el.jitter.textContent = Stats.formatMs(r.jitterMs);
    el.loss.textContent = Stats.formatPct(r.packetLossPct);

    var bb = Stats.bufferbloatGrade(r.bufferbloatMs);
    el.bloat.textContent = bb.grade;
    el.bloatGrade.textContent = isFinite(r.bufferbloatMs) ? '+' + Stats.formatMs(r.bufferbloatMs) + ' ms' : '';
    el.bloatHint.textContent = bb.label;

    setBig(Stats.formatMbps(r.downloadMbps), 'Mbps');
    setBar(1);
    showReadiness(r);

    var bits = [];
    if (r.server) {
      var place = serverLabel(r.server);
      if (place !== '—') bits.push('Test server: ' + place);
      if (r.server.ip) bits.push('Your IP: ' + r.server.ip);
    }
    bits.push('Transferred ' + (((r.downloadBytes || 0) + (r.uploadBytes || 0)) / 1e6).toFixed(0) + ' MB');
    el.meta.textContent = bits.join(' · ');
    el.meta.hidden = false;
  }

  // ── Actions ──────────────────────────────────────────────────────────
  function start() {
    if (controller) return;
    controller = new AbortController();
    resetResults();
    setRunning(true);
    setBar(0);

    SpeedEngine.runTest({ signal: controller.signal, onPhase: onPhase, onProgress: onProgress })
      .then(function (result) {
        showResult(result);
        var list = loadHistory();
        list.unshift(result);
        saveHistory(list);
        renderHistory();
      })
      .catch(function (err) {
        var stopped = err && err.name === 'AbortError';
        el.phase.textContent = stopped ? 'Stopped' : 'Something went wrong';
        setBig('—', 'Mbps');
        if (!stopped) {
          showError((err && err.message) || 'The test could not complete. Check your connection and try again.');
        }
      })
      .then(function () {
        controller = null;
        setRunning(false);
      });
  }

  function stop() {
    if (controller) controller.abort();
  }

  function clearHistory() {
    if (!confirm('Remove all saved results from this device?')) return;
    saveHistory([]);
    renderHistory();
  }

  el.start.addEventListener('click', start);
  el.stop.addEventListener('click', stop);
  el.clear.addEventListener('click', clearHistory);

  // Keyboard: Space or Enter on the page starts a test when nothing is focused.
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === document.body && !controller) {
      e.preventDefault();
      start();
    }
  });

  renderHistory();

  // Installable on phones: register the app-shell service worker. It never
  // caches cross-origin requests, so the test itself always hits the network.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
  }
})();
