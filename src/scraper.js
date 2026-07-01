const { chromium } = require('playwright');
const logger = require('./logger');
const config = require('./config');

const BASE = config.scraper.baseUrl;

// Ключевые слова в заголовке — считаем инструкцией (для Магазина)
const INSTRUCTION_TITLE_RX = /^(как |виды |способы |подготовка |замер |устройство |конструкция |монтаж|установка |регулировка|полотно |короба |направляющие|механизм|кардан|ленточное|накладной|встроенный|комбинированный|производство|профиля |системы |материалы |схема |подключение|настройка|ремонт|обслуживание|технические характеристики)/i;

// Разделы для мониторинга
const SECTIONS = [
  { listUrl: `${BASE}/news.html`,    articlePrefix: '/news/',    section: 'Новости', type: 'news',  filterInstructions: false },
  { listUrl: `${BASE}/action.html`,  articlePrefix: '/action/',  section: 'Акции',   type: 'promo', filterInstructions: false },
  // Магазин — подкатегории каталога, постим информационные страницы товаров
  { listUrl: `${BASE}/rolstavni2/`,         articlePrefix: '/rolstavni2/',         section: 'Магазин / Рольставни',          type: 'news', filterInstructions: true },
  { listUrl: `${BASE}/shlagbaumy2/`,        articlePrefix: '/shlagbaumy2/',        section: 'Магазин / Шлагбаумы',           type: 'news', filterInstructions: true },
  { listUrl: `${BASE}/vorota-sekcionnye2/`, articlePrefix: '/vorota-sekcionnye2/', section: 'Магазин / Ворота секционные',   type: 'news', filterInstructions: true },
  { listUrl: `${BASE}/vorota-raspashnye2/`, articlePrefix: '/vorota-raspashnye2/', section: 'Магазин / Ворота распашные',    type: 'news', filterInstructions: true },
  { listUrl: `${BASE}/vorota-otkatnye2/`,   articlePrefix: '/vorota-otkatnye2/',   section: 'Магазин / Ворота откатные',     type: 'news', filterInstructions: true },
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

// ─── Парсинг списка статей ────────────────────────────────────────────────────

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

  return page.evaluate(({ base, articlePrefix }) => {
    const items = [];
    const seen = new Set();

    document.querySelectorAll('.news_prods').forEach(el => {
      const linkEl  = el.querySelector('.prevsText a, a[href*="' + articlePrefix + '"]');
      const dateEl  = el.querySelector('span.date');
      const imgEl   = el.querySelector('.blocksIMgNews img, img');

      if (!linkEl) return;

      const url = linkEl.href;
      if (!url.includes(articlePrefix)) return;
      if (seen.has(url)) return;
      seen.add(url);

      const title = linkEl.getAttribute('title') || linkEl.textContent.trim();
      const date  = dateEl?.textContent?.trim() || '';
      let   img   = imgEl?.src || '';

      // Из src миниатюры извлекаем полный путь (убираем размер x- и .367)
      // /assets/cache/images/our_photo/news/x-slug.367.jpg → /assets/images/our_photo/news/slug.*
      img = img.replace('/assets/cache/images/', '/assets/images/')
               .replace(/\/x-/, '/')
               .replace(/\.367\.jpg$/, '.jpg')
               .replace(/\.367\.png$/, '.png');

      items.push({ url, title, date, thumbImg: img });
    });

    return items;
  }, { base: BASE, articlePrefix: section.articlePrefix });
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

    // Первая картинка из /assets/images/our_photo/
    const imgs = [...document.querySelectorAll('img[src]')]
      .map(i => i.src)
      .filter(s => s.includes('/assets/images/our_photo/') || s.includes('/images/our_photo/'));

    return { h1, text, imageUrl: imgs[0] || null };
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
  // Первый запуск: база пустая — сохраняем всё как "уже виденное", не публикуем
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
    logger.info('Первый запуск — заполняем базу, публикаций не будет');
  }

  try {
    for (const section of SECTIONS) {
      logger.info(`Проверяем: ${section.section} (${section.listUrl})`);

      const listings = await scrapeList(page, section);
      logger.info(`  Найдено в списке: ${listings.length}`);

      for (const item of listings) {
        if (section.filterInstructions && INSTRUCTION_TITLE_RX.test(item.title)) {
          logger.info(`  Инструкция, пропуск: ${item.title}`);
          continue;
        }

        if (db.exists(item.url)) continue;

        if (isFirstRun) {
          // Сохраняем как уже виденную — публиковать не нужно
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
