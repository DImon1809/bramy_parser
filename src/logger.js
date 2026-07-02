const winston = require('winston');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.log.path), { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase()}: ${message}`,
  ),
);

const logger = winston.createLogger({
  level: 'info',
  format: fmt,
  transports: [
    new winston.transports.File({
      filename: config.log.path,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize({ all: true }), fmt),
    }),
  ],
});

async function notifyAdmin(text) {
  if (!config.tg.botToken || !config.tg.adminIds?.length) return;
  for (const adminId of config.tg.adminIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${config.tg.botToken}/sendMessage`, {
        chat_id: adminId,
        text:    `Bramy Parser:\n${text}`,
      });
    } catch (e) {
      const detail = e.response?.data?.description || e.message;
      console.error(`[notifyAdmin] Не удалось отправить уведомление (${adminId}): ${detail}`);
    }
  }
}

// Уведомляет администратора только об ошибках публикации
logger.errorNotify = async (message, err) => {
  const full = err ? `${message}: ${err.message || err}` : message;
  logger.error(full);
  await notifyAdmin(`🚨 ${full}`);
};

module.exports = logger;
