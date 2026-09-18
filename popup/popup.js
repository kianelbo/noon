document.addEventListener("DOMContentLoaded", () => {
  const btnScan = document.getElementById("btn-scan");
  const btnClear = document.getElementById("btn-clear");
  const resultBox = document.getElementById("result");
  const resultCount = document.getElementById("result-count");
  const minInput = document.getElementById("min-length");
  const maxInput = document.getElementById("max-length");
  const minValue = document.getElementById("min-length-value");
  const maxValue = document.getElementById("max-length-value");
  const rangeTrack = document.getElementById("range-track");
  const pinToggle = document.getElementById("pin-panel");
  const sitemapInput = document.getElementById("sitemap-url");
  const sitemapButton = document.getElementById("btn-sitemap");
  const sitemapStatus = document.getElementById("sitemap-status");
  let sitemapBusy = false;

  function showResult(count) {
    resultCount.textContent = count;
    resultBox.classList.remove("hidden");
    btnClear.disabled = count === 0;
  }

  function sendToTab(msg, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
        if (chrome.runtime.lastError) return;
        if (callback) callback(response);
      });
    });
  }

  function updateRangeTrack(minLength, maxLength) {
    if (!rangeTrack) return;
    const min = parseInt(minInput.min, 10);
    const max = parseInt(minInput.max, 10);
    const minPct = ((minLength - min) / (max - min)) * 100;
    const maxPct = ((maxLength - min) / (max - min)) * 100;
    rangeTrack.style.background = `linear-gradient(90deg, #3a3a50 ${minPct}%, #ff8c00 ${minPct}%, #ff8c00 ${maxPct}%, #3a3a50 ${maxPct}%)`;
  }

  function normalizeRange(fromMin = true) {
    let minLength = parseInt(minInput.value, 10);
    let maxLength = parseInt(maxInput.value, 10);
    if (!Number.isFinite(minLength)) minLength = 3;
    if (!Number.isFinite(maxLength)) maxLength = 30;
    minLength = Math.min(Math.max(minLength, 3), 30);
    maxLength = Math.min(Math.max(maxLength, 3), 30);
    if (fromMin && minLength > maxLength) {
      minLength = maxLength;
    }
    if (!fromMin && maxLength < minLength) {
      maxLength = minLength;
    }
    minInput.value = String(minLength);
    maxInput.value = String(maxLength);
    if (minValue) minValue.textContent = String(minLength);
    if (maxValue) maxValue.textContent = String(maxLength);
    updateRangeTrack(minLength, maxLength);
    return { minLength, maxLength };
  }

  function triggerScan() {
    const { minLength, maxLength } = normalizeRange();
    sendToTab({ action: "scan", minLength, maxLength }, (response) => {
      if (response) showResult(response.count);
    });
  }

  // Load saved setting
  chrome.storage.sync.get({ minPalindromeLength: 5, maxPalindromeLength: 30, panelPinned: false }, (settings) => {
    minInput.value = settings.minPalindromeLength;
    maxInput.value = settings.maxPalindromeLength;
    pinToggle.checked = settings.panelPinned;
    normalizeRange();
  });

  minInput.addEventListener("input", () => {
    normalizeRange(true);
  });

  maxInput.addEventListener("input", () => {
    normalizeRange(false);
  });

  minInput.addEventListener("change", () => {
    const { minLength, maxLength } = normalizeRange(true);
    chrome.storage.sync.set({ minPalindromeLength: minLength, maxPalindromeLength: maxLength });
    triggerScan();
  });

  maxInput.addEventListener("change", () => {
    const { minLength, maxLength } = normalizeRange(false);
    chrome.storage.sync.set({ minPalindromeLength: minLength, maxPalindromeLength: maxLength });
    triggerScan();
  });

  pinToggle.addEventListener("change", () => {
    const pinned = pinToggle.checked;
    chrome.storage.sync.set({ panelPinned: pinned });
    sendToTab({ action: "panelPin", pinned });
  });

  function updateSitemapUI(isBusy, text) {
    sitemapBusy = isBusy;
    if (sitemapButton) {
      if (isBusy) {
        sitemapButton.innerHTML = `<span class="icon">⏹</span> Cancel`;
        sitemapButton.classList.add("busy");
      } else {
        sitemapButton.innerHTML = `Scan sitemap`;
        sitemapButton.classList.remove("busy");
      }
    }
    if (sitemapStatus) {
      if (text) {
        sitemapStatus.textContent = text;
        sitemapStatus.classList.remove("hidden");
      } else {
        sitemapStatus.classList.add("hidden");
      }
    }
  }

  // Check current status on popup open (auto-scan already ran)
  sendToTab({ action: "status" }, (response) => {
    if (response?.minLength !== undefined) minInput.value = response.minLength;
    if (response?.maxLength !== undefined) maxInput.value = response.maxLength;
    if (response?.pinned !== undefined) pinToggle.checked = response.pinned;
    normalizeRange(true);
    if (response && response.active) showResult(response.count);
    
    if (response?.sitemapBusy) {
      updateSitemapUI(true, response.sitemapStatus || "Scanning...");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "sitemapStatus") {
      updateSitemapUI(msg.busy, msg.text);
    }
  });

  btnScan.addEventListener("click", triggerScan);
  btnClear.addEventListener("click", () => {
    sendToTab({ action: "clear" }, () => {
      resultBox.classList.add("hidden");
      btnClear.disabled = true;
    });
  });

  sitemapButton.addEventListener("click", () => {
    if (sitemapBusy) {
      sendToTab({ action: "cancelSitemap" });
      return;
    }
    const url = sitemapInput.value.trim();
    if (!url) return;
    sendToTab({ action: "scanSitemap", url });
  });
});
