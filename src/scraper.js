const { chromium } = require('playwright');
const logger = require('./logger');
const config = require('./config');

const BASE = config.scraper.baseUrl;

// Ключевые слова в заголовке — считаем инструкцией (для Новостей)
const INSTRUCTION_TITLE_RX = /^(как |виды |способы |подготовка |замер |устройство |конструкция |монтаж|установка |регулировка|полотно |короба |направляющие|механизм|кардан|ленточное|накладной|встроенный|комбинированный|производство|профиля |системы |материалы |схема |подключение|настройка|ремонт|обслуживание|технические характеристики)/i;

// URL-части страниц магазина, которые нужно пропускать
const SHOP_EXCLUDE_URL_PARTS = ['tehnicheskie-instrukcii', 'sertifikat', 'sertifikaty'];

// Разделы для мониторинга
const SECTIONS = [
  { listUrl: `${BASE}/news.html`,   articlePrefix: '/news/',   section: 'Новости', type: 'news',  filterInstructions: false, listType: 'news' },
  { listUrl: `${BASE}/action.html`, articlePrefix: '/action/', section: 'Акции',   type: 'promo', filterInstructions: false, listType: 'news' },
  // Магазин — информационные страницы категорий товаров
  { listUrl: `${BASE}/rolstavni.html`,        articlePrefix: '/rolstavni/',        section: 'Магазин / Рольставни',        type: 'news', listType: 'shop' },
  { listUrl: `${BASE}/shlagbaumy.html`,        articlePrefix: '/shlagbaumy/',       section: 'Магазин / Шлагбаумы',         type: 'news', listType: 'shop' },
  { listUrl: `${BASE}/vorota-sekcionnye.html`, articlePrefix: '/vorota-sekcionnye/', section: 'Магазин / Ворота секционные', type: 'news', listType: 'shop' },
  { listUrl: `${BASE}/vorota-raspashnye.html`, articlePrefix: '/vorota-raspashnye/', section: 'Магазин / Ворота распашные',  type: 'news', listType: 'shop' },
  { listUrl: `${BASE}/vorota-otkatnye.html`,   articlePrefix: '/vorota-otkatnye/',   section: 'Магазин / Ворота откатные',   type: 'news', listType: 'shop' },
];

function parseDate(str = '') {
  const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(iso[0]);
  return null;
}

function toIsoDate(dateStr) {
  const d = parseDate(dateStr);
  return d ? d.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

// ─── Парсинг списка новостей/акций ───────────────────────────────────────────

async function scrapeNewsList(page, section) {
  return page.evaluate(({ articlePrefix }) => {
    const items = [];
    const seen = new Set();

    document.querySelectorAll('.news_prods').forEach(el => {
      const linkEl = el.querySelector('.prevsText a, a[href*="' + articlePrefix + '"]');
      const dateEl = el.querySelector('span.date');
      const imgEl  = el.querySelector('.blocksIMgNews img, img');

      if (!linkEl) return;

      const url = linkEl.href;
      if (!url.includes(articlePrefix)) return;
      if (seen.has(url)) return;
      seen.add(url);

      const title = linkEl.getAttribute('title') || linkEl.textContent.trim();
      const date  = dateEl?.textContent?.trim() || '';
      let   img   = imgEl?.src || '';

      img = img.replace('/assets/cache/images/', '/assets/images/')
               .replace(/\/x-/, '/')
               .replace(/\.367\.jpg$/, '.jpg')
               .replace(/\.367\.png$/, '.png');

      items.push({ url, title, date, thumbImg: img });
    });

    return items;
  }, { articlePrefix: section.articlePrefix });
}

// ─── Парсинг списка страниц магазина ─────────────────────────────────────────

async function scrapeShopList(page, section) {
  return page.evaluate(({ articlePrefix, excludeUrlParts }) => {
    const items = [];
    const seen = new Set();

    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href || '';
      const text = a.textContent.trim().replace(/\s+/g, ' ');
      if (!href.includes(articlePrefix) || !text) return;

      // Только прямые подстраницы категории (/section/page.html, не глубже)
      try {
        const path = new URL(href).pathname.replace(/^\//, '');
        const parts = path.split('/');
        if (parts.length !== 2) return; // пропускаем /section/sub/page.html
      } catch (_) { return; }

      if (seen.has(href)) return;

      // Исключаем технические страницы по URL
      const hrefLower = href.toLowerCase();
      if (excludeUrlParts.some(p => hrefLower.includes(p))) return;

      seen.add(href);
      items.push({ url: href, title: text, date: '', thumbImg: '' });
    });

    return items;
  }, { articlePrefix: section.articlePrefix, excludeUrlParts: SHOP_EXCLUDE_URL_PARTS });
}

// ─── Универсальный парсинг списка ─────────────────────────────────────────────

async function scrapeList(page, section) {
  try {
    const res = await page.goto(section.listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || res.status() >= 400) {
      logger.warn(`Страница недоступна: ${section.listUrl} (HTTP ${res?.status()})`);
      return [];
    }
    await page.waitForTimeout(1500);
  } catch (e) {
    logger.warn(`Не удалось открыть ${section.listUrl}: ${e.message}`);
    return [];
  }

  if (section.listType === 'shop') {
    return scrapeShopList(page, section);
  }
  return scrapeNewsList(page, section);
}

// ─── Парсинг полной статьи ────────────────────────────────────────────────────

async function scrapeArticle(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
  } catch (e) {
    logger.warn(`Не удалось открыть ${url}: ${e.message}`);
    return null;
  }

  const { h1, text, imageUrl } = await page.evaluate(({ base }) => {
    // Убираем шум
    ['script','style','form','.bramy-mobile-header-wrap','.bramy-nav',
     '.bramy-mobile-nav-wrap','.menu-nav','.menu-top','.B_crumbBox',
     '.leftcol','.sidebar','.col-basket','.toppart'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const h1 = document.querySelector('h1')?.textContent?.trim() || '';

    // Контент в .mainpole_nomain_page
    const contentEl = document.querySelector('.mainpole_nomain_page, .colspan4');
    let text = '';
    if (contentEl) {
      // Убираем форму обратной связи
      contentEl.querySelectorAll('form, article').forEach(el => el.remove());
      text = contentEl.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    // Ищем первую подходящую картинку контента
    const allImgs = [...document.querySelectorAll('img[src]')].map(i => i.src);
    const isContent = s =>
      (s.includes('/assets/images/our_photo/') || s.includes('/images/our_photo/') ||
       s.includes('/content/') || s.includes('/img1/')) &&
      !s.includes('logo') && !s.includes('icon') && !s.includes('basket') &&
      !s.includes('vk.') && !s.includes('mail.') && !s.includes('facebook') &&
      !s.includes('/icons') && !s.includes('closelabel');
    // Приоритет: our_photo > content > img1
    const imageUrl =
      allImgs.find(s => (s.includes('/assets/images/our_photo/') || s.includes('/images/our_photo/')) && isContent(s)) ||
      allImgs.find(s => s.includes('/content/') && isContent(s)) ||
      allImgs.find(s => s.includes('/img1/') && isContent(s)) ||
      null;

    return { h1, text, imageUrl };
  }, { base: BASE });

  // Скачиваем картинку через fetch внутри самого браузера —
  // запрос идёт от той же сессии с нужными куками и TLS-отпечатком
  let imageData = null;
  if (imageUrl) {
    try {
      const base64 = await page.evaluate(async (imgUrl) => {
        const resp = await fetch(imgUrl, { credentials: 'include' });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      }, imageUrl);
      if (base64) imageData = Buffer.from(base64, 'base64');
    } catch (e) {
      logger.warn(`Не удалось скачать картинку ${imageUrl}: ${e.message}`);
    }
  }

  return { h1, text, imageUrl, imageData };
}

// ─── Определение секции по категории ─────────────────────────────────────────

function detectCategory(url, title) {
  const s = (url + ' ' + title).toLowerCase();
  if (/rolstavn|роллет|рольстав/.test(s)) return 'Рольставни';
  if (/shlagbaum|шлагбаум/.test(s)) return 'Шлагбаумы';
  if (/vorota|ворот/.test(s)) return 'Ворота';
  if (/avtomatik|автоматик/.test(s)) return 'Автоматика';
  return null;
}

// ─── Главная функция ──────────────────────────────────────────────────────────

async function getNewArticles(db) {
  const isFirstRun = db.all().length === 0;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  const newArticles = [];

  if (isFirstRun) {
    logger.info('Первый запуск — заполняем базу, переходим в режим мониторинга');
  }

  try {
    for (const section of SECTIONS) {
      logger.info(`Проверяем: ${section.section} (${section.listUrl})`);

      const listings = await scrapeList(page, section);
      logger.info(`  Найдено в списке: ${listings.length}`);

      for (const item of listings) {
        // Для новостей — фильтруем инструкции по заголовку
        if (section.listType === 'news' && section.filterInstructions && INSTRUCTION_TITLE_RX.test(item.title)) {
          logger.info(`  Инструкция, пропуск: ${item.title}`);
          continue;
        }

        if (db.exists(item.url)) continue;

        if (isFirstRun) {
          db.saveAsSeen({
            url:         item.url,
            title:       item.title,
            section:     section.section,
            articleType: section.type,
            publishedAt: toIsoDate(item.date),
          });
          logger.info(`  📚 В базу (не публикуется): ${item.title}`);
          continue;
        }

        // Новая статья появилась во время мониторинга — парсим и публикуем
        logger.info(`  🆕 Новая статья: ${item.title}`);
        const full = await scrapeArticle(page, item.url);
        if (!full) continue;

        const category = detectCategory(item.url, item.title);
        const imgSize  = full.imageData ? `${Math.round(full.imageData.length / 1024)} KB` : 'нет';
        logger.info(`  ✓ Спарсено: "${full.h1 || item.title}" | фото: ${imgSize}`);

        newArticles.push({
          url:         item.url,
          title:       full.h1 || item.title,
          section:     section.section + (category ? ` / ${category}` : ''),
          articleType: section.type,
          publishedAt: toIsoDate(item.date),
          text:        full.text,
          imageUrl:    full.imageUrl || item.thumbImg || null,
          imageData:   full.imageData || null,
        });

        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await browser.close();
  }

  if (isFirstRun) {
    logger.info('База заполнена. Переход в режим мониторинга.');
  }

  return newArticles;
}

async function scrapeOneArticle(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  try {
    return await scrapeArticle(page, url);
  } finally {
    await browser.close();
  }
}

// Парсит несколько статей в одном браузере — эффективнее для retry
async function scrapeMultiple(urls) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  const results = new Map();
  try {
    for (const url of urls) {
      const data = await scrapeArticle(page, url);
      results.set(url, data);
      await page.waitForTimeout(500);
    }
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { getNewArticles, scrapeOneArticle, scrapeMultiple };
