const { chromium } = require('playwright');
const BASE = 'https://www.bramy.ru';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`${BASE}/news/kak-snyat-rolstavni.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    // Убираем шапку/подвал/навигацию/сайдбар
    ['header','footer','nav','.sidebar','script','style',
     '.bramy-mobile-header-wrap', '.bramy-nav', '.bramy-mobile-nav-wrap',
     '.leftcol', '.menu-nav', '.menu-top', 'article form'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    // Ищем .mainpole_nomain_page
    const main = document.querySelector('.mainpole_nomain_page');
    const mainLen = main ? main.textContent.trim().length : 0;

    // Ищем rightcol
    const right = document.querySelector('.rightcol, .right-col, .rightcol2');
    const rightLen = right ? right.textContent.trim().length : 0;

    // Ищем colspan4
    const colspan = document.querySelector('.colspan4');
    const colspanLen = colspan ? colspan.textContent.trim().length : 0;

    // Ищем mainpole
    const mainpole = document.querySelector('[class*="mainpole"]');

    // Все картинки на странице
    const imgs = [...document.querySelectorAll('img[src]')]
      .map(i => i.src)
      .filter(s => s.includes('/our_photo/') || s.includes('/images/') || s.includes('/img/'))
      .filter(s => !s.includes('icon') && !s.includes('logo') && !s.includes('basket'))
      .slice(0, 10);

    // Ищем блоки непосредственно содержащие статью (меньше навигации)
    const candidates = [];
    document.querySelectorAll('div[class]').forEach(el => {
      const text = el.textContent?.trim().replace(/\s+/g, ' ') || '';
      if (text.length > 500 && text.length < 15000 && el.children.length < 30) {
        // Проверяем что это не nav
        const hasLinks = el.querySelectorAll('a').length;
        const hasText = text.match(/[а-яА-Я]{10,}/g)?.length || 0;
        if (hasText > 3 && hasLinks < 20) {
          candidates.push({
            cls: el.className.slice(0, 50),
            len: text.length,
            links: hasLinks,
            preview: text.slice(0, 150)
          });
        }
      }
    });

    return {
      mainLen, rightLen, colspanLen,
      mainpoleClass: mainpole?.className,
      mainpoleLen: mainpole?.textContent?.trim()?.length,
      mainpolePreview: mainpole?.textContent?.trim()?.slice(0, 300),
      imgs,
      candidates: candidates.sort((a,b) => a.links - b.links).slice(0, 8)
    };
  });

  console.log('mainpole_nomain_page len:', info.mainLen);
  console.log('rightcol len:', info.rightLen);
  console.log('colspan4 len:', info.colspanLen);
  console.log('mainpole class:', info.mainpoleClass, '| len:', info.mainpoleLen);
  console.log('mainpole preview:', info.mainpolePreview);
  console.log('\nКартинки:', info.imgs);
  console.log('\nКандидаты на блок контента:');
  info.candidates.forEach(c => console.log(`  [len=${c.len} links=${c.links}] .${c.cls}: ${c.preview}`));

  await browser.close();
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
