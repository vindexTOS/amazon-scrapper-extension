const tbody = document.querySelector('#tbl tbody');
const countEl = document.getElementById('count');
const progressEl = document.getElementById('progress');
const barEl = document.getElementById('bar');
const filterEl = document.getElementById('filter');
const emptyEl = document.getElementById('empty');

let allItems = [];
let scraping = false;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}

function render() {
  const q = filterEl.value.trim().toLowerCase();
  const filtered = q
    ? allItems.filter(i => ['title','asin','price'].some(k => (i[k] || '').toLowerCase().includes(q)))
    : allItems;
  countEl.textContent = filtered.length === allItems.length
    ? `${allItems.length} items`
    : `${filtered.length} of ${allItems.length} items`;
  emptyEl.style.display = allItems.length === 0 ? 'block' : 'none';
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  filtered.forEach((it, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${it.image ? `<img class="thumb" src="${escapeHtml(it.image)}" loading="lazy">` : ''}</td>
      <td class="title">${escapeHtml(it.title)}${it.sponsored === 'yes' ? '<span class="badge">SPONSORED</span>' : ''}</td>
      <td>${escapeHtml(it.price)}</td>
      <td>${escapeHtml(it.rating)}</td>
      <td>${escapeHtml(it.reviews)}</td>
      <td>${escapeHtml(it.page)}</td>
      <td>${escapeHtml(it.asin)}</td>
      <td>${escapeHtml(it.sponsored)}</td>
      <td>${it.url ? `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">Open</a>` : ''}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

function setProgress(message, current, total) {
  progressEl.textContent = message;
  if (total > 0) barEl.style.width = Math.min(100, Math.round((current / total) * 100)) + '%';
  else barEl.style.width = '0%';
}

filterEl.addEventListener('input', render);

document.getElementById('csv').addEventListener('click', () => {
  const headers = ['asin','title','price','rating','reviews','page','sponsored','url','image'];
  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [headers.join(',')]
    .concat(allItems.map(i => headers.map(h => csvCell(i[h])).join(',')));
  // BOM so Excel detects UTF-8 cleanly
  download(filename('csv'), '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8;');
});

document.getElementById('xls').addEventListener('click', () => {
  const headers = ['asin','title','price','rating','reviews','page','sponsored','url','image'];
  const xmlEsc = (v) => String(v == null ? '' : v).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','\'':'&apos;','"':'&quot;' }[c]));
  const headerRow = `<Row>${headers.map(h => `<Cell><Data ss:Type="String">${h}</Data></Cell>`).join('')}</Row>`;
  const dataRows = allItems.map(it => `<Row>${headers.map(h => `<Cell><Data ss:Type="String">${xmlEsc(it[h])}</Data></Cell>`).join('')}</Row>`).join('');
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Results"><Table>${headerRow}${dataRows}</Table></Worksheet></Workbook>`;
  download(filename('xls'), xml, 'application/vnd.ms-excel');
});

document.getElementById('json').addEventListener('click', () => {
  download(filename('json'), JSON.stringify(allItems, null, 2), 'application/json');
});

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear all stored items?')) return;
  await chrome.storage.local.set({ items: [] });
  allItems = [];
  render();
});

function filename(ext) {
  const { lastQuery } = window.__cache || {};
  const slug = (lastQuery?.query || 'amazon').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug || 'amazon'}-${stamp}.${ext}`;
}

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.items) { allItems = changes.items.newValue || []; render(); }
});

// ----- scraping orchestration -----

function buildUrl(domain, query, page) {
  const cleanDomain = String(domain || 'amazon.com').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return `https://www.${cleanDomain}/s?k=${encodeURIComponent(query)}&page=${page}&ref=sr_pg_${page}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout waiting for page load'));
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Injected into Amazon search-result pages.
function pageScraper() {
  const captcha = document.body.innerText.includes('Enter the characters you see below')
    || document.querySelector('form[action*="validateCaptcha"]');
  if (captcha) return { captcha: true, items: [] };

  const items = [];
  const cards = document.querySelectorAll('[data-component-type="s-search-result"]');
  cards.forEach(card => {
    const asin = card.getAttribute('data-asin') || '';
    if (!asin) return;
    const titleEl = card.querySelector('h2 span') || card.querySelector('h2 a span') || card.querySelector('[data-cy="title-recipe"] span');
    const linkEl = card.querySelector('h2 a') || card.querySelector('a.a-link-normal.s-no-outline') || card.querySelector('a.a-link-normal');
    const priceEl = card.querySelector('.a-price > .a-offscreen');
    const ratingEl = card.querySelector('.a-icon-star-small .a-icon-alt, .a-icon-star .a-icon-alt');
    const reviewEl = card.querySelector('[aria-label$="ratings"], [aria-label$="rating"]')
      || card.querySelector('a[href*="#customerReviews"] span.s-underline-text')
      || card.querySelector('span.s-underline-text');
    const imgEl = card.querySelector('img.s-image');
    const sponsored = !!(
      card.querySelector('.puis-sponsored-label-text')
      || card.querySelector('[aria-label*="Sponsored"]')
      || card.querySelector('.s-sponsored-label-info-icon')
    );
    let href = '';
    if (linkEl) {
      try { href = new URL(linkEl.getAttribute('href'), location.origin).href; } catch (e) { href = linkEl.getAttribute('href') || ''; }
    }
    items.push({
      asin,
      title: titleEl ? titleEl.textContent.trim() : '',
      url: href,
      price: priceEl ? priceEl.textContent.trim() : '',
      rating: ratingEl ? ratingEl.textContent.trim() : '',
      reviews: reviewEl ? reviewEl.textContent.trim() : '',
      image: imgEl ? imgEl.getAttribute('src') : '',
      sponsored: sponsored ? 'yes' : 'no'
    });
  });
  return { captcha: false, items };
}

async function runScrape(query, pages, domain, maxItems = 2000) {
  if (scraping) return;
  scraping = true;
  allItems = [];
  await chrome.storage.local.set({ items: [] });
  const seen = new Set();
  let tab;
  try {
    setProgress(`Opening Amazon...`, 0, pages);
    tab = await chrome.tabs.create({ url: buildUrl(domain, query, 1), active: false });
    for (let p = 1; p <= pages; p++) {
      const url = buildUrl(domain, query, p);
      setProgress(`Loading page ${p}/${pages}...`, p - 1, pages);
      if (p > 1) {
        try { await chrome.tabs.update(tab.id, { url }); } catch (e) { break; }
      }
      try { await waitForTabComplete(tab.id); } catch (e) { setProgress(`Page ${p} timed out, continuing...`, p, pages); continue; }
      await sleep(1200 + Math.random() * 800);

      let result;
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageScraper });
        result = out && out[0] ? out[0].result : null;
      } catch (e) {
        result = null;
      }

      if (result && result.captcha) {
        setProgress(`Amazon CAPTCHA on page ${p}. Solve it in the opened tab, then rerun.`, p, pages);
        // surface tab so user can solve
        try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
        break;
      }

      const items = (result && result.items) || [];
      let newCount = 0;
      for (const it of items) {
        const key = it.asin || it.url;
        if (key && !seen.has(key)) {
          seen.add(key);
          it.page = String(p);
          allItems.push(it);
          newCount++;
          if (allItems.length >= maxItems) break;
        }
      }
      await chrome.storage.local.set({ items: allItems });
      render();
      setProgress(`Page ${p}/${pages} - +${newCount} items (${allItems.length}/${maxItems} total)`, p, pages);

      if (allItems.length >= maxItems) {
        setProgress(`Reached max item limit (${maxItems}).`, pages, pages);
        break;
      }

      if (items.length === 0) {
        // probably no more pages
        setProgress(`No items on page ${p}; stopping early. Total: ${allItems.length}`, pages, pages);
        break;
      }
    }
    setProgress(`Done. ${allItems.length} unique items collected.`, pages, pages);
  } catch (err) {
    setProgress(`Error: ${err.message}`, 0, pages);
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
    scraping = false;
  }
}

async function init() {
  const { items, lastQuery, pendingScrape } = await chrome.storage.local.get(['items', 'lastQuery', 'pendingScrape']);
  window.__cache = { lastQuery };
  allItems = items || [];
  render();

  const params = new URLSearchParams(location.search);
  const shouldStart = params.get('start') === '1' && pendingScrape && (Date.now() - pendingScrape.ts) < 60000;
  if (shouldStart) {
    await chrome.storage.local.remove('pendingScrape');
    runScrape(
      pendingScrape.query,
      pendingScrape.pages,
      pendingScrape.domain,
      pendingScrape.maxItems || 2000
    );
  } else if (allItems.length === 0) {
    setProgress('Idle. Open the popup to start a scrape.', 0, 1);
  } else {
    setProgress(`Loaded ${allItems.length} items from last run.`, 1, 1);
  }
}

init();
