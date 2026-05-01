const queryInput = document.getElementById('query');
const pagesInput = document.getElementById('pages');
const domainInput = document.getElementById('domain');
const maxItemsInput = document.getElementById('maxItems');
const startBtn = document.getElementById('start');
const openBtn = document.getElementById('open');
const statusEl = document.getElementById('status');

(async () => {
  const { lastQuery } = await chrome.storage.local.get('lastQuery');
  if (lastQuery) {
    queryInput.value = lastQuery.query || '';
    pagesInput.value = lastQuery.pages || 10;
    domainInput.value = lastQuery.domain || 'amazon.com';
    maxItemsInput.value = lastQuery.maxItems || 2000;
  }
})();

queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startBtn.click(); });

startBtn.addEventListener('click', async () => {
  const query = queryInput.value.trim();
  const pages = Math.max(1, Math.min(100, parseInt(pagesInput.value, 10) || 10));
  const domain = domainInput.value.trim() || 'amazon.com';
  const maxItems = Math.max(10, Math.min(10000, parseInt(maxItemsInput.value, 10) || 2000));
  if (!query) { statusEl.textContent = 'Enter a search term.'; return; }
  await chrome.storage.local.set({
    pendingScrape: { query, pages, domain, maxItems, ts: Date.now() },
    lastQuery: { query, pages, domain, maxItems }
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL('results.html?start=1') });
  window.close();
});

openBtn.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  window.close();
});
