// Тест парсера: показывает что будет найдено без реальной публикации
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const db = require('./src/database');
const { getNewArticles } = require('./src/scraper');

(async () => {
  console.log('Запускаем тестовый прогон парсера...\n');

  const articles = await getNewArticles(db);

  if (articles.length === 0) {
    console.log('Новых статей не найдено (или все уже в базе).');
  } else {
    console.log(`Найдено новых статей: ${articles.length}\n`);
    articles.forEach((a, i) => {
      console.log(`--- ${i+1}. ${a.title}`);
      console.log(`    Секция:  ${a.section}`);
      console.log(`    Дата:    ${a.publishedAt}`);
      console.log(`    URL:     ${a.url}`);
      console.log(`    Картинка: ${a.imageUrl || 'нет'}`);
      console.log(`    Текст (первые 200 символов): ${a.text.slice(0, 200).replace(/\s+/g,' ')}...`);
      console.log();
    });
  }

  // Показываем состояние базы
  const all = db.all();
  console.log(`\nВсего в базе данных: ${all.length} записей`);
  console.log('(старые статьи без свежих дат сохранены в БД но НЕ опубликованы)');
})().catch(e => {
  console.error('ОШИБКА:', e.message);
  process.exit(1);
});
