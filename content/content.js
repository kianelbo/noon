(() => {
  "use strict";

  const DEFAULT_MIN_LENGTH = 5;
  const DEFAULT_MAX_LENGTH = 30;
  let minPalindromeLength = DEFAULT_MIN_LENGTH;
  let maxPalindromeLength = DEFAULT_MAX_LENGTH;
  let highlights = [];
  let scrollbarTrack = null;
  let isActive = false;
  let scanId = 0; // incremented to cancel stale async scans
  let panel = null;
  let panelFab = null;
  let panelPinned = false;
  let panelOpen = false;
  let panelBusy = false;
  let sitemapAbortController = null;
  let sitemapStatusText = "";

  // ── Utility ──────────────────────────────────────────────────────────

  function createElement(tagName) {
    return document.createElementNS("http://www.w3.org/1999/xhtml", tagName);
  }

  const RE_LETTER = /^[\p{L}]$/u;
  const RE_DIGIT = /\p{N}/u;
  const RE_NON_LETTER_EXCEPT_SPACE = /[^\p{L}\s]/u;
  function isLetter(ch) {
    return RE_LETTER.test(ch);
  }

  // ── Text node extraction ─────────────────────────────────────────────

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "SVG", "CANVAS", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT",
  ]);

  function getTextNodes(root, options = {}) {
    const { skipPanel = true } = options;
    const isLive = root?.ownerDocument === document;
    const owner = root?.ownerDocument || document;
    const walker = owner.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(node.parentElement?.tagName)) return NodeFilter.FILTER_REJECT;
          if (skipPanel && isLive && node.parentElement?.closest("#noon-panel, #noon-fab")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  // ── Text run grouping ────────────────────────────────────────────────
  // Group text nodes by their nearest block-level ancestor.
  // This is O(n·depth) total but avoids the O(n·depth²) pairwise
  // findCommonAncestor approach.

  const INLINE_DISPLAY = new Set([
    "inline", "inline-block", "inline-flex", "inline-grid", "inline-table",
  ]);

  function getBlockAncestor(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display;
      if (!INLINE_DISPLAY.has(display)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function gatherTextRuns(textNodes, isLive = true) {
    if (textNodes.length === 0) return [];
    if (!isLive) return [textNodes];
    const runs = [];
    let currentBlock = getBlockAncestor(textNodes[0]);
    let currentRun = [textNodes[0]];

    for (let i = 1; i < textNodes.length; i++) {
      const block = getBlockAncestor(textNodes[i]);
      if (block === currentBlock) {
        currentRun.push(textNodes[i]);
      } else {
        runs.push(currentRun);
        currentBlock = block;
        currentRun = [textNodes[i]];
      }
    }
    runs.push(currentRun);
    return runs;
  }

  // ── Palindrome scanning ──────────────────────────────────────────────
  // Uses flat arrays instead of per-character objects for the index map.
  // runNodes[] and runOffsets[] store cumulative character offsets so we
  // can binary-search for the owning text node of any character index.

  function findPalindromesInText(fullText) {
    if (!fullText) return [];
    const lower = fullText.toLowerCase();
    const cleanIndices = [];
    const cleanChars = [];
    for (let i = 0; i < lower.length; i++) {
      if (isLetter(lower[i])) {
        cleanIndices.push(i);
        let ch = lower[i];
        if (ch === "\u0622") ch = "\u0627";
        cleanChars.push(ch);
      }
    }
    const cleanLen = cleanChars.length;
    if (cleanLen < minPalindromeLength) return [];
    const results = [];

    function tryExpand(lo, hi) {
      while (lo >= 0 && hi < cleanLen && cleanChars[lo] === cleanChars[hi]) {
        lo--;
        hi++;
      }
      lo++;
      hi--;
      const len = hi - lo + 1;
      if (len < minPalindromeLength || len > maxPalindromeLength) return;
      const origStart = cleanIndices[lo];
      const origEnd = cleanIndices[hi];
      const originalSlice = fullText.slice(origStart, origEnd + 1);
      if (RE_DIGIT.test(originalSlice)) return;
      if (RE_NON_LETTER_EXCEPT_SPACE.test(originalSlice)) return;
      if (origStart > 0 && !/\s/.test(fullText[origStart - 1])) return;
      if (origEnd < fullText.length - 1 && !/\s/.test(fullText[origEnd + 1])) return;
      results.push(origStart, origEnd, len);
    }

    for (let i = 0; i < cleanLen; i++) {
      tryExpand(i, i);
      tryExpand(i, i + 1);
    }

    const count = results.length / 3;
    if (count === 0) return [];
    const indices = new Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    indices.sort((a, b) => results[b * 3 + 2] - results[a * 3 + 2]);
    const maximal = [];
    for (const idx of indices) {
      const os = results[idx * 3];
      const oe = results[idx * 3 + 1];
      let dominated = false;
      for (let j = 0; j < maximal.length; j++) {
        if (os >= maximal[j][0] && oe <= maximal[j][1]) {
          dominated = true;
          break;
        }
      }
      if (!dominated) maximal.push([os, oe]);
    }

    return maximal.map(([os, oe]) => ({
      start: os,
      end: oe,
      text: fullText.slice(os, oe + 1),
    }));
  }

  function findPalindromesInRun(run) {
    const runNodes = [];
    const runStarts = [];
    const parts = [];
    let total = 0;
    for (let n = 0; n < run.length; n++) {
      const val = run[n].nodeValue;
      runNodes.push(run[n]);
      runStarts.push(total);
      parts.push(val);
      total += val.length;
    }
    const fullText = parts.join("");
    if (total === 0) return [];
    const palindromes = findPalindromesInText(fullText);
    if (palindromes.length === 0) return [];

    function nodeAt(charIdx) {
      let lo = 0, hi = runNodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (runStarts[mid] <= charIdx) lo = mid; else hi = mid - 1;
      }
      return { node: runNodes[lo], offset: charIdx - runStarts[lo] };
    }

    return palindromes.map((pal) => {
      const startInfo = nodeAt(pal.start);
      const endInfo = nodeAt(pal.end);
      const range = document.createRange();
      range.setStart(startInfo.node, startInfo.offset);
      range.setEnd(endInfo.node, endInfo.offset + 1);
      return { range, text: pal.text };
    });
  }

  // ── Highlighting ─────────────────────────────────────────────────────

  function highlightRange(range, text) {
    const mark = createElement("mark");
    mark.className = "palindrome-highlight";
    mark.title = `Palindrome: "${text}"`;
    try {
      range.surroundContents(mark);
      highlights.push(mark);
    } catch {
      try {
        const fragment = range.extractContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
        highlights.push(mark);
      } catch {
        return null;
      }
    }
    return mark;
  }

  function clampRange(minLength, maxLength) {
    let minVal = Number.isFinite(minLength) ? minLength : DEFAULT_MIN_LENGTH;
    let maxVal = Number.isFinite(maxLength) ? maxLength : DEFAULT_MAX_LENGTH;
    minVal = Math.min(Math.max(minVal, 3), 30);
    maxVal = Math.min(Math.max(maxVal, 3), 30);
    if (minVal > maxVal) {
      const temp = minVal;
      minVal = maxVal;
      maxVal = temp;
    }
    return { minVal, maxVal };
  }

  function updatePanelRangeDisplay() {
    if (!panel) return;
    const minInput = panel.querySelector("#noon-min");
    const maxInput = panel.querySelector("#noon-max");
    const minValue = panel.querySelector("#noon-min-value");
    const maxValue = panel.querySelector("#noon-max-value");
    const rangeTrack = panel.querySelector("#noon-range-track");
    if (minInput) minInput.value = String(minPalindromeLength);
    if (maxInput) maxInput.value = String(maxPalindromeLength);
    if (minValue) minValue.textContent = String(minPalindromeLength);
    if (maxValue) maxValue.textContent = String(maxPalindromeLength);
    if (rangeTrack && minInput && maxInput) {
      const min = parseInt(minInput.min, 10);
      const max = parseInt(minInput.max, 10);
      const minPct = ((minPalindromeLength - min) / (max - min)) * 100;
      const maxPct = ((maxPalindromeLength - min) / (max - min)) * 100;
      rangeTrack.style.background = `linear-gradient(90deg, #3a3a50 ${minPct}%, #ff8c00 ${minPct}%, #ff8c00 ${maxPct}%, #3a3a50 ${maxPct}%)`;
    }
  }

  function setRange(minLength, maxLength) {
    const { minVal, maxVal } = clampRange(minLength, maxLength);
    minPalindromeLength = minVal;
    maxPalindromeLength = maxVal;
    updatePanelRangeDisplay();
    return { minVal, maxVal };
  }

  function updatePanelResult(count) {
    if (!panel) return;
    const resultBox = panel.querySelector("#noon-result");
    const resultCount = panel.querySelector("#noon-result-count");
    if (!resultBox || !resultCount) return;
    if (count > 0) {
      resultCount.textContent = String(count);
      resultBox.classList.remove("hidden");
    } else {
      resultBox.classList.add("hidden");
    }
  }

  function setPanelPinned(pinned, persist = false) {
    panelPinned = pinned;
    if (panel) {
      const pinBtn = panel.querySelector("#noon-pin");
      if (pinBtn) pinBtn.classList.toggle("active", pinned);
    }
    if (persist) chrome.storage.sync.set({ panelPinned: pinned });
    if (pinned) {
      openPanel();
    } else if (!panelOpen && panelFab) {
      panelFab.classList.remove("hidden");
    }
  }

  function openPanel() {
    ensurePanel();
    panel.classList.remove("hidden");
    panelOpen = true;
    if (panelFab) panelFab.classList.add("hidden");
  }

  function closePanel() {
    if (!panel) return;
    panel.classList.add("hidden");
    panelOpen = false;
    if (!panelPinned && panelFab) panelFab.classList.remove("hidden");
  }

  function notifySitemapStatus(busy, text) {
    try {
      chrome.runtime.sendMessage({ action: "sitemapStatus", busy, text });
    } catch {}
  }

  function setPanelBusyState(busy, text = "") {
    panelBusy = busy;
    sitemapStatusText = text;
    notifySitemapStatus(busy, text);
    if (!panel) return;
    const scanBtn = panel.querySelector("#noon-scan");
    const clearBtn = panel.querySelector("#noon-clear");
    const sitemapBtn = panel.querySelector("#noon-sitemap-btn");
    const status = panel.querySelector("#noon-sitemap-status");
    if (scanBtn) scanBtn.disabled = busy;
    if (clearBtn) clearBtn.disabled = busy;
    if (sitemapBtn) {
      if (busy) {
        sitemapBtn.textContent = "Cancel";
        sitemapBtn.style.background = "#e53935"; // Red for cancel
        sitemapBtn.disabled = false;
      } else {
        sitemapBtn.textContent = "Scan sitemap";
        sitemapBtn.style.background = ""; // Reset to default
        sitemapBtn.disabled = false;
      }
    }
    if (status) status.textContent = text;
  }

  function ensurePanel() {
    if (panel) {
      if (!panel.isConnected) document.body.appendChild(panel);
      return;
    }
    panel = createElement("div");
    panel.id = "noon-panel";
    panel.className = "hidden";
    panel.innerHTML = `
      <div class="noon-header">
        <span class="noon-title">noon</span>
        <div class="noon-actions">
          <button id="noon-pin" class="noon-icon-btn" title="Pin panel">📌</button>
          <button id="noon-close" class="noon-icon-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="noon-body">
        <div id="noon-result" class="noon-result hidden">
          <span id="noon-result-count">0</span> palindrome(s) found
        </div>
        <div class="noon-group">
          <label class="noon-label">Palindrome length range</label>
          <div class="noon-range-slider" id="noon-range-slider">
            <div class="noon-range-track" id="noon-range-track"></div>
            <input type="range" id="noon-min" min="3" max="30" value="5" step="1">
            <input type="range" id="noon-max" min="3" max="30" value="30" step="1">
          </div>
          <div class="noon-range-values">
            <span id="noon-min-value">5</span>
            <span id="noon-max-value">30</span>
          </div>
        </div>
        <div class="noon-actions-row">
          <button id="noon-scan" class="noon-btn primary">Scan</button>
          <button id="noon-clear" class="noon-btn">Clear</button>
        </div>
        <div class="noon-group">
          <label class="noon-label">sitemap.xml</label>
          <input type="url" id="noon-sitemap" class="noon-input" placeholder="https://example.com/sitemap.xml">
          <button id="noon-sitemap-btn" class="noon-btn" style="margin-top: 8px;">Scan sitemap</button>
          <div id="noon-sitemap-status" class="noon-status"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    panelFab = createElement("button");
    panelFab.id = "noon-fab";
    panelFab.className = "hidden";
    panelFab.textContent = "noon";
    document.body.appendChild(panelFab);

    const minInput = panel.querySelector("#noon-min");
    const maxInput = panel.querySelector("#noon-max");
    const pinBtn = panel.querySelector("#noon-pin");
    const closeBtn = panel.querySelector("#noon-close");
    const scanBtn = panel.querySelector("#noon-scan");
    const clearBtn = panel.querySelector("#noon-clear");
    const sitemapBtn = panel.querySelector("#noon-sitemap-btn");
    const sitemapInput = panel.querySelector("#noon-sitemap");

    if (minInput && maxInput) {
      updatePanelRangeDisplay();
      minInput.addEventListener("input", () => {
        const { minVal, maxVal } = clampRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        if (minVal > maxVal) {
          minInput.value = String(maxVal);
        }
        setRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
      });
      maxInput.addEventListener("input", () => {
        const { minVal, maxVal } = clampRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        if (maxVal < minVal) {
          maxInput.value = String(minVal);
        }
        setRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
      });
      minInput.addEventListener("change", () => {
        const { minVal, maxVal } = setRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        chrome.storage.sync.set({ minPalindromeLength: minVal, maxPalindromeLength: maxVal });
        scan((count) => updatePanelResult(count));
      });
      maxInput.addEventListener("change", () => {
        const { minVal, maxVal } = setRange(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        chrome.storage.sync.set({ minPalindromeLength: minVal, maxPalindromeLength: maxVal });
        scan((count) => updatePanelResult(count));
      });
    }

    if (scanBtn) {
      scanBtn.addEventListener("click", () => {
        scan((count) => updatePanelResult(count));
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        cleanup();
        updatePanelResult(0);
      });
    }

    if (pinBtn) {
      pinBtn.addEventListener("click", () => {
        setPanelPinned(!panelPinned, true);
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        if (panelPinned) setPanelPinned(false, true);
        closePanel();
      });
    }

    if (panelFab) {
      panelFab.addEventListener("click", () => {
        openPanel();
      });
    }

    if (sitemapBtn && sitemapInput) {
      sitemapBtn.addEventListener("click", () => {
        if (panelBusy) {
          if (sitemapAbortController) {
            sitemapAbortController.abort();
          }
          return;
        }
        const url = sitemapInput.value.trim();
        if (!url) return;
        runSitemapScan(url);
      });
    }
  }

  // ── Scrollbar markers ───────────────────────────────────────────────

  function createScrollbarTrack() {
    removeScrollbarTrack();
    scrollbarTrack = createElement("div");
    scrollbarTrack.id = "palindrome-scrollbar-track";
    document.body.appendChild(scrollbarTrack);
  }

  function removeScrollbarTrack() {
    if (scrollbarTrack) {
      scrollbarTrack.remove();
      scrollbarTrack = null;
    }
  }

  function addScrollbarMarker(element, text) {
    if (!scrollbarTrack) return;
    const rect = element.getBoundingClientRect();
    const absoluteTop = rect.top + (window.scrollY || document.documentElement.scrollTop);
    const docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const pct = (absoluteTop / docHeight) * 100;

    const marker = createElement("div");
    marker.className = "palindrome-marker";
    marker.style.top = `${pct}%`;

    const tooltip = createElement("span");
    tooltip.className = "marker-tooltip";
    tooltip.textContent = text;
    marker.appendChild(tooltip);

    marker.addEventListener("click", () => {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    scrollbarTrack.appendChild(marker);
  }

  // ── Main scan (async chunked) ──────────────────────────────────────

  function scan(callback) {
    cleanup();
    isActive = true;
    const thisScan = ++scanId;

    const textNodes = getTextNodes(document.body, { skipPanel: true });
    const runs = gatherTextRuns(textNodes, true);

    let totalFound = 0;
    const palindromeElements = [];
    let runIdx = 0;

    createScrollbarTrack();

    function processChunk(deadline) {
      // If a newer scan was started, abandon this one
      if (thisScan !== scanId) return;

      while (runIdx < runs.length) {
        const palindromes = findPalindromesInRun(runs[runIdx]);
        runIdx++;

        for (const { range, text } of palindromes) {
          const mark = highlightRange(range, text);
          if (mark && mark.isConnected) {
            palindromeElements.push({ el: mark, text });
            totalFound++;
          }
        }

        // Yield to the browser if we've used most of the idle time
        if (deadline.timeRemaining() < 2 && runIdx < runs.length) {
          requestIdleCallback(processChunk, { timeout: 100 });
          return;
        }
      }

      // All runs processed — add scrollbar markers in one batch
      for (const { el, text } of palindromeElements) {
        addScrollbarMarker(el, text);
      }

      updatePanelResult(totalFound);
      if (callback) callback(totalFound);
    }

    // Kick off the first chunk
    if (runs.length === 0) {
      updatePanelResult(0);
      if (callback) callback(0);
    } else {
      requestIdleCallback(processChunk, { timeout: 200 });
    }
  }

  function cleanup() {
    isActive = false;
    scanId++; // cancel any in-flight async scan
    for (const mark of highlights) {
      if (mark.parentNode) {
        const parent = mark.parentNode;
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize(); // merge adjacent text nodes
      }
    }
    highlights = [];
    removeScrollbarTrack();
    updatePanelResult(0);
  }

  function countWords(text) {
    if (!text) return 0;
    const parts = text.trim().split(/\s+/).filter(Boolean);
    return parts.length;
  }

  function deriveTitleFromUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return "sitemap";
    }
  }

  async function fetchText(url) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action: "fetchText", url }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "Extension context invalidated"));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error(response?.error || "fetch failed"));
            return;
          }
          resolve(response.text);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function collectSitemapUrls(url, visited, signal, errors) {
    if (signal?.aborted) throw new Error("aborted");
    if (visited.has(url)) return [];
    visited.add(url);
    let xmlText;
    try {
      xmlText = await fetchText(url);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (errors) errors.push({ url, error: err.message });
      return [];
    }
    if (signal?.aborted) throw new Error("aborted");
    
    let xml;
    try {
      xml = new DOMParser().parseFromString(xmlText, "application/xml");
    } catch (err) {
      if (errors) errors.push({ url, error: "XML parsing failed" });
      return [];
    }

    const urlNodes = Array.from(xml.querySelectorAll("url > loc"));
    if (urlNodes.length > 0) {
      return urlNodes.map((node) => node.textContent.trim()).filter(Boolean);
    }
    const sitemapNodes = Array.from(xml.querySelectorAll("sitemap > loc"));
    const all = [];
    for (const node of sitemapNodes) {
      if (signal?.aborted) throw new Error("aborted");
      const nextUrl = node.textContent.trim();
      if (!nextUrl) continue;
      const nested = await collectSitemapUrls(nextUrl, visited, signal, errors);
      for (const item of nested) all.push(item);
    }
    return all;
  }

  async function mapWithConcurrency(items, limit, handler, onProgress, signal) {
    let index = 0;
    let active = 0;
    let done = 0;
    return new Promise((resolve, reject) => {
      const results = new Array(items.length);
      const next = () => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (done >= items.length) return resolve(results);
        while (active < limit && index < items.length) {
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const current = index++;
          active++;
          Promise.resolve(handler(items[current], current))
            .then((result) => {
              results[current] = result;
            })
            .catch(() => {
              results[current] = null;
            })
            .finally(() => {
              active--;
              done++;
              if (onProgress && !signal?.aborted) onProgress(done, items.length);
              next();
            });
        }
      };
      next();
    });
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function runSitemapScan(sitemapUrl) {
    if (sitemapAbortController) {
      sitemapAbortController.abort();
    }
    sitemapAbortController = new AbortController();
    const signal = sitemapAbortController.signal;
    const errors = [];

    setPanelBusyState(true, "Fetching sitemap...");
    try {
      const urls = await collectSitemapUrls(sitemapUrl, new Set(), signal, errors);
      if (signal.aborted) throw new Error("aborted");

      if (urls.length === 0) {
        setPanelBusyState(false, "No links found in sitemap");
        return;
      }
      const grouped = new Map(); // wordCount -> Map<word, Set<url>>
      let total = 0;
      await mapWithConcurrency(
        urls,
        4,
        async (pageUrl) => {
          if (signal.aborted) throw new Error("aborted");
          try {
            const html = await fetchText(pageUrl);
            if (signal.aborted) throw new Error("aborted");
            
            const doc = new DOMParser().parseFromString(html, "text/html");
            const body = doc.body;
            if (!body) return null;
            const textNodes = getTextNodes(body, { skipPanel: false });
            const fullText = textNodes.map((n) => n.nodeValue).join("");
            const pals = findPalindromesInText(fullText);
            for (const pal of pals) {
              const wordCount = countWords(pal.text);
              const word = pal.text;

              if (!grouped.has(wordCount)) {
                grouped.set(wordCount, new Map());
              }
              const wordMap = grouped.get(wordCount);

              if (!wordMap.has(word)) {
                wordMap.set(word, new Set());
              }
              wordMap.get(word).add(pageUrl);

              total++;
            }
            return true;
          } catch (err) {
            if (signal.aborted || err.message === "aborted") throw err;
            errors.push({ url: pageUrl, error: err.message });
            return null;
          }
        },
        (done, totalCount) => {
          if (!signal.aborted) {
            setPanelBusyState(true, `Scanning ${done} of ${totalCount}`);
          }
        },
        signal
      );
      
      if (signal.aborted) throw new Error("aborted");

      const list = Array.from(grouped.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([wordCount, wordMap]) => {
          const words = Array.from(wordMap.entries()).map(([word, urlSet]) => ({
            url: Array.from(urlSet),
            word: word
          }));
          return {
            word_count: wordCount,
            words,
          };
        });
      const output = {
        title: deriveTitleFromUrl(sitemapUrl),
        finded_str: total,
        list,
        errors: errors.length > 0 ? errors : undefined,
      };
      downloadJson(output, `palindromes-${Date.now()}.json`);
      const errorMsg = errors.length > 0 ? ` (${errors.length} errors)` : "";
      setPanelBusyState(false, `Done: ${total} palindromes${errorMsg}`);
    } catch (err) {
      if (err.message === "aborted" || signal.aborted) {
        setPanelBusyState(false, "Scan cancelled");
      } else if (err.message && (err.message.includes("Extension context invalidated") || err.message.includes("Extension context destroyed"))) {
        setPanelBusyState(false, "Please reload page (ext updated)");
      } else {
        console.error(err);
        setPanelBusyState(false, "Sitemap scan failed");
      }
    } finally {
      if (sitemapAbortController && sitemapAbortController.signal === signal) {
        sitemapAbortController = null;
      }
    }
  }

  // ── Message handling ─────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scan") {
      const minLength = typeof msg.minLength === "number" ? msg.minLength : minPalindromeLength;
      const maxLength = typeof msg.maxLength === "number" ? msg.maxLength : maxPalindromeLength;
      setRange(minLength, maxLength);
      scan((count) => sendResponse({ count }));
      return true; // keep channel open for async response
    } else if (msg.action === "clear") {
      cleanup();
      sendResponse({ count: 0 });
    } else if (msg.action === "panelPin") {
      setPanelPinned(!!msg.pinned, false);
      sendResponse({ pinned: panelPinned });
    } else if (msg.action === "scanSitemap") {
      if (typeof msg.url === "string" && msg.url.trim()) {
        runSitemapScan(msg.url.trim());
      }
      sendResponse({ ok: true });
    } else if (msg.action === "cancelSitemap") {
      if (sitemapAbortController) {
        sitemapAbortController.abort();
      }
      sendResponse({ ok: true });
    } else if (msg.action === "status") {
      sendResponse({
        active: isActive,
        count: highlights.length,
        minLength: minPalindromeLength,
        maxLength: maxPalindromeLength,
        pinned: panelPinned,
        sitemapBusy: panelBusy,
        sitemapStatus: sitemapStatusText,
      });
    }
    return true;
  });

  // ── Listen for setting changes from other tabs / popup ─────────────
  chrome.storage.onChanged.addListener((changes) => {
    const minChange = changes.minPalindromeLength?.newValue;
    const maxChange = changes.maxPalindromeLength?.newValue;
    const pinChange = changes.panelPinned?.newValue;
    if (minChange !== undefined || maxChange !== undefined) {
      setRange(
        minChange !== undefined ? minChange : minPalindromeLength,
        maxChange !== undefined ? maxChange : maxPalindromeLength
      );
      scan();
    }
    if (pinChange !== undefined) {
      setPanelPinned(!!pinChange, false);
    }
  });

  // ── Auto-scan on page load ───────────────────────────────────────────
  chrome.storage.sync.get(
    { minPalindromeLength: DEFAULT_MIN_LENGTH, maxPalindromeLength: DEFAULT_MAX_LENGTH, panelPinned: false },
    (settings) => {
      setRange(settings.minPalindromeLength, settings.maxPalindromeLength);
      setPanelPinned(!!settings.panelPinned, false);
      ensurePanel();
      if (!panelPinned && panelFab) panelFab.classList.remove("hidden");
      if (panelPinned) openPanel();
      scan();

      // Watch for body replacement (Turbo Drive, SPAs)
      const observer = new MutationObserver(() => {
        if (panel && !panel.isConnected) {
          document.body.appendChild(panel);
        }
        if (panelFab && !panelFab.isConnected) {
          document.body.appendChild(panelFab);
        }
      });
      if (document.body) {
        observer.observe(document.body, { childList: true });
      }

      const rootObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.tagName === "BODY") {
              observer.disconnect();
              observer.observe(node, { childList: true });
              if (panel && !panel.isConnected) node.appendChild(panel);
              if (panelFab && !panelFab.isConnected) node.appendChild(panelFab);
            }
          }
        }
      });
      if (document.documentElement) {
        rootObserver.observe(document.documentElement, { childList: true });
      }
    }
  );
})();
