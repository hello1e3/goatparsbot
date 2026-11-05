// Бот продаж GOAT Parser: оплата звёздами Telegram, переводом на карту и криптовалютой.
// Без сторонних библиотек: Node.js 20+ (fetch), Bot API через long polling.
// Настройки — в .env рядом с этим файлом (см. .env.example). Данные — в data/db.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- настройки

function loadEnv() {
  const file = path.join(dir, '.env');
  const env = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  // на хостинге настройки приходят переменными окружения — они важнее файла
  for (const [k, v] of Object.entries(process.env)) if (/^(BOT_TOKEN|ADMIN_|PRODUCT_|PRICE_|CRYPTO_|CARD_|DOWNLOAD_URL|SUPPORT_CONTACT)/.test(k) && v) env[k] = v;
  return env;
}

const env = loadEnv();
const cfg = {
  token: env.BOT_TOKEN,
  adminCode: env.ADMIN_CODE ?? '',
  product: env.PRODUCT_NAME || 'GOAT Parser',
  description: env.PRODUCT_DESCRIPTION || 'Программа для Windows: находит бизнес без сайта, готовит промпт для нейросети и собирает демо-лендинг.',
  priceStars: Number(env.PRICE_STARS) || 0,
  priceRub: Number(env.PRICE_RUB) || 0,
  priceCrypto: Number(env.PRICE_CRYPTO) || 0,
  cryptoAsset: env.CRYPTO_ASSET || 'USDT',
  cardNumber: env.CARD_NUMBER ?? '',
  cardHolder: env.CARD_HOLDER ?? '',
  cardBank: env.CARD_BANK ?? '',
  cryptoPayToken: env.CRYPTO_PAY_TOKEN ?? '',
  cryptoPayTestnet: env.CRYPTO_PAY_TESTNET === '1',
  cryptoWallet: env.CRYPTO_WALLET ?? '',
  cryptoNetwork: env.CRYPTO_NETWORK || 'TRC20',
  downloadUrl: env.DOWNLOAD_URL ?? '',
  support: env.SUPPORT_CONTACT || '',
};
if (!cfg.token) {
  console.error('Нет BOT_TOKEN в bot/.env');
  process.exit(1);
}

// ---------------------------------------------------------------- хранилище

const dataDir = path.join(dir, 'data');
const dbFile = path.join(dataDir, 'db.json');
mkdirSync(dataDir, { recursive: true });
/** @type {{ adminId: number|null, fileId: string|null, fileName: string|null, nextId: number, orders: Record<string, any>, buyers: Record<string, string> }} */
const db = existsSync(dbFile)
  ? JSON.parse(readFileSync(dbFile, 'utf8'))
  : { adminId: null, fileId: null, fileName: null, nextId: 1, orders: {}, buyers: {} };
function save() {
  // запись через временный файл: при сбое база не повредится
  writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
  renameSync(dbFile + '.tmp', dbFile);
}
// на хостинге data/db.json пропадает при пересборке — администратор и файл могут приходить из настроек
if (!db.adminId && env.ADMIN_ID) db.adminId = Number(env.ADMIN_ID);
if (!db.fileId && env.FILE_ID) db.fileId = env.FILE_ID;

/** Состояние диалога (ждём чек или файл) — только в памяти. */
const waiting = new Map(); // chatId → { kind: 'proof', orderId } | { kind: 'file' }

// ---------------------------------------------------------------- Bot API

async function api(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const send = (chatId, text, extra = {}) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const who = (u) => (u.username ? `@${u.username}` : esc([u.first_name, u.last_name].filter(Boolean).join(' '))) + ` (id ${u.id})`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- Crypto Pay (@CryptoBot)

const cryptoBase = cfg.cryptoPayTestnet ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
async function crypto(method, params = {}) {
  const res = await fetch(`${cryptoBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': cfg.cryptoPayToken },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`CryptoPay ${method}: ${JSON.stringify(data.error ?? data)}`);
  return data.result;
}

// ---------------------------------------------------------------- заказы

function newOrder(user, method, amount, currency) {
  const id = String(db.nextId++);
  db.orders[id] = { id, userId: user.id, chatId: user.id, user: who(user), method, amount, currency, status: 'pending', createdAt: new Date().toISOString() };
  save();
  return db.orders[id];
}

const methods = () => [
  cfg.priceStars > 0 && { id: 'stars', label: `⭐ Звёздами — ${cfg.priceStars} ⭐` },
  cfg.priceRub > 0 && cfg.cardNumber && { id: 'card', label: `💳 Картой — ${rub(cfg.priceRub)}` },
  cfg.priceCrypto > 0 && (cfg.cryptoPayToken || cfg.cryptoWallet) && { id: 'crypto', label: `🪙 Криптой — ${cfg.priceCrypto} ${cfg.cryptoAsset}` },
].filter(Boolean);

async function deliver(order) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  db.buyers[order.userId] = order.id;
  save();
  log('Оплачен заказ', order.id, order.method, order.amount, order.currency, order.user);
  await send(order.chatId, `✅ Оплата получена, спасибо!\n\nВаш заказ №${order.id}. Ниже — установщик <b>${esc(cfg.product)}</b>.`);
  await sendProduct(order.chatId);
  if (db.adminId) await send(db.adminId, `💰 Продажа №${order.id}: ${order.amount} ${order.currency} (${order.method}) — ${order.user}`).catch(() => {});
}

async function sendProduct(chatId) {
  if (db.fileId) {
    await api('sendDocument', { chat_id: chatId, document: db.fileId, caption: `${cfg.product} — запустите установщик и следуйте подсказкам.` });
  } else if (cfg.downloadUrl) {
    await send(chatId, `Скачать: ${esc(cfg.downloadUrl)}`);
  } else {
    await send(chatId, 'Файл скоро пришлём — продавец уже получил уведомление.');
    if (db.adminId) await send(db.adminId, `⚠ Покупатель (chat ${chatId}) оплатил, но файл не задан. Отправьте /setfile и пришлите установщик, потом /resend ${chatId}.`).catch(() => {});
  }
}

// ---------------------------------------------------------------- экраны

async function showStart(chatId) {
  if (db.buyers[chatId]) {
    return send(chatId, `Вы уже купили <b>${esc(cfg.product)}</b> (заказ №${db.buyers[chatId]}).`, kb([[{ text: '⬇ Скачать ещё раз', callback_data: 'again' }], ...(cfg.support ? [[{ text: '❓ Поддержка', callback_data: 'support' }]] : [])]));
  }
  const list = methods();
  const text = `<b>${esc(cfg.product)}</b>\n\n${esc(cfg.description)}\n\n` +
    (list.length ? 'Выберите способ оплаты — после оплаты бот сразу пришлёт установщик:' : 'Продажи скоро откроются.');
  return send(chatId, text, kb([...list.map((m) => [{ text: m.label, callback_data: `buy:${m.id}` }]), ...(cfg.support ? [[{ text: '❓ Поддержка', callback_data: 'support' }]] : [])]));
}

async function buyStars(user) {
  const order = newOrder(user, 'stars', cfg.priceStars, 'XTR');
  await api('sendInvoice', {
    chat_id: user.id,
    title: cfg.product,
    description: cfg.description.slice(0, 255),
    payload: `order:${order.id}`,
    currency: 'XTR',
    prices: [{ label: cfg.product, amount: cfg.priceStars }],
  });
}

async function buyCard(user) {
  const order = newOrder(user, 'card', cfg.priceRub, 'RUB');
  const lines = [
    `💳 <b>Оплата картой — заказ №${order.id}</b>`,
    '',
    `Переведите <b>${rub(cfg.priceRub)}</b> на карту:`,
    `<code>${esc(cfg.cardNumber)}</code>`,
    cfg.cardHolder ? `Получатель: ${esc(cfg.cardHolder)}` : null,
    cfg.cardBank ? `Банк: ${esc(cfg.cardBank)}` : null,
    '',
    'После перевода нажмите «Я оплатил» и пришлите скриншот чека. Продавец проверит оплату и бот пришлёт установщик.',
  ].filter((x) => x !== null);
  await send(user.id, lines.join('\n'), kb([[{ text: '✅ Я оплатил', callback_data: `paid:${order.id}` }], [{ text: 'Отмена', callback_data: `cancel:${order.id}` }]]));
}

async function buyCrypto(user) {
  if (cfg.cryptoPayToken) {
    const order = newOrder(user, 'crypto', cfg.priceCrypto, cfg.cryptoAsset);
    const inv = await crypto('createInvoice', {
      currency_type: 'crypto',
      asset: cfg.cryptoAsset,
      amount: String(cfg.priceCrypto),
      description: `${cfg.product} — заказ №${order.id}`,
      payload: order.id,
      expires_in: 3600,
    });
    order.invoiceId = inv.invoice_id;
    save();
    const url = inv.bot_invoice_url ?? inv.pay_url;
    return send(user.id, `🪙 <b>Оплата криптой — заказ №${order.id}</b>\n\nСчёт на ${cfg.priceCrypto} ${cfg.cryptoAsset} в @CryptoBot действует 1 час. После оплаты бот сам пришлёт установщик.`, kb([[{ text: `Оплатить ${cfg.priceCrypto} ${cfg.cryptoAsset}`, url }]]));
  }
  // без Crypto Pay — перевод на кошелёк с ручной проверкой, как с картой
  const order = newOrder(user, 'crypto', cfg.priceCrypto, cfg.cryptoAsset);
  await send(user.id, [
    `🪙 <b>Оплата криптой — заказ №${order.id}</b>`,
    '',
    `Переведите <b>${cfg.priceCrypto} ${esc(cfg.cryptoAsset)}</b> (сеть ${esc(cfg.cryptoNetwork)}) на адрес:`,
    `<code>${esc(cfg.cryptoWallet)}</code>`,
    '',
    'После перевода нажмите «Я оплатил» и пришлите скриншот или хэш транзакции.',
  ].join('\n'), kb([[{ text: '✅ Я оплатил', callback_data: `paid:${order.id}` }], [{ text: 'Отмена', callback_data: `cancel:${order.id}` }]]));
}

/** Чек от покупателя → продавцу с кнопками «Подтвердить / Отклонить». */
async function forwardProof(msg, order) {
  if (!db.adminId) {
    await send(msg.chat.id, 'Чек получен. Продавец проверит оплату и бот пришлёт установщик.');
    log('⚠ Чек по заказу', order.id, 'пришёл, но администратор не назначен (/admin КОД)');
    return;
  }
  order.status = 'review';
  save();
  await api('copyMessage', { chat_id: db.adminId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  await send(db.adminId, `🧾 Чек по заказу №${order.id}: ${order.amount} ${order.currency} (${order.method === 'card' ? 'карта' : 'крипта'}) от ${order.user}`,
    kb([[{ text: '✅ Подтвердить', callback_data: `ok:${order.id}` }, { text: '❌ Отклонить', callback_data: `no:${order.id}` }]]));
  await send(msg.chat.id, 'Чек отправлен продавцу. Как только оплата подтвердится, бот пришлёт установщик.');
}

// ---------------------------------------------------------------- обработка апдейтов

const isAdmin = (id) => db.adminId === id;

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ?? '';
  const user = msg.from;
  if (msg.chat.type !== 'private') return;

  // оплата звёздами прошла
  if (msg.successful_payment) {
    const p = msg.successful_payment;
    const order = db.orders[p.invoice_payload.replace('order:', '')];
    if (order) {
      order.chargeId = p.telegram_payment_charge_id;
      await deliver(order);
    }
    return;
  }

  const w = waiting.get(chatId);
  // администратор присылает установщик после /setfile
  if (w?.kind === 'file' && isAdmin(user.id) && msg.document) {
    db.fileId = msg.document.file_id;
    db.fileName = msg.document.file_name ?? null;
    save();
    waiting.delete(chatId);
    return send(chatId, `Файл сохранён: ${esc(db.fileName ?? 'документ')}. Покупатели будут получать его после оплаты.\n\nЕсли бот на хостинге, добавьте в его переменные окружения, чтобы файл не терялся при перезапуске:\n<code>FILE_ID=${esc(db.fileId)}</code>`);
  }
  // покупатель присылает чек
  if (w?.kind === 'proof' && (msg.photo || msg.document || text)) {
    const order = db.orders[w.orderId];
    waiting.delete(chatId);
    if (order && order.status === 'pending') return forwardProof(msg, order);
  }

  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd?.replace(/@\w+$/, '')) {
    case '/start':
      return showStart(chatId);
    case '/admin':
      if (db.adminId && !isAdmin(user.id)) return send(chatId, 'Администратор уже назначен.');
      if (!cfg.adminCode || args[0] !== cfg.adminCode) return send(chatId, 'Неверный код.');
      db.adminId = user.id;
      save();
      return send(chatId, '👑 Вы администратор бота.\n\n/setfile — загрузить установщик\n/stats — продажи\n/resend ID — отправить файл покупателю\n/refund НОМЕР — вернуть звёзды по заказу');
    case '/paysupport':
    case '/support':
      return send(chatId, cfg.support ? `По вопросам оплаты и возврата: ${esc(cfg.support)}` : 'Напишите сюда, продавец ответит.');
    case '/terms':
      return send(chatId, `После оплаты вы получаете установщик ${esc(cfg.product)} для Windows. Цифровой товар выдаётся сразу; если файл не пришёл или не запускается — напишите в /paysupport.`);
  }

  if (isAdmin(user.id)) {
    switch (cmd) {
      case '/setfile':
        waiting.set(chatId, { kind: 'file' });
        return send(chatId, 'Пришлите установщик одним файлом (как документ). Размер не ограничен — Telegram хранит его у себя.');
      case '/stats': {
        const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
        const sum = (m) => paid.filter((o) => o.method === m).reduce((a, o) => a + o.amount, 0);
        return send(chatId, [
          `Продаж: ${paid.length}`,
          `⭐ Звёзды: ${sum('stars')} ⭐`,
          `💳 Карта: ${rub(sum('card'))}`,
          `🪙 Крипта: ${sum('crypto')} ${cfg.cryptoAsset}`,
          `Файл: ${db.fileName ?? (db.fileId ? 'задан' : cfg.downloadUrl ? 'ссылка из .env' : 'НЕ ЗАДАН — /setfile')}`,
        ].join('\n'));
      }
      case '/resend':
        if (!args[0]) return send(chatId, 'Укажите id покупателя: /resend 123456');
        await sendProduct(Number(args[0]));
        return send(chatId, 'Отправлено.');
      case '/refund': {
        const o = db.orders[args[0]];
        if (!o || o.method !== 'stars' || o.status !== 'paid') return send(chatId, 'Возврат возможен только по оплаченному звёздами заказу: /refund НОМЕР');
        await api('refundStarPayment', { user_id: o.userId, telegram_payment_charge_id: o.chargeId });
        o.status = 'refunded';
        delete db.buyers[o.userId];
        save();
        return send(chatId, `Звёзды по заказу №${o.id} возвращены.`);
      }
    }
  }

  if (msg.photo || msg.document) return send(chatId, 'Чтобы отправить чек, выберите способ оплаты в /start и нажмите «Я оплатил».');
  return showStart(chatId);
}

async function onCallback(q) {
  const chatId = q.message?.chat.id ?? q.from.id;
  const [action, arg] = (q.data ?? '').split(':');
  await api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});

  if (action === 'buy') {
    if (db.buyers[q.from.id]) return showStart(chatId);
    if (arg === 'stars') return buyStars(q.from);
    if (arg === 'card') return buyCard(q.from);
    if (arg === 'crypto') return buyCrypto(q.from);
  }
  if (action === 'again' && db.buyers[q.from.id]) return sendProduct(chatId);
  if (action === 'support') return send(chatId, cfg.support ? `Поддержка: ${esc(cfg.support)}` : 'Напишите сюда, продавец ответит.');

  const order = db.orders[arg];
  if (!order) return;
  if (action === 'paid' && order.userId === q.from.id && order.status === 'pending') {
    waiting.set(chatId, { kind: 'proof', orderId: order.id });
    return send(chatId, 'Пришлите скриншот чека одним сообщением.');
  }
  if (action === 'cancel' && order.userId === q.from.id && order.status === 'pending') {
    order.status = 'cancelled';
    save();
    return send(chatId, 'Заказ отменён. /start — выбрать другой способ оплаты.');
  }
  if ((action === 'ok' || action === 'no') && isAdmin(q.from.id)) {
    if (order.status === 'paid') return send(chatId, `Заказ №${order.id} уже выдан.`);
    if (action === 'ok') {
      await deliver(order);
      return send(chatId, `✅ Заказ №${order.id} подтверждён, файл отправлен покупателю.`);
    }
    order.status = 'rejected';
    save();
    await send(order.chatId, `❌ Оплата по заказу №${order.id} не найдена. Если это ошибка — напишите в /paysupport.`);
    return send(chatId, `Заказ №${order.id} отклонён.`);
  }
}

async function onPreCheckout(q) {
  // звёзды: подтверждаем, только если заказ существует и ещё не оплачен
  const order = db.orders[q.invoice_payload.replace('order:', '')];
  const ok = !!order && order.status === 'pending' && order.userId === q.from.id;
  await api('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: 'Заказ устарел — нажмите /start и оформите заново.' });
}

// ---------------------------------------------------------------- проверка крипто-счетов

async function pollCrypto() {
  if (!cfg.cryptoPayToken) return;
  const pending = Object.values(db.orders).filter((o) => o.method === 'crypto' && o.status === 'pending' && o.invoiceId);
  if (!pending.length) return;
  try {
    const r = await crypto('getInvoices', { invoice_ids: pending.map((o) => o.invoiceId).join(','), status: 'paid' });
    for (const inv of r.items ?? []) {
      const order = pending.find((o) => o.invoiceId === inv.invoice_id);
      if (order) await deliver(order);
    }
  } catch (e) {
    log('Crypto Pay:', e.message);
  }
}

// ---------------------------------------------------------------- запуск

async function setup() {
  const me = await api('getMe');
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Купить / скачать' },
    { command: 'paysupport', description: 'Помощь с оплатой' },
    { command: 'terms', description: 'Условия' },
  ] });
  await api('setMyShortDescription', { short_description: `${cfg.product} — покупка и скачивание`.slice(0, 120) }).catch(() => {});
  await api('setMyDescription', { description: `${cfg.description}\n\nОплата звёздами, картой или криптой — установщик приходит сразу после оплаты.`.slice(0, 512) }).catch(() => {});
  log(`Бот @${me.username} запущен. Способы оплаты: ${methods().map((m) => m.id).join(', ') || 'нет (заполните цены в .env)'}.`);
  if (!db.adminId) log(`Администратор не назначен: напишите боту /admin ${cfg.adminCode ? '<ADMIN_CODE из .env>' : '(сначала задайте ADMIN_CODE в .env)'}`);
  if (!db.fileId && !cfg.downloadUrl) log('Файл установщика не задан: администратор отправляет боту /setfile и сам файл.');
}

async function main() {
  await setup();
  setInterval(pollCrypto, 15_000);
  let offset = 0;
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
          else if (u.pre_checkout_query) await onPreCheckout(u.pre_checkout_query);
        } catch (e) {
          log('Ошибка обработки:', e.message);
        }
      }
    } catch (e) {
      log('Нет связи с Telegram:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
