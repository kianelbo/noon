chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "fetchText" && typeof msg.url === "string") {
    fetch(msg.url)
      .then((response) => {
        if (!response.ok) throw new Error(`fetch failed ${response.status}`);
        return response.text();
      })
      .then((text) => {
        sendResponse({ ok: true, text });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  return false;
});
