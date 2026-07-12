const fs = require('fs');
const path = require('path');
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
  { listUrl: `${BASE}/radioupravlenie.html`,           articlePrefix: '/radioupravlenie/',           section: 'Магазин / Радиоуправление',          type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/aksessuary.html`,                articlePrefix: '/aksessuary/',                section: 'Магазин / Аксессуары',               type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/zamki-dovodchiki.html`,          articlePrefix: '/zamki-dovodchiki/',          section: 'Магазин / Замки, доводчики',         type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/istochniki-pitaniya.html`,       articlePrefix: '/istochniki-pitaniya/',       section: 'Магазин / Источники питания',        type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/mezhkomnatnye-dveri.html`,       articlePrefix: '/mezhkomnatnye-dveri/',       section: 'Магазин / Межкомнатные двери',       type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/avtomaticheskie-cepi-i-parkovochnye-sistemy.html`, articlePrefix: '/avtomaticheskie-cepi-i-parkovochnye-sistemy/', section: 'Магазин / Парковочные системы', type: 'news', listType: 'catalog2', filterInstructions: true },
  { listUrl: `${BASE}/solncezashhita.html`,            articlePrefix: '/solncezashhita/',            section: 'Магазин / Солнцезащита',             type: 'news', listType: 'catalog2', filterInstructions: true },
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

// Картинки, шрифты, видео и CSS не нужны ни для извлечения ссылок из списков, ни
// для чтения текста статьи (нужную фотографию товара мы потом скачиваем отдельным
// целевым fetch() — у него другой resourceType, эта блокировка его не затронет).
// Для сайта с десятками фото на странице категории это основной потребитель
// CPU/трафика headless-браузера — блокировка ощутимо снижает нагрузку.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

// Сервер — 1 vCPU / 1 ГБ RAM. --single-process тут не годится: под нагрузкой
// headless_shell роняет весь браузер целиком ("Target ... has been closed"),
// а не отдельную вкладку — проверено на проде 2026-07-07, отовсюду шли крэши.
// --disable-dev-shm-usage не даёт Chromium упасть из-за маленького /dev/shm.
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
];

// Раздел каталога — это 300-500 товаров в DOM за раз; на одной и той же
// странице без пересоздания это копится за весь прогон и на 1 ГБ RAM без
// свопа гоняет Chromium к OOM-килу хоста. Пересоздаём page раз в столько
// разделов, чтобы Chromium периодически освобождал накопленное.
const PAGE_RECYCLE_EVERY_SECTIONS = 5;

async function blockHeavyResources(context) {
  await context.route('**/*', (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
}

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
// Один catalog2-раздел может содержать по 15-20+ подкатегорий (например,
// "Ворота откатные (каталог)" — 492 товара суммарно). Все они обходятся одной
// и той же вкладкой без пересоздания — Chromium не освобождает память между
// навигациями полностью, и на 1 ГБ RAM это копится быстрее, чем успевает
// почиститься recycle "раз в 5 разделов" в getNewArticles (см. зависания
// 2026-07-07/08 — оба произошли посреди catalog2-раздела). Пересоздаём вкладку
// каждые несколько подкатегорий прямо внутри обхода, а не только между
// разделами — состав и порядок найденных товаров при этом не меняется.
const CATALOG_PAGE_RECYCLE_EVERY_SUBCATS = 4;

async function scrapeCatalogList(pageHolder, context, section) {
  const subcats = await extractLinksAtDepth(pageHolder.page, section.articlePrefix, 2, SHOP_EXCLUDE_URL_PARTS);
  const products = [];
  const seen = new Set();

  for (const [i, sub] of subcats.entries()) {
    if (i > 0 && i % CATALOG_PAGE_RECYCLE_EVERY_SUBCATS === 0) {
      await pageHolder.page.close();
      pageHolder.page = await context.newPage();
    }

    const sortedUrl = `${sub.url}?sortby=new`;
    try {
      const res = await pageHolder.page.goto(sortedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!res || res.status() >= 400) {
        logger.warn(`Страница недоступна: ${sortedUrl} (HTTP ${res?.status()})`);
        continue;
      }
      await pageHolder.page.waitForTimeout(1000);
    } catch (e) {
      logger.warn(`Не удалось открыть ${sortedUrl}: ${e.message}`);
      continue;
    }

    const items = await extractLinksAtDepth(pageHolder.page, section.articlePrefix, 3, SHOP_EXCLUDE_URL_PARTS, `${MAIN_CONTENT_SELECTOR} .cont-items`);
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

async function scrapeList(pageHolder, context, section) {
  try {
    const res = await pageHolder.page.goto(section.listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || res.status() >= 400) {
      logger.warn(`Страница недоступна: ${section.listUrl} (HTTP ${res?.status()})`);
      return [];
    }
    await pageHolder.page.waitForTimeout(1500);
  } catch (e) {
    logger.warn(`Не удалось открыть ${section.listUrl}: ${e.message}`);
    return [];
  }

  if (section.listType === 'catalog2') {
    return scrapeCatalogList(pageHolder, context, section);
  }
  if (section.listType === 'shop') {
    return scrapeShopList(pageHolder.page, section);
  }
  return scrapeNewsList(pageHolder.page, section);
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
     '.leftcol','.sidebar','.col-basket','.toppart',
     '.shownow', '.as_rest_no',
     // бейджи и таймер обратного отсчёта поверх фото товара (внутри .tov,
     // которую целиком убрать нельзя — там же и само фото)
     '.tov .actions', '.tov .actions2', '.tov .BckTm', '.tov .BckTmLabel'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const h1 = document.querySelector('h1')?.textContent?.trim() || '';

    // Контент в .mainpole_nomain_page
    const contentEl = document.querySelector('.mainpole_nomain_page, .colspan4');
    let text = '';
    if (contentEl) {
      // Убираем форму обратной связи и заголовок (h1 уже сохранён в переменную
      // выше, здесь он лишний — иначе название товара дублируется в начале текста)
      contentEl.querySelectorAll('form, article, h1').forEach(el => el.remove());
      // .tovar_about h2 целиком дублирует название товара (с префиксом бренда)
      // и добавляет "голый" код товара без подписи — сам код есть отдельно
      // в характеристиках как "Артикул: ...", поэтому убираем весь заголовок
      contentEl.querySelectorAll('.tovar_about h2').forEach(h2 => h2.remove());
      text = contentEl.textContent?.replace(/\s+/g, ' ').trim() || '';
      // Подпись под фото товара ("для увеличениякликните по изображению") —
      // склеена без пробела прямо в html сайта, не выделена отдельным тегом,
      // поэтому убираем её строкой, а не через querySelector
      text = text.replace(/для увеличения\s*кликните по изображению/gi, '').replace(/\s+/g, ' ').trim();
      // Остаток склада ("на складе 3 шт") тоже приклеен прямым текстом перед
      // описанием товара, без отдельного тега — убираем строкой же
      text = text.replace(/на складе\s*\d+\s*шт\.?/gi, '').replace(/нет на складе/gi, '').replace(/\s+/g, ' ').trim();
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
        const resp = await fetch(imgUrl, { credentials: 'include', signal: AbortSignal.timeout(30000) });
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

// ─── Стоп-лист статей, которые не удаётся спарсить ───────────────────────────

// Статья, парсинг которой упёрся в таймаут/ошибку: пробуем ещё раз в том же
// прогоне (scrapeArticleWithRetry), и если снова не вышло — откладываем в этот
// файл вместо того, чтобы просто промолчать. Так как непропарсенная статья не
// попадает в основную базу (db.exists остаётся false), на следующем прогоне
// она снова найдётся в списке как "новая" — тогда видим, что URL уже в
// стоп-листе, и это её вторая попытка. Если и она проваливается — сдаёмся:
// удаляем из стоп-листа и помечаем в основной базе как scrapeFailed, чтобы
// не пытаться бесконечно и не публиковать наполовину (без текста/фото).
const STOP_LIST_FILE = path.join(__dirname, '../../data/stop-list.json');

function loadStopList() {
  try {
    return JSON.parse(fs.readFileSync(STOP_LIST_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function persistStopList(list) {
  fs.mkdirSync(path.dirname(STOP_LIST_FILE), { recursive: true });
  const json = JSON.stringify(list, null, 2);
  const tmp = STOP_LIST_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, STOP_LIST_FILE);
  } catch (_) {
    fs.writeFileSync(STOP_LIST_FILE, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch (__) {}
  }
}

// Один повтор сразу же в этом прогоне, если первая попытка не удалась
// (таймаут, страница недоступна и т.п.)
async function scrapeArticleWithRetry(page, url) {
  const first = await scrapeArticle(page, url);
  if (first) return first;
  logger.warn(`  Повтор парсинга: ${url}`);
  await page.waitForTimeout(2000);
  return scrapeArticle(page, url);
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

  // Проверяем несколько подпунктов, а не только первый — раздел может быть смешанным
  // (часть подпунктов ведёт прямо на товар, часть — на подкатегорию с товарами внутри);
  // достаточно, чтобы вложенность нашлась хотя бы у одного
  for (const item of level2.slice(0, 3)) {
    try {
      await page.goto(`${item.url}?sortby=new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
    } catch (_) {
      continue;
    }
    const level3 = await extractLinksAtDepth(page, articlePrefix, 3, SHOP_EXCLUDE_URL_PARTS, `${MAIN_CONTENT_SELECTOR} .cont-items`);
    if (level3.length > 0) return 'catalog2';
  }
  return 'shop';
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

// ─── Периодическая самопроверка типа обхода уже известных разделов ───────────

// discoverSections ловит только совсем новые пункты меню "Магазин". Но раздел,
// который уже сидит в SECTIONS как плоский 'shop', может со временем обзавестись
// вложенными подкатегориями (именно так тихо сломались 7 разделов: Радиоуправление,
// Аксессуары, Замки/доводчики, Источники питания, Межкомнатные двери, Парковочные
// системы, Солнцезащита — на сайте появилась вложенность, а конфиг остался старым).
// Раз в сутки повторно определяем реальный тип для каждого известного раздела и,
// если он разошёлся с настройкой в коде, используем реальный автоматически (в коде
// всё равно нужно поправить вручную — иначе после рестарта проверка снова начнётся
// со старого значения).
//
// Важно: смена типа обхода раздела — это не "на сайте появились новые товары",
// а "мы наконец увидели то, что там уже было". Поэтому при смене эффективного типа
// для уже "заселённого" раздела все обнаруженные вложенные товары один раз тихо
// заносятся в базу (как при первом обнаружении раздела), а не публикуются разом —
// иначе в канал улетит лавина из сотен "новых" товаров, которые на самом деле
// просто раньше не обходились из-за неверного типа.
const SECTION_TYPES_FILE = path.join(__dirname, '../../data/section-types.json');
const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function loadSectionTypesState() {
  try {
    return JSON.parse(fs.readFileSync(SECTION_TYPES_FILE, 'utf8'));
  } catch (_) {
    return { appliedListType: {}, lastValidatedAt: null };
  }
}

function persistSectionTypesState(state) {
  fs.mkdirSync(path.dirname(SECTION_TYPES_FILE), { recursive: true });
  const json = JSON.stringify(state, null, 2);
  const tmp = SECTION_TYPES_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, SECTION_TYPES_FILE);
  } catch (_) {
    // OneDrive блокирует rename на Windows — пишем напрямую
    fs.writeFileSync(SECTION_TYPES_FILE, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch (__) {}
  }
}

// Загружает состояние один раз на весь прогон и раз в сутки сверяет реальную
// структуру каждого известного раздела с тем, что зашито в SECTIONS — на время
// этого прогона (в памяти) переключает listType на реальный, если он разошёлся,
// плюс шлёт уведомление, чтобы поправить код.
async function loadAndRevalidateSectionTypes(page, sections) {
  const state = loadSectionTypesState();
  state.appliedListType = state.appliedListType || {};

  const now = Date.now();
  const due = !state.lastValidatedAt || now - new Date(state.lastValidatedAt).getTime() >= REVALIDATE_INTERVAL_MS;
  if (!due) return state;

  for (const section of sections) {
    // detectListType различает только 'shop' (глубина 2) и 'catalog2' (глубина 3) —
    // разделы новостей/акций ('news') устроены и парсятся принципиально иначе
    // (scrapeNewsList, блоки .news_prods с датой и картинкой), сверять их с этой
    // проверкой бессмысленно и опасно: она бы молча подменила им тип на 'shop'
    if (section.listType !== 'shop' && section.listType !== 'catalog2') continue;

    const actualType = await detectListType(page, section.listUrl, section.articlePrefix);
    if (!actualType || actualType === section.listType) continue;

    await logger.infoNotify(
      `Раздел «${section.section}» изменил структуру на сайте: в коде указано "${section.listType}", ` +
      `по факту "${actualType}" — до правки кода использую фактический тип автоматически`
    );
    section.listType = actualType;
  }

  state.lastValidatedAt = new Date().toISOString();
  persistSectionTypesState(state);
  return state;
}

// 2026-07-07: у этих 7 разделов listType был неверно указан как 'shop' и только что
// исправлен на 'catalog2' (см. комментарий выше) — на сервере, где база уже
// заполнена под старым (неверным) типом, а section-types.json ещё не существует,
// это единственный способ узнать, что раньше тип был другим, не разослав разом
// сотни "новых" товаров. Раздел, которого здесь нет, при отсутствии записи в
// state.appliedListType по умолчанию считается не нуждающимся в ресинке —
// это верно для всех остальных разделов, которые всегда обходились правильно.
const LEGACY_TYPE_FIXES = {
  [`${BASE}/radioupravlenie.html`]: 'shop',
  [`${BASE}/aksessuary.html`]: 'shop',
  [`${BASE}/zamki-dovodchiki.html`]: 'shop',
  [`${BASE}/istochniki-pitaniya.html`]: 'shop',
  [`${BASE}/mezhkomnatnye-dveri.html`]: 'shop',
  [`${BASE}/avtomaticheskie-cepi-i-parkovochnye-sistemy.html`]: 'shop',
  [`${BASE}/solncezashhita.html`]: 'shop',
};

function getAppliedListType(state, section) {
  const recorded = state.appliedListType[section.listUrl];
  if (recorded !== undefined) return recorded;
  return LEGACY_TYPE_FIXES[section.listUrl] ?? section.listType;
}

// Раздел, чей эффективный listType разошёлся с тем, под которым он в прошлый раз
// был полностью пройден, нужно один раз тихо донабрать в базу, а не публиковать
// найденное как новые статьи.
function needsSilentResync(state, section) {
  return getAppliedListType(state, section) !== section.listType;
}

function markSectionTypeApplied(state, section) {
  if (state.appliedListType[section.listUrl] === section.listType) return;
  state.appliedListType[section.listUrl] = section.listType;
  persistSectionTypesState(state);
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
  const stopList = loadStopList();

  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  await blockHeavyResources(context);
  // Объект-обёртка вместо голой переменной — scrapeCatalogList пересоздаёт
  // вкладку прямо во время обхода подкатегорий (см. CATALOG_PAGE_RECYCLE_EVERY_SUBCATS)
  // и обновляет pageHolder.page, чтобы дальнейший код в этом цикле подхватил
  // актуальную вкладку, а не хранил ссылку на уже закрытую.
  const pageHolder = { page: await context.newPage() };
  const newArticles = [];

  if (isFirstRun) {
    logger.info('Первый запуск — заполняем базу, переходим в режим мониторинга');
  }

  try {
    const knownListUrls = new Set(SECTIONS.map((s) => s.listUrl));
    const discovered = await discoverSections(pageHolder.page, knownListUrls);
    const sections = [...SECTIONS, ...discovered];

    const typesState = await loadAndRevalidateSectionTypes(pageHolder.page, sections);

    for (const [sectionIndex, section] of sections.entries()) {
      if (sectionIndex > 0 && sectionIndex % PAGE_RECYCLE_EVERY_SECTIONS === 0) {
        await pageHolder.page.close();
        pageHolder.page = await context.newPage();
      }

      // Раздел уже виделся раньше, но проходился под другим listType (например,
      // только что исправленным вручную или переключённым автопроверкой выше) —
      // на этот раз тихо заносим найденное в базу, а не публикуем разом
      const resyncing = isSectionSeeded(existingArticles, section) && needsSilentResync(typesState, section);
      const sectionSeeded = isSectionSeeded(existingArticles, section) && !resyncing;

      if (section.autoDiscovered && !sectionSeeded && !resyncing) {
        await logger.infoNotify(`Обнаружен новый раздел на сайте: «${section.section}» (${section.listUrl}) — добавлен в мониторинг автоматически, база заполняется без публикации`);
      }
      if (resyncing) {
        logger.info(`Раздел «${section.section}» пройден заново с исправленным типом обхода — донабираем базу без публикации`);
      }

      logger.info(`Проверяем: ${section.section} (${section.listUrl})${sectionSeeded ? '' : ' — новый раздел, заполняем базу'}`);

      const listings = await scrapeList(pageHolder, context, section);
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
        const wasInStopList = !!stopList[item.url];
        const full = await scrapeArticleWithRetry(pageHolder.page, item.url);

        if (!full) {
          if (wasInStopList) {
            logger.warn(`  ⛔ Второй прогон подряд не спарсилась — сдаюсь, убираю из стоп-листа: ${item.title}`);
            delete stopList[item.url];
            persistStopList(stopList);
            db.markScrapeFailed({
              url:         item.url,
              title:       item.title,
              section:     section.section,
              articleType: section.type,
              publishedAt: toIsoDate(item.date),
            });
            await logger.errorNotify(`Не удалось спарсить статью после 2 прогонов, публикация пропущена: «${item.title}»\n${item.url}`);
          } else {
            logger.warn(`  ⏳ Не спарсилась — откладываю в стоп-лист до следующего прогона: ${item.title}`);
            stopList[item.url] = { title: item.title, firstFailedAt: new Date().toISOString() };
            persistStopList(stopList);
          }
          continue;
        }

        if (wasInStopList) {
          delete stopList[item.url];
          persistStopList(stopList);
        }

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

        await pageHolder.page.waitForTimeout(1000);
      }

      markSectionTypeApplied(typesState, section);
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
    args: CHROMIUM_ARGS,
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  await blockHeavyResources(context);
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
    args: CHROMIUM_ARGS,
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  await blockHeavyResources(context);
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
