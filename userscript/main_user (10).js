// ==UserScript==
// @name         Binance Aggressive Volume Bubbles
// @namespace    http://tampermonkey.net/
// @version      8.2.0
// @description  Shows green/red bubbles at aggressive buy/sell trade prices on TradingView
// @author       You
// @match        https://*.tradingview.com/chart/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  var currentSymbol    = "";
  var currentTimeframe = 1;
  var bubbleData       = [];
  var anomalyThreshold = 2.0;
  var serverOk         = false;
  var lastDataStr      = "";
  var lastData         = [];
  var iconsVisible     = true;
  var transparen      = 0; // 0=opaque 100=invisible
  var settingsVisible  = false;
  var connTimer        = null;
  var fetchTimer       = null;

  var minSize = 6;
  var maxSize = 24;
  var stdDevSize = 3.0;
  var notionalZ = 3; // Z multiplier for dynamic notional threshold (mean + Z*std). 1=loose, 10=strict
  // Icon circles: pixel-sized so they NEVER change with scroll/zoom (unlike price-based
  // multipoint circles whose pixel size depends on the price scale).
  var ICON_HEX = 0xf111; // Font Awesome solid circle

  var drawnShapes = {}; // key -> shapeId, for incremental diffing
  var SERVER_PORT = 3002;
  var FETCH_INT  = 5000;  // HTTP poll fallback — SSE handles real-time
  var MAX_BUBBLES = 400;
  var BUILD_THROTTLE_MS = 200; // throttle expensive sort/percentile rebuild, not data ingestion
  var lastBuildTime = 0;
  var pendingBuild = false;

  function log() { console.log.apply(console, ["[AVB]"].concat(Array.prototype.slice.call(arguments))); }

  function getChart() {
    try {
      var chart = unsafeWindow.__AVC_CHART;
      if (chart) return chart;
      var api = unsafeWindow.TradingViewApi;
      if (api) {
        chart = api.chart ? api.chart() : (api.activeChart ? api.activeChart() : null);
        if (chart) { unsafeWindow.__AVC_CHART = chart; unsafeWindow.__AVC_WIDGET_READY = true; }
      }
      return chart || null;
    } catch(e) { return null; }
  }

  var GREEN = "#22c55e";
  var RED   = "#ef4444";

  function clearDrawn() {
    var chart = getChart();
    var ids = Object.keys(drawnShapes).map(function(k) { return drawnShapes[k]; });
    drawnShapes = {};
    drawnMeta = {};
    if (!chart) return;
    for (var i = 0; i < ids.length; i++) {
      try { chart.removeEntity(ids[i]); } catch(e) {}
    }
  }

  function bubbleKey(pt) {
    return pt.timeS + "-" + pt.price.toString() + "-" + pt.isBuy;
  }

  // Tracks the size/color that was last rendered for each identity key,
  // so we can detect when an in-progress candle's anomaly has grown and
  // needs its shape replaced (not duplicated).
  var drawnMeta = {}; // key -> { size, color, active }

  function renderBubbles() {
    if (!iconsVisible) return;
    var chart = getChart();
    if (!chart || typeof chart.createShape !== "function") return;

    // Build the set of keys we want on the chart now
    var wanted = {};
    for (var i = 0; i < bubbleData.length; i++) {
      wanted[bubbleKey(bubbleData[i])] = bubbleData[i];
    }

    // Remove shapes that are no longer wanted at all (expired/out of window)
    var existingKeys = Object.keys(drawnShapes);
    for (var i = 0; i < existingKeys.length; i++) {
      var k = existingKeys[i];
      if (!wanted[k]) {
        try { chart.removeEntity(drawnShapes[k]); } catch(e) {}
        delete drawnShapes[k];
        delete drawnMeta[k];
      }
    }

    // Add new shapes, and replace shapes whose size/color changed
    // (e.g. an in-progress candle's anomaly grew bigger).
    var added = 0, updated = 0;
    var wantedKeys = Object.keys(wanted);
    for (var i = 0; i < wantedKeys.length; i++) {
      var k = wantedKeys[i];
      var pt = wanted[k];
      var meta = drawnMeta[k];

      if (drawnShapes[k]) {
        if (meta && meta.size === pt.size && meta.color === pt.color && meta.active === pt.isActive) {
          continue; // unchanged, leave shape as-is
        }
        // Changed — remove old shape, fall through to create the new one
        try { chart.removeEntity(drawnShapes[k]); } catch(e) {}
        delete drawnShapes[k];
        updated++;
      } else {
        added++;
      }

      (function(key, pt) {
        try {
          var p = chart.createShape(
            { time: pt.timeS, price: pt.price },
            {
              shape: "icon",
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              zOrder: "top",
              overrides: {
                color: pt.color,
                size: pt.size,
                transparency: transparen,
              },
              icon: ICON_HEX,
            }
          );
          if (p && typeof p.then === "function") {
            p.then(function(id) {
              if (id != null) {
                drawnShapes[key] = id;
                drawnMeta[key] = { size: pt.size, color: pt.color, active: pt.isActive };
              }
            }).catch(function() {});
          }
        } catch(e) {}
      })(k, pt);
    }

    if (added > 0 || updated > 0 || existingKeys.length !== wantedKeys.length) {
      log("Bubbles diff: +" + added + " ~" + updated + " total=" + wantedKeys.length);
    }
  }

  // Re-render all shapes with a new global override (e.g. opacity/transparency change)
  // without changing which bubbles are shown — full rebuild is fine here since
  // it's only triggered by a manual UI slider, not real-time data.
  function rerenderAll() {
    clearDrawn();
    renderBubbles();
  }

  function doBuildBubbleData(data) {
    var candidates = [];
    for (var i = 0; i < data.length; i++) {
      var point = data[i];
      if (point.buyVol === 0 && point.sellVol === 0) continue;
      if (!point.isAnomaly) continue;

      var isBuy = point.buyVol > point.sellVol;
      var color = isBuy ? GREEN : RED;
      var intensity = Math.min(1, Math.abs(point.ratio || 0) / stdDevSize);
      var alpha = (point.isActive !== false) ? 1.0 : 0.70;
      var size = Math.round((minSize + intensity * (maxSize - minSize)) * alpha);
      if (size < minSize) size = minSize;
      if (size > maxSize) size = maxSize;

      candidates.push({
        timeS: point.time,
        price: point.price,
        isBuy: isBuy,
        color: color,
        size: size,
        ratio: Math.abs(point.ratio || 0),
        isActive: (point.isActive !== false)
      });
    }

    // Keep only the most significant anomalies (highest ratio)
    candidates.sort(function(a, b) { return b.ratio - a.ratio; });
    if (candidates.length > MAX_BUBBLES) candidates.length = MAX_BUBBLES;

    // Sort by size descending — renders larger circles first, smaller on top
    // so no circle hides behind another at the exact same price level.
    candidates.sort(function(a, b) { return b.size - a.size; });

    bubbleData = candidates;
    log("Bubbles:", bubbleData.length);

    renderBubbles();
  }

  // Throttled entry point: real-time data ingestion (SSE drain, every 50ms) can call
  // this freely. The expensive sort/percentile/diff work (doBuildBubbleData) is
  // rate-limited to BUILD_THROTTLE_MS so it doesn't run 20x/sec — rendering itself
  // is incremental (see renderBubbles), so this throttle only affects how often
  // the candidate SET is recomputed, not how fast new bubbles appear once computed.
  function buildBubbleData(data) {
    var now = Date.now();
    if (now - lastBuildTime < BUILD_THROTTLE_MS) {
      pendingBuild = data;
      return;
    }
    lastBuildTime = now;
    pendingBuild = false;
    doBuildBubbleData(data);
  }

  // Flush any pending build (called periodically so trailing updates aren't dropped)
  function flushPendingBuild() {
    if (pendingBuild) {
      var data = pendingBuild;
      pendingBuild = false;
      lastBuildTime = Date.now();
      doBuildBubbleData(data);
    }
  }

  function getChartSymbol() {
    try {
      var chart = unsafeWindow.__AVC_CHART;
      if (!chart || !chart.symbol) return null;
      var s = chart.symbol().toUpperCase()
        .replace(/^BINANCE[.:]/, "").replace(/:.*$/, "")
        .replace(/\.P$/, "").replace(/\.perp$/i, "");
      if (/^[A-Z]{2,12}USDT$/.test(s)) return s;
      if (/^[A-Z]{2,12}$/.test(s)) return s + "USDT";
      return s;
    } catch(e) { return null; }
  }

  function detectSymbol() {
    var s = getChartSymbol();
    if (s) return s;
    try {
      var el = document.querySelector('[class*="header"] a, [class*="widgetbar"] a');
      if (el) {
        var t = el.textContent.trim().toUpperCase().replace(/^BINANCE:/, "");
        if (/^[A-Z]{2,10}USDT/.test(t)) return t.match(/^[A-Z]{2,10}USDT/)[0];
      }
    } catch(e) {}
    return currentSymbol || "BTCUSDT";
  }

  function detectTimeframe() {
    try {
      var els = document.querySelectorAll('[class*="button"]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute("aria-pressed") === "true" || els[i].classList.contains("selected")) {
          var n = parseInt(els[i].textContent.trim(), 10);
          if (!isNaN(n) && n > 0) return n;
        }
      }
    } catch(e) {}
    return currentTimeframe || 1;
  }

  function fetchData() {
    var sym = currentSymbol || "BTCUSDT";
    var tf  = currentTimeframe || 1;
    GM_xmlhttpRequest({
      method: "GET",
      url: "http://127.0.0.1:" + SERVER_PORT +
           "/api/data?pair=" + encodeURIComponent(sym) +
           "&timeframe=" + tf +
           "&threshold=" + anomalyThreshold +
           "&notionalZ=" + notionalZ +
           "&anomaliesOnly=true",
      onload: function(resp) {
        if (resp.status !== 200) return;
        try {
          var json = JSON.parse(resp.responseText);
          var str  = JSON.stringify(json.data);
          if (str !== lastDataStr) {
            lastDataStr = str;
            // Dedup on exact price (prevents true duplicates). Grid aggregation
            // by grid bucket happens in doBuildBubbleData's pre-aggregation layer,
            // where sibling ticks within the same bucket get their volumes summed.
            var merged = lastData.concat(json.data);
            var seen = {}, deduped = [];
            for (var i = 0; i < merged.length; i++) {
              var p = merged[i];
              var k = p.time + "-" + p.price + "-" + (p.buyVol > p.sellVol);
              if (seen[k]) continue;
              seen[k] = true;
              deduped.push(p);
            }
            // Trim by ratio to prevent unbounded growth
            if (deduped.length > MAX_BUBBLES * 3) {
              deduped.sort(function(a,b){return Math.abs(b.ratio||0) - Math.abs(a.ratio||0);});
              deduped.length = MAX_BUBBLES * 3;
            }
            lastData = deduped;
            if (!serverOk) { serverOk = true; log("Server connected"); }
            buildBubbleData(lastData);
          }
        } catch(e) {}
      },
      onerror: function() { if (serverOk) log("Server disconnected"); serverOk = false; },
      timeout: 2000, // Faster timeout for quicker failure detection
    });
  }

  function poll() {
    var sym = detectSymbol(), tf = detectTimeframe();
    currentSymbol = sym; currentTimeframe = tf;
    try { unsafeWindow.__AVB_SYMBOL = sym; } catch(e) {}
    fetchData();
    clearInterval(fetchTimer);
    fetchTimer = setInterval(function() {
      var s2 = detectSymbol(), t2 = detectTimeframe();
      if (s2 !== currentSymbol || t2 !== currentTimeframe) {
        currentSymbol = s2; currentTimeframe = t2;
        try { unsafeWindow.__AVB_SYMBOL = s2; } catch(e) {}
        log("Changed:", s2, t2 + "m");
        lastDataStr = ""; lastData = [];
        bubbleData = [];
        clearDrawn();
      }
      fetchData();
    }, FETCH_INT);
  }

  // ── Fast poll for fresh anomalies ────────────────────────────────────────
  // Uses /api/poll which returns anomalies detected on every trade (sub-ms latency).
  // GM_xmlhttpRequest bypasses CSP (unlike EventSource/SSE).
  // Results are merged with lastData and fed to the throttled build pipeline.

  function pollFresh() {
    var sym = currentSymbol || "BTCUSDT";
    GM_xmlhttpRequest({
      method: "GET",
      url: "http://127.0.0.1:" + SERVER_PORT +
           "/api/poll?pair=" + encodeURIComponent(sym) +
           "&notionalZ=" + notionalZ,
      onload: function(resp) {
        if (resp.status !== 200) return;
        try {
          var json = JSON.parse(resp.responseText);
          if (!json.data || !json.data.length) return;
          log("Fresh:", json.data.length, "anomalies");
          // Last-write-wins: new data first so cumulative server volume replaces stale.
          // Dedup on exact price — grid aggregation happens in doBuildBubbleData.
          var merged = json.data.concat(lastData);
          var seen = {}, deduped = [];
          for (var i = 0; i < merged.length; i++) {
            var p = merged[i];
            var k = p.time + "-" + p.price + "-" + (p.buyVol > p.sellVol);
            if (seen[k]) continue;
            seen[k] = true;
            deduped.push(p);
          }
          lastData = deduped;
          lastDataStr = "";
          buildBubbleData(lastData);
        } catch(e) {}
      },
      timeout: 1000,
    });
  }

  var fastPollTimer = null;
  function startFastPoll() {
    if (fastPollTimer) return;
    fastPollTimer = setInterval(function() {
      pollFresh();
      flushPendingBuild();
    }, 200);
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  function buildUI() {
    var dot = document.createElement("div");
    dot.id = "avc-status-dot";
    dot.style.cssText = "position:fixed;bottom:12px;right:12px;width:14px;height:14px;" +
      "border-radius:50%;background:#666;cursor:pointer;z-index:999999;" +
      "box-shadow:0 0 4px rgba(0,0,0,0.4);";
    dot.title = "Aggressive Volume Bubbles";
    dot.addEventListener("click", function() {
      settingsVisible = !settingsVisible;
      var panel = document.getElementById("avc-settings-panel");
      if (panel) panel.style.display = settingsVisible ? "block" : "none";
    });
    document.body.appendChild(dot);

    var panel = document.createElement("div");
    panel.id = "avc-settings-panel";
    panel.style.cssText = "position:fixed;bottom:32px;right:12px;width:260px;background:#1a1a2e;" +
      "border:1px solid #333;border-radius:8px;padding:14px;z-index:999999;color:#e0e0e0;" +
      "display:none;box-shadow:0 4px 16px rgba(0,0,0,0.5);font-family:Arial;font-size:13px;";

    function row(labelTxt, min, max, step, initVal, onChange) {
      var wrap = document.createElement("div");
      wrap.style.marginBottom = "8px";
      var top = document.createElement("div");
      var lbl = document.createElement("span"); lbl.textContent = labelTxt;
      var val = document.createElement("span");
      val.style.cssText = "float:right;color:#22c55e;font-weight:600;";
      val.textContent = initVal.toFixed(1);
      top.appendChild(lbl); top.appendChild(val); wrap.appendChild(top);
      var sl = document.createElement("input");
      sl.type = "range"; sl.min = min; sl.max = max; sl.step = step;
      sl.style.cssText = "width:100%;margin:4px 0;accent-color:#22c55e;cursor:pointer;";
      sl.addEventListener("input", function() { val.textContent = parseFloat(sl.value).toFixed(1); });
      sl.addEventListener("change", function() { onChange(parseFloat(sl.value)); });
      wrap.appendChild(sl);
      sl.value = initVal;
      return wrap;
    }

    var title = document.createElement("div");
    title.style.cssText = "margin-bottom:10px;font-weight:600;font-size:14px;";
    title.textContent = "Vol Bubbles v8.2.0";
    panel.appendChild(title);

    panel.appendChild(row("Std Dev", "1.0", "10.0", "0.5", stdDevSize, function(v) {
      stdDevSize = v; lastDataStr = ""; fetchData();
    }));
    panel.appendChild(row("Min Size", "2", "20", "1", minSize, function(v) {
      minSize = v; lastDataStr = ""; fetchData();
    }));
    panel.appendChild(row("Max Size", "6", "60", "1", maxSize, function(v) {
      maxSize = v; lastDataStr = ""; fetchData();
    }));
    panel.appendChild(row("Opacity", "0", "100", "1", 100 - transparen, function(v) {
      transparen = 100 - v; rerenderAll();
    }));
    panel.appendChild(row("Threshold", "1.0", "5.0", "0.1", anomalyThreshold, function(v) {
      anomalyThreshold = v; lastDataStr = ""; lastData = []; fetchData();
    }));
    panel.appendChild(row("Notional Z", "1", "10", "0.5", notionalZ, function(v) {
      notionalZ = v; lastDataStr = ""; lastData = []; fetchData();
    }));

    var toggleWrap = document.createElement("div");
    toggleWrap.style.cssText = "margin-top:8px;display:flex;align-items:center;gap:8px;";
    var toggleBtn = document.createElement("button");
    toggleBtn.id = "avc-toggle-btn";
    toggleBtn.textContent = iconsVisible ? "Hide Bubbles" : "Show Bubbles";
    toggleBtn.style.cssText = "flex:1;padding:4px 8px;border:1px solid #333;border-radius:4px;" +
      "background:#2a2a3e;color:#e0e0e0;cursor:pointer;font-size:12px;";
    toggleBtn.addEventListener("click", function() {
      iconsVisible = !iconsVisible;
      toggleBtn.textContent = iconsVisible ? "Hide Bubbles" : "Show Bubbles";
      if (iconsVisible) { if (lastData.length) doBuildBubbleData(lastData); }
      else { clearDrawn(); }
    });
    toggleWrap.appendChild(toggleBtn);
    panel.appendChild(toggleWrap);

    var status = document.createElement("div");
    status.id = "avc-conn-status";
    status.style.cssText = "margin-top:6px;font-size:11px;color:#888;";
    status.textContent = "Disconnected";
    panel.appendChild(status);
    document.body.appendChild(panel);
  }

  function updateStatus() {
    var el  = document.getElementById("avc-conn-status");
    var dot = document.getElementById("avc-status-dot");
    var wOk = !!unsafeWindow.__AVC_WIDGET_READY;
    if (el) el.textContent = "Bub:" + bubbleData.length +
      " ID:" + Object.keys(drawnShapes).length +
      " Svr:" + (serverOk ? "OK" : "DN") + " W:" + (wOk ? "OK" : "--") +
      (iconsVisible ? "" : " HID");
    if (dot) {
      if (serverOk && Object.keys(drawnShapes).length) dot.style.background = "#22c55e";
      else if (serverOk && wOk)        dot.style.background = "#22c55e";
      else if (serverOk)               dot.style.background = "#f59e0b";
      else                             dot.style.background = "#ef4444";
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  function init() {
    log("Starting v8.2.0");
    injectWidgetCapture();
    buildUI();
    startFastPoll();
    connTimer = setInterval(updateStatus, 3000);
    setTimeout(poll, 800);
    log("Initialized");
  }

  function injectWidgetCapture() {
    try {
      var code = [
        "(function(){",
        "  if(window.__AVC_INJECTED)return;",
        "  window.__AVC_INJECTED=true;",
        "  function cap(){",
        "    var api=window.TradingViewApi;",
        "    if(!api)return false;",
        "    try{",
        "      var c=api.chart?api.chart():(api.activeChart?api.activeChart():null);",
        "      if(!c)return false;",
        "      window.__AVC_WIDGET=api;",
        "      window.__AVC_CHART=c;",
        "      window.__AVC_WIDGET_READY=true;",
        "      return true;",
        "    }catch(e){return false;}",
        "  }",
        "  var t=setInterval(function(){if(cap())clearInterval(t);},200);",
        "  setTimeout(function(){clearInterval(t);},20000);",
        "})();"
      ].join("\n");
      var blob = new Blob([code], { type: "application/javascript" });
      var url  = URL.createObjectURL(blob);
      var s    = document.createElement("script");
      s.src    = url;
      s.onload = function() { URL.revokeObjectURL(url); };
      document.documentElement.appendChild(s);
    } catch(e) { log("Blob inject error:", e.message); }

    var attempts = 0;
    var poll = setInterval(function() {
      attempts++;
      if (attempts > 100) { clearInterval(poll); return; }
      try {
        if (unsafeWindow.__AVC_WIDGET_READY) { clearInterval(poll); return; }
        var api = unsafeWindow.TradingViewApi;
        if (!api) return;
        var chart = api.chart ? api.chart() : (api.activeChart ? api.activeChart() : null);
        if (!chart) return;
        unsafeWindow.__AVC_WIDGET       = api;
        unsafeWindow.__AVC_CHART        = chart;
        unsafeWindow.__AVC_WIDGET_READY = true;
        log("Chart captured");
        clearInterval(poll);
      } catch(e) {}
    }, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();