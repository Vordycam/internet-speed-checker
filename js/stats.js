/* Pure maths and scoring for the speed test. No DOM, no network — so it can
   be unit tested in Node with `npm test`. Loaded in the browser as
   window.Stats. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sorted(values) {
    return values.slice().sort(function (a, b) { return a - b; });
  }

  function mean(values) {
    if (!values.length) return NaN;
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    return total / values.length;
  }

  function median(values) {
    if (!values.length) return NaN;
    var s = sorted(values), mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /* Linear-interpolated percentile, p in [0, 1]. */
  function percentile(values, p) {
    if (!values.length) return NaN;
    var s = sorted(values);
    if (s.length === 1) return s[0];
    var pos = Math.min(Math.max(p, 0), 1) * (s.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /* Jitter, RFC 3550 style: mean absolute difference between consecutive
     latency samples. Needs at least two samples. */
  function jitter(latencies) {
    if (latencies.length < 2) return 0;
    var total = 0;
    for (var i = 1; i < latencies.length; i++) {
      total += Math.abs(latencies[i] - latencies[i - 1]);
    }
    return total / (latencies.length - 1);
  }

  /* Bytes over milliseconds -> megabits per second (decimal mega, as ISPs
     advertise). 1 byte = 8 bits; 1 Mbit = 1,000,000 bits. */
  function toMbps(bytes, ms) {
    if (!(ms > 0)) return 0;
    return (bytes * 8) / (ms / 1000) / 1e6;
  }

  /* Bufferbloat: how much latency rises when the link is saturated. Takes
     the worse of the download and upload loaded medians. NaN inputs are
     skipped; if neither is available the answer is NaN. */
  function bufferbloat(idleMs, loadedDownMs, loadedUpMs) {
    var worst = -Infinity;
    if (isFinite(loadedDownMs)) worst = Math.max(worst, loadedDownMs);
    if (isFinite(loadedUpMs)) worst = Math.max(worst, loadedUpMs);
    if (!isFinite(worst) || !isFinite(idleMs)) return NaN;
    return Math.max(0, worst - idleMs);
  }

  /* Letter grade for bufferbloat, using the same bands as the widely
     quoted Waveform test so people can compare. */
  function bufferbloatGrade(ms) {
    if (!isFinite(ms)) return { grade: '—', label: 'Not measured' };
    if (ms < 5) return { grade: 'A+', label: 'No bufferbloat' };
    if (ms < 30) return { grade: 'A', label: 'Barely noticeable' };
    if (ms < 60) return { grade: 'B', label: 'Slight lag under load' };
    if (ms < 200) return { grade: 'C', label: 'Noticeable lag under load' };
    if (ms < 400) return { grade: 'D', label: 'Heavy lag under load' };
    return { grade: 'F', label: 'Severe bufferbloat' };
  }

  /* Human-friendly speed: two decimals below 10, one below 100, none above. */
  function formatMbps(mbps) {
    if (!isFinite(mbps) || mbps < 0) return '—';
    if (mbps < 10) return mbps.toFixed(2);
    if (mbps < 100) return mbps.toFixed(1);
    return Math.round(mbps).toString();
  }

  function formatMs(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    return ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();
  }

  function formatPct(pct) {
    if (!isFinite(pct) || pct < 0) return '—';
    return pct === 0 ? '0' : pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  }

  // ── Activity readiness ───────────────────────────────────────────────
  /* Each scorer returns {score 0-100, grade, headline, detail}. Scores are
     built as a base from the metric that matters most, then penalties for
     the things that ruin the experience in practice (loss, jitter, lag
     under load). Thresholds follow published guidance from Netflix, YouTube,
     Zoom and Microsoft Teams and the usual competitive-gaming rules of
     thumb; they are deliberately conservative. */

  function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

  function grade(score) {
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 55) return 'C';
    if (score >= 35) return 'D';
    return 'F';
  }

  function num(v, fallback) { return isFinite(v) ? v : fallback; }

  /* Streaming: sustained download is what matters. 4K UHD wants 25 Mbps
     (Netflix's own figure, with headroom), 1080p 5-8 Mbps, 720p 3 Mbps.
     Packet loss causes rebuffering even at high speed. */
  function streaming(r) {
    var d = num(r.downloadMbps, 0), loss = num(r.packetLossPct, 0);
    var tier, base;
    if (d >= 50)      { tier = '4K on several screens'; base = 100; }
    else if (d >= 25) { tier = '4K ready'; base = 92; }
    else if (d >= 8)  { tier = '1080p ready'; base = 78; }
    else if (d >= 3)  { tier = '720p ready'; base = 58; }
    else if (d >= 1)  { tier = 'Standard definition only'; base = 35; }
    else              { tier = 'Not suitable for video'; base = 10; }
    var penalty = loss > 3 ? 30 : loss > 1 ? 15 : loss > 0 ? 5 : 0;
    var score = clamp(base - penalty);
    var detail = 'Download ' + formatMbps(d) + ' Mbps';
    if (loss > 0) detail += ', ' + formatPct(loss) + '% packet loss may cause rebuffering';
    return { score: score, grade: grade(score), headline: tier, detail: detail + '.' };
  }

  /* Gaming: latency, its stability, loss, and what happens when someone
     else in the house starts a download (bufferbloat). Throughput hardly
     matters beyond a few Mbps. */
  function gaming(r) {
    var l = num(r.latencyMs, 999), j = num(r.jitterMs, 0), loss = num(r.packetLossPct, 0), bb = num(r.bufferbloatMs, 0);
    var base;
    if (l < 20) base = 100;
    else if (l < 40) base = 92;
    else if (l < 60) base = 82;
    else if (l < 100) base = 65;
    else if (l < 150) base = 45;
    else base = 20;
    var penalty = 0;
    penalty += j > 30 ? 25 : j > 15 ? 12 : j > 8 ? 5 : 0;
    penalty += loss > 2 ? 35 : loss > 0.5 ? 15 : loss > 0 ? 6 : 0;
    penalty += bb >= 200 ? 30 : bb >= 60 ? 15 : bb >= 30 ? 6 : 0;
    var score = clamp(base - penalty);
    var headline = score >= 90 ? 'Competitive ready'
      : score >= 75 ? 'Great for online play'
      : score >= 55 ? 'Fine for casual play'
      : score >= 35 ? 'Expect some lag'
      : 'Not good for online gaming';
    var parts = ['Latency ' + formatMs(l) + ' ms', 'jitter ' + formatMs(j) + ' ms'];
    if (loss > 0) parts.push(formatPct(loss) + '% loss');
    if (bb >= 30) parts.push('+' + formatMs(bb) + ' ms under load');
    return { score: score, grade: grade(score), headline: headline, detail: parts.join(', ') + '.' };
  }

  /* Video calls: upload is the scarce resource. Zoom asks 3.8 Mbps up for
     1080p and Teams 2.5 Mbps for group HD; 1.2 Mbps gets a 720p call.
     Jitter and loss are what make a call break up, and upload bufferbloat
     is what freezes your video while a backup runs. */
  function videoCall(r) {
    var u = num(r.uploadMbps, 0), j = num(r.jitterMs, 0), loss = num(r.packetLossPct, 0), l = num(r.latencyMs, 0);
    var loadedUp = num(r.loadedLatencyUpMs, NaN);
    var bbUp = isFinite(loadedUp) ? Math.max(0, loadedUp - l) : 0;
    var tier, base;
    if (u >= 10)       { tier = 'HD calls with screen sharing'; base = 100; }
    else if (u >= 3.8) { tier = '1080p calls ready'; base = 90; }
    else if (u >= 2.5) { tier = 'HD group calls ready'; base = 78; }
    else if (u >= 1.2) { tier = '720p calls ready'; base = 60; }
    else if (u >= 0.6) { tier = 'Audio and low-res video'; base = 38; }
    else               { tier = 'Audio only'; base = 15; }
    var penalty = 0;
    penalty += j > 40 ? 30 : j > 20 ? 15 : j > 10 ? 6 : 0;
    penalty += loss > 3 ? 35 : loss > 1 ? 18 : loss > 0 ? 6 : 0;
    penalty += l > 300 ? 25 : l > 150 ? 10 : 0;
    penalty += bbUp >= 200 ? 20 : bbUp >= 60 ? 10 : 0;
    var score = clamp(base - penalty);
    var parts = ['Upload ' + formatMbps(u) + ' Mbps', 'jitter ' + formatMs(j) + ' ms'];
    if (loss > 0) parts.push(formatPct(loss) + '% loss');
    if (bbUp >= 60) parts.push('upload lag +' + formatMs(bbUp) + ' ms under load');
    return { score: score, grade: grade(score), headline: tier, detail: parts.join(', ') + '.' };
  }

  function readiness(result) {
    return {
      streaming: streaming(result),
      gaming: gaming(result),
      videoCall: videoCall(result)
    };
  }

  /* One-paragraph summary for the result page. */
  function verdict(result) {
    var r = readiness(result);
    var bb = bufferbloatGrade(result.bufferbloatMs);
    var s = 'Streaming: ' + r.streaming.headline.toLowerCase() + '. '
          + 'Gaming: ' + r.gaming.headline.toLowerCase() + '. '
          + 'Video calls: ' + r.videoCall.headline.toLowerCase() + '.';
    if (bb.grade !== '—') s += ' Bufferbloat grade ' + bb.grade + ': ' + bb.label.toLowerCase() + '.';
    return s;
  }

  return {
    mean: mean,
    median: median,
    percentile: percentile,
    jitter: jitter,
    toMbps: toMbps,
    bufferbloat: bufferbloat,
    bufferbloatGrade: bufferbloatGrade,
    formatMbps: formatMbps,
    formatMs: formatMs,
    formatPct: formatPct,
    readiness: readiness,
    verdict: verdict
  };
});
