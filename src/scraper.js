const { chromium } = require('playwright');
const logger = require('./logger');
const config = require('./config');

const BASE = config.scraper.baseUrl;

// Ключевые слова в заголовке — считаем инструкцией/обслуживанием, не продающим контентом
const INSTRUCTION_TITLE_RX = /^(как |подготовка |замер |устройство |конструкция |монтаж|установка |регулировка|полотно |короба |направляющие|механизм|кардан|ленточное|накладной|встроенный|комбинированный|производство|схема |подключение|настройка|ремонт|обслуживание|технические характеристики|врезка |эксплуатац|инструкц|сервис)/i;

// URL-части страниц магазина, которые нужно пропускать
const SHOP_EXCLUDE_URL_PARTS = ['tehnicheskie-instrukcii', 'sertifikat', 'sertifikaty'];

// Разделы для мониторинга
const SECTIONS = [
  { listUrl: `${BASE}/news.html`,   articlePrefix: '/news/',   section: 'Новости', type: 'news',  filterInstructions: true, listType: 'news' },
  { listUrl: `${BASE}/action.html`, articlePrefix: '/action/', section: 'Акции',   type: 'promo', filterInstructions: true, listType: 'news' },
  // Магазин — информационные страницы категорий товаров
  { listUrl: `${BASE}/rolstavni.html`,        articlePrefix: '/rolstavni/',        section: 'Магазин / Рольставни',        type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/shlagbaumy.html`,        articlePrefix: '/shlagbaumy/',       section: 'Магазин / Шлагбаумы',         type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/vorota-sekcionnye.html`, articlePrefix: '/vorota-sekcionnye/', section: 'Магазин / Ворота секционные', type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/vorota-raspashnye.html`, articlePrefix: '/vorota-raspashnye/', section: 'Магазин / Ворота распашные',  type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/vorota-otkatnye.html`,   articlePrefix: '/vorota-otkatnye/',   section: 'Магазин / Ворота откатные',   type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/solncezashhitnye-sistemy.html`, articlePrefix: '/solncezashhitnye-sistemy/', section: 'Магазин / Солнцезащитные системы', type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/metallokonstrukcii.html`,        articlePrefix: '/metallokonstrukcii/',        section: 'Магазин / Металлоконструкции',      type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/domofony.html`,                  articlePrefix: '/domofony/',                  section: 'Магазин / Домофоны',                type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/videonablyudenie.html`,          articlePrefix: '/videonablyudenie/',          section: 'Магазин / Видеонаблюдение',          type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/radioupravlenie.html`,           articlePrefix: '/radioupravlenie/',           section: 'Магазин / Радиоуправление',          type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/aksessuary.html`,                articlePrefix: '/aksessuary/',                section: 'Магазин / Аксессуары',               type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/zamki-dovodchiki.html`,          articlePrefix: '/zamki-dovodchiki/',          section: 'Магазин / Замки, доводчики',         type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/istochniki-pitaniya.html`,       articlePrefix: '/istochniki-pitaniya/',       section: 'Магазин / Источники питания',        type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/mezhkomnatnye-dveri.html`,       articlePrefix: '/mezhkomnatnye-dveri/',       section: 'Магазин / Межкомнатные двери',       type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/avtomaticheskie-cepi-i-parkovochnye-sistemy.html`, articlePrefix: '/avtomaticheskie-cepi-i-parkovochnye-sistemy/', section: 'Магазин / Парковочные системы', type: 'news', listType: 'shop', filterInstructions: true },
  { listUrl: `${BASE}/solncezashhita.html`,            articlePrefix: '/solncezashhita/',            section: 'Магазин / Солнцезащита',             type: 'news', listType: 'shop', filterInstructions: true },
  // Настоящие каталоги товаров (с ценами) — отдельные от страниц-статей выше,
  // те же категории продублированы под URL с цифровым суффиксом
  { listUrl: `${BASE}/rolstavni2.html`,        articlePrefix: '/rolstavni2/',        section: 'Магазин / Рольставни (каталог)',        type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/shlagbaumy2.html`,       articlePrefix: '/shlagbaumy2/',       section: 'Магазин / Шлагбаумы (каталог)',         type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/vorota-sekcionnye1.html`, articlePrefix: '/vorota-sekcionnye1/', section: 'Магазин / Ворота секционные (каталог)', type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/vorota-raspashnye2.html`, articlePrefix: '/vorota-raspashnye2/', section: 'Магазин / Ворота распашные (каталог)',  type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/vorota-otkatnye1.html`,  articlePrefix: '/vorota-otkatnye1/',  section: 'Магазин / Ворота откатные (каталог)',   type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/domofony2.html`,         articlePrefix: '/domofony2/',         section: 'Магазин / Домофоны (каталог)',          type: 'news', listType: 'catalog2', filterInstructions: true },
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

// Ссылки на странице, у которых путь состоит ровно из `depth` сегментов
// (/section/page.html — depth=2, /section/sub/page.html — depth=3, и т.д.).
// containerSelector сужает поиск до конкретного блока страницы — это важно на
// страницах подкатегорий каталога: в боковой колонке (.leftcol) сайт рисует
// виджеты "новинки"/"хиты"/"реклама" со случайными товарами со всего сайта,
// и без сужения они попадают в список наравне с настоящими товарами раздела.
function extractLinksAtDepth(page, articlePrefix, depth, excludeUrlParts, containerSelector = 'body') {
  return page.evaluate(({ articlePrefix, depth, excludeUrlParts, containerSelector }) => {
    const root = document.querySelector(containerSelector) || document.body;
    const items = [];
    const seen = new Set();

    root.querySelectorAll('a[href]').forEach(a => {
      const href = a.href || '';
      const text = a.textContent.trim().replace(/\s+/g, ' ');
      if (!href.includes(articlePrefix) || !text) return;

      let parts;
      try {
        const u = new URL(href);
        if (u.search) return; // ссылки пагинации/сортировки — не самостоятельные страницы
        parts = u.pathname.replace(/^\//, '').split('/');
      } catch (_) { return; }
      if (parts.length !== depth) return;

      if (seen.has(href)) return;

      const hrefLower = href.toLowerCase();
      if (excludeUrlParts.some(p => hrefLower.includes(p))) return;

      seen.add(href);
      items.push({ url: href, title: text, date: '', thumbImg: '' });
    });

    return items;
  }, { articlePrefix, depth, excludeUrlParts, containerSelector });
}

async function scrapeShopList(page, section) {
  return extractLinksAtDepth(page, section.articlePrefix, 2, SHOP_EXCLUDE_URL_PARTS);
}

// Контейнер с основным контентом страницы (тот же, что использует scrapeArticle
// для текста статьи) — исключает сайдбар с виджетами рекомендаций
const MAIN_CONTENT_SELECTOR = '.mainpole_nomain_page';

// Некоторые разделы магазина продублированы отдельным "настоящим" каталогом
// товаров (URL с цифровым суффиксом, например rolstavni2.html) — в отличие от
// его страницы-статьи (rolstavni.html), товары там лежат на уровень глубже:
// категория → подкатегория → товар. Подкатегории берём из навигационного меню
// сайта (стабильны), товары — с каждой подкатегории отдельно.
//
// У подкатегорий может быть очень глубокая пагинация (сотни товаров, десятки
// страниц) — обходить её всю на каждой проверке нереально. Вместо этого
// открываем подкатегорию с сортировкой "сначала новые" (?sortby=new) и берём
// только первую страницу — этого достаточно, чтобы не пропустить товары,
// добавленные между проверками.
async function scrapeCatalogList(page, section) {
  const subcats = await extractLinksAtDepth(page, section.articlePrefix, 2, SHOP_EXCLUDE_URL_PARTS);
  const products = [];
  const seen = new Set();

  for (const sub of subcats) {
    const sortedUrl = `${sub.url}?sortby=new`;
    try {
      const res = await page.goto(sortedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!res || res.status() >= 400) {
        logger.warn(`Страница недоступна: ${sortedUrl} (HTTP ${res?.status()})`);
        continue;
      }
      await page.waitForTimeout(1000);
    } catch (e) {
      logger.warn(`Не удалось открыть ${sortedUrl}: ${e.message}`);
      continue;
    }

    const items = await extractLinksAtDepth(page, section.articlePrefix, 3, SHOP_EXCLUDE_URL_PARTS, `${MAIN_CONTENT_SELECTOR} .cont-items`);
    for (const item of items) {
      // Один и тот же товар иногда встречается в нескольких подкатегориях
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      products.push(item);
    }
  }

  return products;
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

  if (section.listType === 'catalog2') {
    return scrapeCatalogList(page, section);
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

// ─── Автообнаружение новых разделов каталога ─────────────────────────────────

// Выпадающее меню "Магазин" в шапке сайта — единственное место, где перечислены
// все категории реального каталога товаров. Если владелец сайта добавит сюда
// новую категорию, парсер подхватит её сам — не нужно вручную дописывать SECTIONS.
const SHOP_MENU_LABEL = 'Магазин';

async function readShopMenu(page) {
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
  } catch (e) {
    logger.warn(`Не удалось открыть главную для поиска новых разделов: ${e.message}`);
    return [];
  }

  return page.evaluate((label) => {
    const nav = document.querySelector('.menu-nav');
    if (!nav) return [];
    const shopLink = [...nav.querySelectorAll('a')].find((a) => a.textContent.trim() === label);
    const submenu = shopLink?.closest('li')?.querySelector('ul');
    if (!submenu) return [];

    return [...submenu.children]
      .filter((c) => c.tagName === 'LI')
      .map((li) => {
        const a = li.querySelector(':scope > a');
        return a ? { href: a.href, title: a.textContent.trim() } : null;
      })
      .filter(Boolean);
  }, SHOP_MENU_LABEL);
}

function toArticlePrefix(href) {
  const path = new URL(href).pathname.replace(/\.html$/, '');
  return `${path}/`;
}

// Определяет, лежат ли товары прямо в категории (глубина 2, как scrapeShopList)
// или ещё уровнем глубже, в подкатегориях (глубина 3, как scrapeCatalogList)
async function detectListType(page, listUrl, articlePrefix) {
  try {
    const res = await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || res.status() >= 400) return null;
    await page.waitForTimeout(1000);
  } catch (_) {
    return null;
  }

  const level2 = await extractLinksAtDepth(page, articlePrefix, 2, SHOP_EXCLUDE_URL_PARTS);
  if (level2.length === 0) return null;

  try {
    await page.goto(`${level2[0].url}?sortby=new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
  } catch (_) {
    return 'shop';
  }
  const level3 = await extractLinksAtDepth(page, articlePrefix, 3, SHOP_EXCLUDE_URL_PARTS, `${MAIN_CONTENT_SELECTOR} .cont-items`);
  return level3.length > 0 ? 'catalog2' : 'shop';
}

// Сравнивает меню "Магазин" со статическим списком SECTIONS и возвращает
// описания разделов, которых там ещё нет
async function discoverSections(page, knownListUrls) {
  let menuItems;
  try {
    menuItems = await readShopMenu(page);
  } catch (e) {
    logger.warn(`Автообнаружение разделов не удалось: ${e.message}`);
    return [];
  }

  const discovered = [];
  for (const item of menuItems) {
    if (knownListUrls.has(item.href)) continue;

    const articlePrefix = toArticlePrefix(item.href);
    const listType = await detectListType(page, item.href, articlePrefix);
    if (!listType) {
      logger.warn(`Автообнаружение: не удалось определить тип нового раздела "${item.title}" (${item.href})`);
      continue;
    }

    discovered.push({
      listUrl: item.href,
      articlePrefix,
      section: `Магазин / ${item.title}${listType === 'catalog2' ? ' (каталог)' : ''}`,
      type: 'news',
      listType,
      filterInstructions: true,
      autoDiscovered: true,
    });
  }
  return discovered;
}

// ─── Главная функция ──────────────────────────────────────────────────────────

// Раздел уже "заселён" (виделся раньше) — проверяем не по всей базе, а по конкретному
// разделу, чтобы новые разделы, добавленные позже, сперва тоже молча заполнялись,
// а не публиковали разом все старые страницы, которые в них найдутся.
function isSectionSeeded(existingArticles, section) {
  return existingArticles.some(
    (a) => a.section === section.section || a.section.startsWith(`${section.section} / `)
  );
}

async function getNewArticles(db) {
  const existingArticles = db.all();
  const isFirstRun = existingArticles.length === 0;

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
    const knownListUrls = new Set(SECTIONS.map((s) => s.listUrl));
    const discovered = await discoverSections(page, knownListUrls);
    const sections = [...SECTIONS, ...discovered];

    for (const section of sections) {
      const sectionSeeded = isSectionSeeded(existingArticles, section);

      if (section.autoDiscovered && !sectionSeeded) {
        await logger.infoNotify(`Обнаружен новый раздел на сайте: «${section.section}» (${section.listUrl}) — добавлен в мониторинг автоматически, база заполняется без публикации`);
      }

      logger.info(`Проверяем: ${section.section} (${section.listUrl})${sectionSeeded ? '' : ' — новый раздел, заполняем базу'}`);

      const listings = await scrapeList(page, section);
      logger.info(`  Найдено в списке: ${listings.length}`);

      for (const item of listings) {
        // Фильтруем инструкции/сервис по заголовку — оставляем только продающий контент
        if (section.filterInstructions && INSTRUCTION_TITLE_RX.test(item.title)) {
          logger.info(`  Инструкция/сервис, пропуск: ${item.title}`);
          continue;
        }

        if (db.exists(item.url)) continue;

        if (!sectionSeeded) {
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
