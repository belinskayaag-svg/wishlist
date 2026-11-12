// Сервер виш-листа: отдаёт страницу и помогает заполнить карточку по ссылке.
// GET /api/preview?url=<ссылка на товар>  →  {title, price, image, shop}
// Без внешних зависимостей, нужен Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* ---------- маленький кэш, чтобы не дёргать магазин повторно ---------- */
const cache = new Map();
const CACHE_MS = 60 * 60 * 1000;

/* ---------- сеть ---------- */
async function get(url, { timeout = 9000, accept = 'text/html,application/xhtml+xml', method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      method, redirect: 'follow', signal: ctrl.signal,
      headers: { 'user-agent': UA, accept, 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' },
    });
  } finally { clearTimeout(t); }
}

// не пускаем запросы во внутреннюю сеть хостинга
function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.startsWith('[')) return null;
  return u;
}

/* ---------- Wildberries: у них открытые данные о товаре ---------- */
async function wildberries(u) {
  const m = u.pathname.match(/catalog\/(\d+)/) || u.search.match(/nm=(\d+)/);
  if (!m) return null;
  const id = +m[1];
  const out = { shop: 'Wildberries' };

  const r = await get(`https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${id}`, { accept: 'application/json' });
  if (r.ok) {
    const j = await r.json();
    const p = j?.data?.products?.[0];
    if (p) {
      out.title = [p.brand, p.name].filter(Boolean).join(' ').trim() || p.name;
      const size = (p.sizes || []).find(s => s.price) || {};
      const kop = size.price?.product ?? size.price?.total ?? p.salePriceU ?? p.priceU;
      if (kop) out.price = Math.round(kop / 100);
    }
  }

  // фото и карточка лежат на одном из «basket»-серверов; перебираем и берём тот, что ответил
  const vol = Math.floor(id / 1e5), part = Math.floor(id / 1e3);
  const bases = Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(2, '0'))
    .map(b => `https://basket-${b}.wbbasket.ru/vol${vol}/part${part}/${id}`);
  const base = await Promise.any(bases.map(async b => {
    const r = await get(`${b}/images/big/1.webp`, { method: 'HEAD', timeout: 5000, accept: 'image/*' });
    if (!r.ok) throw 0;
    return b;
  })).catch(() => undefined);

  if (base) {
    out.image = `${base}/images/big/1.webp`;
    if (!out.title) {
      const c = await get(`${base}/info/ru/card.json`, { accept: 'application/json' }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (c?.imt_name) out.title = [c.selling?.brand_name, c.imt_name].filter(Boolean).join(' ');
    }
    if (!out.price) {
      // последняя запись в истории цен ≈ текущая цена
      const h = await get(`${base}/info/price-history.json`, { accept: 'application/json' }).then(r => r.ok ? r.json() : null).catch(() => null);
      const last = Array.isArray(h) && h[h.length - 1];
      const kop = last?.price?.RUB;
      if (kop) out.price = Math.round(kop / 100);
    }
  }

  return out.title || out.image ? out : null;
}

/* ---------- все остальные: читаем разметку страницы ---------- */
const decode = s => s
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function meta(html, names) {
  for (const n of names) {
    const val = `content=(?:"([^"]*)"|'([^']*)')`;
    const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*${val}`, 'i');
    const re2 = new RegExp(`<meta[^>]+${val}[^>]*(?:property|name|itemprop)=["']${n}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    const v = m && (m[1] ?? m[2]);
    if (v && v.trim()) return decode(v).trim();
  }
}

function jsonLdProduct(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== 'object') continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const type = [].concat(x['@type'] || []).join(',');
      if (/Product/i.test(type)) {
        const offers = [].concat(x.offers || []);
        const o = offers[0] || {};
        const price = o.price ?? o.lowPrice ?? o.priceSpecification?.price ?? offers.find(z => z?.price)?.price;
        const img = [].concat(x.image || [])[0];
        return { title: x.name, price, image: typeof img === 'string' ? img : img?.url || img?.contentUrl };
      }
      if (x['@graph']) stack.push(x['@graph']);
    }
  }
  return {};
}

const toNum = v => {
  if (v == null) return undefined;
  const n = parseFloat(String(v).replace(/\s| /g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

const cleanTitle = (t, host) => {
  if (!t) return t;
  t = t.replace(/\s+/g, ' ').trim();
  // убираем хвосты вида «— купить в интернет-магазине …», «| Lamoda»
  t = t.replace(/\s*[|—–-]\s*(купить|заказать|интернет-магазин|официальный|lamoda|ozon|золотое яблоко|goldapple|12\s?storeez).*$/i, '');
  t = t.replace(/^купить\s+/i, '').replace(/\s+(за|по цене)\s+[\d\s]+\s?(₽|руб).*$/i, '');
  return t.trim();
};

async function generic(u) {
  const r = await get(u.href);
  if (!r.ok) throw new Error('status ' + r.status);
  const html = (await r.text()).slice(0, 1_500_000);
  const pageTitle = decode((html.match(/<title[^>]*>([^<]+)/i) || [])[1] || '');
  // страница-заглушка от защиты от роботов
  if (/checking (your )?(device|browser)|just a moment|доступ (ограничен|запрещ)|запрос отклон|captcha|подтвердите, что вы не робот/i.test(pageTitle)) {
    throw new Error('bot wall');
  }
  const ld = jsonLdProduct(html);
  const metaPrice = toNum(meta(html, ['product:price:amount', 'og:price:amount', 'price']));
  const ogType = meta(html, ['og:type']) || '';
  // страница собирается в браузере, и в разметке только общее «название магазина + логотип»
  if (!ld.title && !metaPrice && !/product/i.test(ogType) && /^website$/i.test(ogType)) throw new Error('no product data');
  const title = ld.title || meta(html, ['og:title', 'twitter:title']) || pageTitle;
  const price = toNum(ld.price) ?? metaPrice;
  let image = ld.image || meta(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'image']);
  if (image) { try { image = new URL(decode(image), r.url).href; } catch { image = undefined; } }
  if (!title && !image) throw new Error('nothing found');
  return { title: cleanTitle(title && decode(title), u.hostname), price, image };
}

async function preview(raw) {
  const u = safeUrl(raw);
  if (!u) return { status: 400, body: { error: 'bad url' } };
  const hit = cache.get(u.href);
  if (hit && Date.now() - hit.t < CACHE_MS) return { status: 200, body: hit.v };
  try {
    let v = null;
    if (/(^|\.)wildberries\.ru$|(^|\.)wb\.ru$/.test(u.hostname)) v = await wildberries(u).catch(() => null);
    if (!v) v = await generic(u);
    cache.set(u.href, { t: Date.now(), v });
    return { status: 200, body: v };
  } catch (e) {
    return { status: 502, body: { error: 'cannot read page' } };
  }
}

/* ---------- http ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/preview') {
    const { status, body } = await preview(url.searchParams.get('url') || '');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!file || file.endsWith('/')) file += 'index.html';
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || /(^|[/\\])(server\.js|Dockerfile|package\.json|node_modules|\.)/.test(file)) {
    res.writeHead(404); return res.end('not found');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`wishlist on http://localhost:${PORT}`));
module.exports = { jsonLdProduct, meta, cleanTitle, toNum, safeUrl };
