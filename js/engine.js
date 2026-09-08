/* Measurement engine.

   Talks to a set of test endpoints (by default Cloudflare's public
   speed-test edge, the same one speed.cloudflare.com uses, which allows
   cross-origin use and exposes location and timing headers). The endpoints
   are configurable so the client can later point at our own edge nodes
   without changing anything else.

   Written without DOM access so the same file runs in the browser
   (window.SpeedEngine) and in Node 18+ for the smoke test. Depends on
   Stats (js/stats.js). */
(function (root, factory) {
  var stats = (typeof module === 'object' && module.exports)
    ? require('./stats.js')
    : root.Stats;
  var api = factory(stats);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpeedEngine = api;
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  /* An endpoint set is one test node. `down` must accept ?bytes=N and
     stream that many bytes; `up` must accept a POST body and discard it.

     `probe` is the latency target and MUST be on a different hostname from
     `down`/`up`. Browsers put every request to one host on a single HTTP/2
     connection, so a probe sent to the transfer host during a test waits
     behind megabytes already queued on that socket and reports the
     browser's own buffering (seconds of it) instead of the network. On its
     own host the probe gets its own connection and measures the path,
     which is what bufferbloat is. Cloudflare's trace endpoint is tiny,
     allows cross-origin use, and names the edge (colo) and country. */
  var CLOUDFLARE = {
    name: 'Cloudflare edge',
    down: 'https://speed.cloudflare.com/__down',
    up: 'https://speed.cloudflare.com/__up',
    probe: 'https://cloudflare.com/cdn-cgi/trace'
  };

  var DEFAULTS = {
    node: CLOUDFLARE,
    latencySamples: 20,
    latencyTimeoutMs: 3000,   // a probe slower than this counts as a lost packet
    downloadMs: 10000,
    uploadMs: 8000,
    // Parallel connections. Several streams saturate a fast link far better
    // than one, which is what every mainstream speed test does.
    downloadStreams: 6,
    uploadStreams: 4,
    // Ignore the first part of each throughput phase while TCP ramps up.
    warmupMs: 1500,
    // Bytes requested per download stream; aborted when the phase ends. A
    // stream that drains its payload early simply opens another request.
    // Cloudflare returns 403 above 50 MB, so stay at that ceiling.
    downloadRequestBytes: 50 * 1000 * 1000,
    // Upload starts small and grows while requests finish quickly. The cap
    // is deliberately modest: measured in Chrome on a ~100 Mbps uplink,
    // 16 MiB bodies starved the concurrent latency probes (1 completed in
    // 5 s) and depressed throughput to 68 Mbps, while 1 MiB bodies let the
    // probes through (18 in 5 s) and measured 106 Mbps. Big bodies sit in
    // the browser's network process, not on the wire.
    uploadChunkMin: 128 * 1024,
    uploadChunkMax: 1024 * 1024,
    // Latency probes fired while the link is saturated, for bufferbloat.
    loadedProbeIntervalMs: 250
  };

  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  function bust(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'r=' + Math.random().toString(36).slice(2);
  }

  /* Cloudflare reports its own processing time as
     "Server-Timing: cfSpeedEdge;dur=4, cfSpeedWorker;dur=20". Subtracting it
     leaves the part of the round trip that is actually the network. Our own
     nodes should emit the same header shape. */
  function serverProcessingMs(headers) {
    var raw = headers && headers.get ? headers.get('server-timing') : null;
    if (!raw) return 0;
    var total = 0;
    var re = /cfSpeed[A-Za-z]*;\s*dur=([\d.]+)/g, m;
    while ((m = re.exec(raw)) !== null) total += parseFloat(m[1]) || 0;
    return total;
  }

  /* Location from whatever the probe returned: Cloudflare's trace body is
     "key=value" lines (ip, colo, loc, http, ...); cf-meta-* headers are read
     when present so our own nodes can supply richer data. */
  function serverInfo(headers, body, node) {
    function h(name) { return (headers && headers.get(name)) || ''; }
    var trace = {};
    (body || '').split('\n').forEach(function (line) {
      var eq = line.indexOf('=');
      if (eq > 0) trace[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    return {
      node: node.name,
      colo: h('cf-meta-colo') || trace.colo || '',
      city: h('cf-meta-city') || '',
      country: h('cf-meta-country') || trace.loc || '',
      ip: h('cf-meta-ip') || trace.ip || '',
      asn: h('cf-meta-asn') || '',
      protocol: trace.http || ''
    };
  }

  function abortError() {
    var e = new Error('Test stopped.');
    e.name = 'AbortError';
    return e;
  }

  /* One timed zero-byte request. Resolves to {ms, headers} or {lost: true}
     when it times out or fails. Aborting via `signal` rejects instead. */
  function probe(node, timeoutMs, signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    var onOuter = function () { ctrl.abort(); };
    if (signal) signal.addEventListener('abort', onOuter);
    var url = node.probe || (node.down + '?bytes=0');
    var t0 = now();
    return fetch(bust(url), { cache: 'no-store', signal: ctrl.signal })
      .then(function (res) {
        // Timed to first byte of the response, so the (tiny) body is free.
        var rtt = now() - t0;
        if (!res.ok) throw new Error('Probe failed with HTTP ' + res.status);
        return res.text().then(function (body) {
          return { ms: Math.max(0, rtt - serverProcessingMs(res.headers)), headers: res.headers, body: body };
        });
      })
      .catch(function (err) {
        if (signal && signal.aborted) throw abortError();
        return { lost: true, error: err };
      })
      .then(function (r) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuter);
        return r;
      });
  }

  // ── Latency, jitter, packet loss ─────────────────────────────────────
  function measureLatency(opts) {
    opts = opts || {};
    var node = opts.node || DEFAULTS.node;
    var samples = opts.samples || DEFAULTS.latencySamples;
    var timeoutMs = opts.timeoutMs || DEFAULTS.latencyTimeoutMs;
    var signal = opts.signal;
    var results = [], lost = 0, info = null;

    // One untimed warm-up request opens the connection so the first real
    // sample is not paying for DNS + TLS.
    return probe(node, timeoutMs, signal).then(function () {
      var chain = Promise.resolve();
      for (var i = 0; i < samples; i++) {
        (function (idx) {
          chain = chain.then(function () {
            return probe(node, timeoutMs, signal).then(function (r) {
              if (r.lost) { lost++; }
              else {
                results.push(r.ms);
                if (!info) info = serverInfo(r.headers, r.body, node);
              }
              if (opts.onSample) opts.onSample(r.lost ? null : r.ms, idx + 1, samples);
            });
          });
        })(i);
      }
      return chain;
    }).then(function () {
      if (!results.length) throw new Error('The test server could not be reached. Check your connection.');
      return {
        latencyMs: Stats.median(results),
        jitterMs: Stats.jitter(results),
        minMs: Math.min.apply(null, results),
        packetLossPct: (lost / samples) * 100,
        samples: results,
        lost: lost,
        server: info
      };
    });
  }

  // ── Throughput bookkeeping shared by download and upload ─────────────
  /* Records (time, bytes) events and reports speed over the whole phase
     after warm-up, plus a short trailing window for the live number. */
  function Tally(warmupMs) {
    this.start = now();
    this.warmupMs = warmupMs;
    this.events = [];      // [t, bytes] relative to start
    this.total = 0;
  }
  Tally.prototype.add = function (bytes) {
    var t = now() - this.start;
    this.events.push([t, bytes]);
    this.total += bytes;
  };
  Tally.prototype.elapsed = function () { return now() - this.start; };
  /* Live speed: bytes in the last `windowMs`. */
  Tally.prototype.recentMbps = function (windowMs) {
    var t = this.elapsed(), since = t - windowMs, bytes = 0;
    for (var i = this.events.length - 1; i >= 0 && this.events[i][0] >= since; i--) {
      bytes += this.events[i][1];
    }
    return Stats.toMbps(bytes, Math.min(windowMs, t));
  };
  /* Final speed: everything after warm-up, over the time after warm-up. */
  Tally.prototype.finalMbps = function () {
    var t = this.elapsed();
    if (t <= this.warmupMs) return Stats.toMbps(this.total, t);
    var bytes = 0;
    for (var i = 0; i < this.events.length; i++) {
      if (this.events[i][0] >= this.warmupMs) bytes += this.events[i][1];
    }
    return Stats.toMbps(bytes, t - this.warmupMs);
  };

  /* Fires latency probes on a fixed interval while `isDone()` is false.
     What comes back is "loaded latency": how long a round trip takes while
     the link is saturated. The rise over idle latency is bufferbloat. */
  function loadedProbes(node, intervalMs, timeoutMs, signal, isDone) {
    var samples = [], lost = 0;
    return new Promise(function (resolve) {
      var active = 0, stopped = false;
      var timer = setInterval(function () {
        if (isDone()) { stopped = true; clearInterval(timer); if (!active) resolve(); return; }
        if (active >= 2) return;   // never let probes pile up
        active++;
        probe(node, timeoutMs, signal).then(function (r) {
          if (r.lost) lost++; else samples.push(r.ms);
        }).catch(function () { /* aborted */ }).then(function () {
          active--;
          if (stopped && !active) resolve();
        });
      }, intervalMs);
    }).then(function () {
      return { medianMs: samples.length ? Stats.median(samples) : NaN, samples: samples, lost: lost };
    });
  }

  function progressLoop(tally, durationMs, onProgress, isDone) {
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        var t = tally.elapsed();
        if (onProgress) {
          onProgress({ mbps: tally.recentMbps(1000), fraction: Math.min(1, t / durationMs), bytes: tally.total });
        }
        if (isDone()) { clearInterval(timer); resolve(); }
      }, 200);
    });
  }

  /* Shared driver for the download and upload phases. `makeStream` starts
     one worker that keeps transferring until `state.finished`. */
  function throughputPhase(opts, defaultsMs, defaultStreams, makeStream, emptyMessage) {
    var node = opts.node || DEFAULTS.node;
    var durationMs = opts.durationMs || defaultsMs;
    var streams = opts.streams || defaultStreams;
    var warmup = Math.min(opts.warmupMs != null ? opts.warmupMs : DEFAULTS.warmupMs, durationMs / 2);
    var state = { tally: new Tally(warmup), ctrl: new AbortController(), finished: false, failure: null, node: node };

    if (opts.signal) opts.signal.addEventListener('abort', function () { state.ctrl.abort(); });

    var deadline = now() + durationMs;
    var isDone = function () {
      return state.failure !== null || now() >= deadline || (opts.signal && opts.signal.aborted);
    };

    var workers = [];
    for (var i = 0; i < streams; i++) workers.push(makeStream(state));

    // Probes share the phase's own abort controller, so an in-flight probe is
    // cut off the moment the phase ends instead of holding the next phase up
    // for as long as its timeout.
    var loaded = opts.loadedProbes === false
      ? Promise.resolve(null)
      : loadedProbes(node, DEFAULTS.loadedProbeIntervalMs, DEFAULTS.latencyTimeoutMs, state.ctrl.signal, isDone);

    return progressLoop(state.tally, durationMs, opts.onProgress, isDone)
      .then(function () {
        state.finished = true;
        state.ctrl.abort();
        return Promise.all([Promise.all(workers), loaded]);
      })
      .then(function (results) {
        if (opts.signal && opts.signal.aborted) throw abortError();
        if (state.failure) throw state.failure;
        if (state.tally.total === 0) throw new Error(emptyMessage);
        return {
          mbps: state.tally.finalMbps(),
          bytes: state.tally.total,
          ms: state.tally.elapsed(),
          loadedLatency: results[1]
        };
      });
  }

  // ── Download ─────────────────────────────────────────────────────────
  function measureDownload(opts) {
    opts = opts || {};
    return throughputPhase(opts, DEFAULTS.downloadMs, DEFAULTS.downloadStreams, function stream(state) {
      if (state.finished) return Promise.resolve();
      return fetch(bust(state.node.down + '?bytes=' + DEFAULTS.downloadRequestBytes), {
        cache: 'no-store', signal: state.ctrl.signal
      }).then(function (res) {
        if (!res.ok) throw new Error('Download failed with HTTP ' + res.status);
        var reader = res.body.getReader();
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return state.finished ? null : stream(state);  // payload ran out: reopen
            state.tally.add(r.value.byteLength);
            return pump();
          });
        }
        return pump();
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        state.failure = state.failure || err;
      });
    }, 'No data was received. Check your connection.');
  }

  // ── Upload ───────────────────────────────────────────────────────────
  var randomPool = null;
  function randomBytes(size) {
    // Random data defeats any compression between here and the server.
    // One 1 MiB pool, tiled: getRandomValues caps at 64 KiB per call and
    // fresh randomness per chunk is not needed.
    if (!randomPool) {
      randomPool = new Uint8Array(1024 * 1024);
      for (var off = 0; off < randomPool.length; off += 65536) {
        crypto.getRandomValues(randomPool.subarray(off, off + 65536));
      }
    }
    if (size <= randomPool.length) return randomPool.subarray(0, size);
    var out = new Uint8Array(size);
    for (var o = 0; o < size; o += randomPool.length) {
      out.set(randomPool.subarray(0, Math.min(randomPool.length, size - o)), o);
    }
    return out;
  }

  function measureUpload(opts) {
    opts = opts || {};
    var chunk = DEFAULTS.uploadChunkMin;
    return throughputPhase(opts, DEFAULTS.uploadMs, DEFAULTS.uploadStreams, function stream(state) {
      if (state.finished) return Promise.resolve();
      var size = chunk;
      var t0 = now();
      return fetch(bust(state.node.up), {
        method: 'POST',
        body: randomBytes(size),
        headers: { 'Content-Type': 'application/octet-stream' },
        cache: 'no-store',
        signal: state.ctrl.signal
      }).then(function (res) {
        if (!res.ok) throw new Error('Upload failed with HTTP ' + res.status);
        return res.arrayBuffer();
      }).then(function () {
        // Only count requests that completed inside the window. A chunk still
        // in flight at the deadline would inflate the total.
        if (!state.finished) {
          state.tally.add(size);
          // Grow the chunk while requests finish in under a second, so fast
          // links are not throttled by per-request overhead.
          if (now() - t0 < 1000 && chunk < DEFAULTS.uploadChunkMax) chunk *= 2;
        }
        return stream(state);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        state.failure = state.failure || err;
      });
    }, 'No upload completed. The connection may be very slow or blocked.');
  }

  // ── Full run ─────────────────────────────────────────────────────────
  /* opts.onPhase(name)        'latency' | 'download' | 'upload' | 'done'
     opts.onProgress({phase, mbps, fraction, ...})
     opts.signal               AbortSignal to stop early
     opts.node                 endpoint set (defaults to Cloudflare) */
  function runTest(opts) {
    opts = opts || {};
    var node = opts.node || DEFAULTS.node;
    var phase = function (name) { if (opts.onPhase) opts.onPhase(name); };
    var progress = function (name, p) { p.phase = name; if (opts.onProgress) opts.onProgress(p); };
    var result = { startedAt: new Date().toISOString() };

    phase('latency');
    return measureLatency({
      node: node, samples: opts.latencySamples, signal: opts.signal,
      onSample: function (ms, i, n) { progress('latency', { mbps: null, latencyMs: ms, fraction: i / n }); }
    }).then(function (lat) {
      result.latencyMs = lat.latencyMs;
      result.jitterMs = lat.jitterMs;
      result.minLatencyMs = lat.minMs;
      result.packetLossPct = lat.packetLossPct;
      result.server = lat.server;
      phase('download');
      return measureDownload({
        node: node, durationMs: opts.downloadMs, streams: opts.downloadStreams, signal: opts.signal,
        onProgress: function (p) { progress('download', p); }
      });
    }).then(function (down) {
      result.downloadMbps = down.mbps;
      result.downloadBytes = down.bytes;
      result.loadedLatencyDownMs = down.loadedLatency ? down.loadedLatency.medianMs : NaN;
      phase('upload');
      return measureUpload({
        node: node, durationMs: opts.uploadMs, streams: opts.uploadStreams, signal: opts.signal,
        onProgress: function (p) { progress('upload', p); }
      });
    }).then(function (up) {
      result.uploadMbps = up.mbps;
      result.uploadBytes = up.bytes;
      result.loadedLatencyUpMs = up.loadedLatency ? up.loadedLatency.medianMs : NaN;
      result.bufferbloatMs = Stats.bufferbloat(result.latencyMs, result.loadedLatencyDownMs, result.loadedLatencyUpMs);
      result.finishedAt = new Date().toISOString();
      phase('done');
      return result;
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    CLOUDFLARE: CLOUDFLARE,
    measureLatency: measureLatency,
    measureDownload: measureDownload,
    measureUpload: measureUpload,
    runTest: runTest,
    // exported for tests
    _serverProcessingMs: serverProcessingMs,
    _serverInfo: serverInfo,
    _Tally: Tally
  };
});
