// Разовая авторизация ОК: получить ссылку, открыть её под аккаунтом-админом
// группы, а полученный code передать сюда вторым запуском.
//
//   node ok-auth.js            — печатает ссылку для входа
//   node ok-auth.js <code>     — обменивает code на access/refresh_token
//
// Тот же обмен доступен прямо в Telegram-боте (кнопка "🔗 Перелогиниться в
// ОК") — этот скрипт нужен, только если удобнее сделать это из терминала.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs     = require('fs');
const path   = require('path');
const config = require('./src/config');
const { buildAuthorizeUrl, exchangeCodeForTokens } = require('./src/ok');

const TOKEN_FILE = config.ok.tokenPath;

async function main() {
  const code = process.argv[2];

  if (!code) {
    console.log('1) Открой эту ссылку в браузере под аккаунтом, который админ группы:\n');
    console.log(buildAuthorizeUrl());
    console.log('\n2) После подтверждения браузер перейдёт на');
    console.log(`   ${config.ok.redirectUri}?code=...`);
    console.log('   (страница не обязана существовать — code просто появится в адресной строке)');
    console.log('\n3) Скопируй значение code (оно живёт 2 минуты!) и запусти:\n');
    console.log('   node ok-auth.js <code>\n');
    return;
  }

  const tokens = await exchangeCodeForTokens(code);
  const state = {
    ...tokens,
    refreshTokenIssuedAt: new Date().toISOString(),
    lastWarnedAt:         null,
  };

  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(state, null, 2), 'utf8');

  console.log('Готово! Токены сохранены в', TOKEN_FILE);
  console.log('refresh_token действует 30 суток — дальше парсер обновляет access_token сам.');
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
