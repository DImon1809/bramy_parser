// Разовая авторизация Pinterest: получить ссылку, открыть её под аккаунтом,
// у которого есть доступ к нужной доске, а полученный code передать сюда
// вторым запуском.
//
//   node pinterest-auth.js            — печатает ссылку для входа
//   node pinterest-auth.js <code>     — обменивает code на access/refresh_token
//
// Тот же обмен доступен прямо в Telegram-боте (кнопка "🔗 Перелогиниться в
// Pinterest") — этот скрипт нужен, только если удобнее сделать это из терминала.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs     = require('fs');
const path   = require('path');
const config = require('./src/config');
const { buildAuthorizeUrl, exchangeCodeForTokens, verifyPinterestAccess } = require('./src/pinterest');

const TOKEN_FILE = config.pinterest.tokenPath;

async function main() {
  const code = process.argv[2];

  if (!code) {
    console.log('1) Открой эту ссылку в браузере под аккаунтом, у которого есть доступ к нужной доске:\n');
    console.log(buildAuthorizeUrl());
    console.log('\n2) После подтверждения браузер перейдёт на');
    console.log(`   ${config.pinterest.redirectUri}?code=...`);
    console.log('   (страница не обязана существовать — code просто появится в адресной строке)');
    console.log('\n3) Скопируй значение code и запусти:\n');
    console.log('   node pinterest-auth.js <code>\n');
    return;
  }

  const tokens = await exchangeCodeForTokens(code);

  console.log('Проверяю доступ к доске...');
  await verifyPinterestAccess(tokens.accessToken);

  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');

  console.log('Готово! Токены сохранены в', TOKEN_FILE);
  console.log('access_token обновляется автоматически через refresh_token — дальше парсер делает это сам.');
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
