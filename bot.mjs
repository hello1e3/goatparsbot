// Бот продаж GOAT Parser: приветствие, покупка (/pay), личный кабинет, рефералы, поддержка, админка.
// Оплата: звёзды Telegram, перевод на карту (с проверкой чека), криптовалюта (@CryptoBot или кошелёк).
// Без сторонних библиотек: Node.js 20+ (fetch), Bot API через long polling.
// Стартовые настройки — .env / переменные окружения; всё, что меняется в админке, — в data/db.json.
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
  for (const [k, v] of Object.entries(process.env)) if (/^(BOT_TOKEN|ADMIN_|PRODUCT_|PRICE_|STAR_|USDT_|REF_|CRYPTO_|CARD_|DOWNLOAD_URL|SUPPORT_CONTACT|FILE_ID)/.test(k) && v) env[k] = v;
  return env;
}

const env = loadEnv();
const TOKEN = env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Нет BOT_TOKEN (в .env или переменных окружения)');
  process.exit(1);
}
const PRODUCT = env.PRODUCT_NAME || 'GOAT Parser';
const ADMIN_CODE = env.ADMIN_CODE ?? '';
const DOWNLOAD_URL = env.DOWNLOAD_URL ?? '';
const CRYPTO_ASSET = env.CRYPTO_ASSET || 'USDT';
const CRYPTO_TESTNET = env.CRYPTO_PAY_TESTNET === '1';

// ---------------------------------------------------------------- хранилище

const dataDir = path.join(dir, 'data');
const dbFile = path.join(dataDir, 'db.json');
mkdirSync(dataDir, { recursive: true });
const db = existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, 'utf8')) : {};
db.adminId ??= null;
db.fileId ??= null;
db.fileName ??= null;
db.nextId ??= 1;
db.orders ??= {};
db.buyers ??= {};
db.users ??= {};
db.supportMap ??= {};
db.pendingDelivery ??= []; // оплатили, когда установщик ещё не был загружен
// настройки, которые админ меняет прямо в боте; значения из окружения — только стартовые
db.settings = {
  priceRub: Number(env.PRICE_RUB) || 1990,
  starRub: Number(env.STAR_RUB) || 1.5,
  usdtRub: Number(env.USDT_RUB) || 0,
  refPercent: Number(env.REF_PERCENT) || 30,
  cardNumber: env.CARD_NUMBER ?? '',
  cardHolder: env.CARD_HOLDER ?? '',
  cardBank: env.CARD_BANK ?? '',
  cryptoPayToken: env.CRYPTO_PAY_TOKEN ?? '',
  cryptoWallet: env.CRYPTO_WALLET ?? '',
  cryptoNetwork: env.CRYPTO_NETWORK || 'TRC20',
  support: env.SUPPORT_CONTACT ?? '',
  ...(db.settings ?? {}),
};
// на хостинге data/ может пропасть при переносе — администратор и файл могут приходить из настроек
if (!db.adminId && env.ADMIN_ID) db.adminId = Number(env.ADMIN_ID);
if (!db.fileId && env.FILE_ID) db.fileId = env.FILE_ID;

function save() {
  // запись через временный файл: при сбое база не повредится
  writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
  renameSync(dbFile + '.tmp', dbFile);
}
save();
const S = db.settings;

/** Состояние диалога — только в памяти: chatId → { kind: 'proof' | 'support' | 'file' | 'set', ... } */
const waiting = new Map();
let botUsername = '';

// ---------------------------------------------------------------- Bot API

async function api(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const send = (chatId, text, rows) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(rows ? kb(rows) : {}) });
const rub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const who = (u) => (u.username ? `@${u.username}` : esc([u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени')) + ` (id ${u.id})`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const btn = (text, data) => ({ text, callback_data: data });

/** Экран по нажатию кнопки: правим то же сообщение, а если нельзя (счёт, фото) — шлём новое. */
async function show(chatId, msgId, text, rows) {
  if (msgId) {
    try {
      return await api('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kb(rows) });
    } catch (e) {
      if (/not modified/.test(e.message)) return;
    }
  }
  return send(chatId, text, rows);
}

// ---------------------------------------------------------------- курсы и цены

const cryptoBase = CRYPTO_TESTNET ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
async function crypto(method, params = {}) {
  const res = await fetch(`${cryptoBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': S.cryptoPayToken },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`CryptoPay ${method}: ${JSON.stringify(data.error ?? data)}`);
  return data.result;
}

const usdtCache = { rate: 0, at: 0, source: '' };
/** Курс USDT в рублях: ручной из админки, иначе @CryptoBot, иначе курс доллара ЦБ. Кэш — 1 час. */
async function usdtRate() {
  if (S.usdtRub > 0) return { rate: S.usdtRub, source: 'вручную' };
  if (usdtCache.rate && Date.now() - usdtCache.at < 3600_000) return usdtCache;
  let rate = 0;
  let source = '';
  if (S.cryptoPayToken) {
    try {
      const list = await crypto('getExchangeRates');
      rate = Number(list.find((x) => x.source === CRYPTO_ASSET && x.target === 'RUB')?.rate) || 0;
      source = '@CryptoBot';
    } catch (e) { log('Курс CryptoBot:', e.message); }
  }
  if (!rate) {
    try {
      const r = await (await fetch('https://www.cbr-xml-daily.ru/daily_json.js')).json();
      rate = Number(r.Valute.USD.Value) || 0;
      source = 'ЦБ РФ (USD)';
    } catch (e) { log('Курс ЦБ:', e.message); }
  }
  if (rate) Object.assign(usdtCache, { rate, at: Date.now(), source });
  return usdtCache.rate ? usdtCache : { rate: 95, source: 'запасной' };
}

const toStars = (r) => Math.max(1, Math.ceil(r / S.starRub));
const toUsdt = (r, rate) => Math.max(0.1, Math.ceil((r / rate) * 100) / 100);

/** Сколько платит этот пользователь: цена минус бонусный баланс, и то же в звёздах и USDT. */
async function quote(userId) {
  const price = S.priceRub;
  const bonus = Math.min(Math.floor(db.users[userId]?.balance ?? 0), price);
  const toPay = price - bonus;
  const { rate } = await usdtRate();
  return { price, bonus, toPay, stars: toStars(toPay), usdt: toUsdt(toPay, rate) };
}

// ---------------------------------------------------------------- пользователи и заказы

function userRec(u) {
  let r = db.users[u.id];
  const isNew = !r;
  if (!r) r = db.users[u.id] = { id: u.id, balance: 0, earned: 0, refCount: 0, refBy: null, joinedAt: new Date().toISOString() };
  r.name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  r.username = u.username ?? null;
  return { r, isNew };
}

function newOrder(u, method, q, amount, currency) {
  const id = String(db.nextId++);
  db.orders[id] = {
    id, userId: u.id, chatId: u.id, user: who(u), method, amount, currency,
    rub: q.toPay, bonus: q.bonus, status: 'pending', createdAt: new Date().toISOString(),
  };
  save();
  return db.orders[id];
}

const hasCard = () => !!S.cardNumber;
const hasCrypto = () => !!(S.cryptoPayToken || S.cryptoWallet);
const refLink = (id) => `https://t.me/${botUsername}?start=ref_${id}`;

async function deliver(order) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  db.buyers[order.userId] = order.id;
  const buyer = db.users[order.userId];
  if (buyer && order.bonus) buyer.balance = Math.max(0, buyer.balance - order.bonus);
  // реферальное вознаграждение — процент от реально оплаченной суммы
  const ref = buyer?.refBy ? db.users[buyer.refBy] : null;
  let refBonus = 0;
  if (ref && order.rub > 0) {
    refBonus = Math.floor((order.rub * S.refPercent) / 100);
    ref.balance += refBonus;
    ref.earned += refBonus;
  }
  save();
  log('Оплачен заказ', order.id, order.method, order.amount, order.currency, order.user);
  await send(order.chatId, `✅ <b>Оплата получена, спасибо!</b>\n\nЗаказ №${order.id}. Ниже — установщик <b>${esc(PRODUCT)}</b>.\nСкачать снова можно в любой момент в /profile.`);
  await sendProduct(order.chatId);
  if (ref && refBonus) {
    await send(ref.id, `🎉 Ваш друг купил ${esc(PRODUCT)} по вашей ссылке. На бонусный баланс начислено <b>${rub(refBonus)}</b>.\n/profile — баланс и ссылка`).catch(() => {});
  }
  if (db.adminId) {
    await send(db.adminId, `💰 Продажа №${order.id}: ${order.amount} ${order.currency} (${methodName(order.method)}, ≈ ${rub(order.rub)}${order.bonus ? `, бонусами ${rub(order.bonus)}` : ''}) — ${order.user}${refBonus ? `\nРефереру начислено ${rub(refBonus)}` : ''}`).catch(() => {});
  }
}

const methodName = (m) => ({ stars: 'звёзды', card: 'карта', crypto: 'крипта', balance: 'бонусы' })[m] ?? m;

async function sendProduct(chatId) {
  if (db.fileId) {
    await api('sendDocument', { chat_id: chatId, document: db.fileId, caption: `${PRODUCT} — запустите установщик и следуйте подсказкам.` });
  } else if (DOWNLOAD_URL) {
    await send(chatId, `Скачать: ${esc(DOWNLOAD_URL)}`);
  } else {
    // файла нет — запоминаем покупателя, продавец отправит ему файл одной кнопкой
    if (!db.pendingDelivery.includes(chatId)) db.pendingDelivery.push(chatId);
    save();
    await send(chatId, 'Файл пришлём в ближайшее время — продавец уже получил уведомление.');
    if (db.adminId) {
      await send(db.adminId, `⚠ Покупатель (id ${chatId}) оплатил, но установщик ещё не загружен.\n\n1) «📦 Загрузить установщик» — пришлите файл\n2) «📤 Отправить покупателю»`,
        [[btn('📦 Загрузить установщик', 'adm:file')], [btn('📤 Отправить покупателю', `resend:${chatId}`)]]).catch(() => {});
    }
    return;
  }
  db.pendingDelivery = db.pendingDelivery.filter((id) => id !== chatId);
  save();
}

// ---------------------------------------------------------------- экраны покупателя

async function welcome(chatId, u) {
  const bought = db.buyers[u.id];
  const text = [
    `👋 Здравствуйте${u.first_name ? `, ${esc(u.first_name)}` : ''}!`,
    '',
    `Это официальный бот <b>${esc(PRODUCT)}</b> — программы, которая находит клиентов для веб-студий и фрилансеров.`,
    '',
    '🔎 Находит в 2ГИС, Яндексе и OpenStreetMap компании <b>без сайта</b> или с устаревшим сайтом',
    '⭐ Оценивает каждого: телефон, мессенджеры, рейтинг — сразу видно, кому писать первым',
    '🤖 Готовит промпт для нейросети и за пару минут собирает <b>демо-сайт</b> для клиента',
    '💬 Даёт готовые сообщения для WhatsApp и Telegram',
    '📊 Ведёт воронку: от первого сообщения до сделки',
    '',
    'Один найденный клиент окупает программу в несколько раз. Покупка один раз — без подписок, работает на вашем компьютере (Windows).',
    '',
    bought ? '✅ Программа у вас уже есть — скачать её можно в личном кабинете.' : `Цена: <b>${rub(S.priceRub)}</b> · картой, звёздами Telegram или криптой.`,
  ].join('\n');
  const rows = [
    [bought ? btn('⬇ Скачать', 'download') : btn(`🛒 Купить — ${rub(S.priceRub)}`, 'pay')],
    [btn('👤 Личный кабинет', 'profile'), btn('🎁 Пригласить друга', 'invite')],
    [btn('❓ Помощь с оплатой', 'help')],
  ];
  return send(chatId, text, rows);
}

async function payScreen(chatId, msgId, u) {
  if (db.buyers[u.id]) return show(chatId, msgId, `Вы уже купили <b>${esc(PRODUCT)}</b> (заказ №${db.buyers[u.id]}).`, [[btn('⬇ Скачать', 'download')], [btn('👤 Личный кабинет', 'profile')]]);
  const q = await quote(u.id);
  const lines = [`🛒 <b>Покупка ${esc(PRODUCT)}</b>`, '', `Цена: <b>${rub(q.price)}</b>`];
  if (q.bonus) lines.push(`Бонусами: −${rub(q.bonus)}`, `К оплате: <b>${rub(q.toPay)}</b>`);
  lines.push('', 'Выберите способ оплаты — установщик придёт сюда сразу после оплаты:');
  const rows = [];
  if (q.toPay === 0) {
    rows.push([btn('🎁 Получить за бонусы', 'buy:balance')]);
  } else {
    rows.push([btn(`⭐ Звёздами Telegram — ${q.stars} ⭐`, 'buy:stars')]);
    if (hasCard()) rows.push([btn(`💳 Переводом на карту — ${rub(q.toPay)}`, 'buy:card')]);
    if (hasCrypto()) rows.push([btn(`🪙 Криптовалютой — ${q.usdt} ${CRYPTO_ASSET}`, 'buy:crypto')]);
  }
  rows.push([btn('❓ Помощь с оплатой', 'help'), btn('← Назад', 'home')]);
  return show(chatId, msgId, lines.join('\n'), rows);
}

async function profile(chatId, msgId, u) {
  const { r } = userRec(u);
  save();
  const bought = db.buyers[u.id];
  const text = [
    '👤 <b>Личный кабинет</b>',
    '',
    bought ? `✅ ${esc(PRODUCT)} куплен (заказ №${bought})` : `🛒 ${esc(PRODUCT)} ещё не куплен`,
    `💰 Бонусный баланс: <b>${rub(r.balance)}</b>${r.balance && !bought ? ' — спишется при покупке' : ''}`,
    `👥 Приглашено друзей: ${r.refCount} · заработано: ${rub(r.earned)}`,
    '',
    `🔗 Ваша ссылка:\n<code>${refLink(u.id)}</code>`,
    `Друг покупает по ней — вы получаете <b>${S.refPercent}%</b> от суммы на бонусный баланс.`,
  ].join('\n');
  const share = `https://t.me/share/url?url=${encodeURIComponent(refLink(u.id))}&text=${encodeURIComponent(`${PRODUCT} — находит клиентов без сайта и собирает им демо-сайт`)}`;
  return show(chatId, msgId, text, [
    [bought ? btn('⬇ Скачать', 'download') : btn('🛒 Купить', 'pay')],
    [{ text: '📤 Поделиться ссылкой', url: share }],
    [btn('❓ Помощь', 'help'), btn('← Назад', 'home')],
  ]);
}

async function invite(chatId, msgId, u) {
  userRec(u);
  save();
  const share = `https://t.me/share/url?url=${encodeURIComponent(refLink(u.id))}&text=${encodeURIComponent(`${PRODUCT} — находит клиентов без сайта и собирает им демо-сайт`)}`;
  return show(chatId, msgId, [
    '🎁 <b>Приглашайте друзей — платите меньше</b>',
    '',
    `Когда друг покупает ${esc(PRODUCT)} по вашей ссылке, вам начисляется <b>${S.refPercent}%</b> от суммы его покупки.`,
    'Бонусами можно оплатить часть своей покупки — или всю целиком.',
    '',
    `Ваша ссылка:\n<code>${refLink(u.id)}</code>`,
  ].join('\n'), [[{ text: '📤 Отправить другу', url: share }], [btn('👤 Личный кабинет', 'profile'), btn('← Назад', 'home')]]);
}

async function askSupport(chatId) {
  waiting.set(chatId, { kind: 'support' });
  const contact = S.support ? `\nИли напишите напрямую: ${esc(S.support)}` : '';
  return send(chatId, `❓ <b>Помощь с оплатой</b>\n\nОпишите вопрос одним сообщением (можно со скриншотом) — продавец ответит прямо здесь.${contact}`, [[btn('Отмена', 'home')]]);
}

// ---------------------------------------------------------------- оплата

async function buy(chatId, u, method) {
  if (db.buyers[u.id]) return payScreen(chatId, null, u);
  const q = await quote(u.id);
  if (method === 'balance') {
    if (q.toPay !== 0) return payScreen(chatId, null, u);
    return deliver(newOrder(u, 'balance', q, q.bonus, 'RUB'));
  }
  if (method === 'stars') {
    const order = newOrder(u, 'stars', q, q.stars, 'XTR');
    return api('sendInvoice', {
      chat_id: chatId,
      title: PRODUCT,
      description: `Программа для Windows: находит бизнес без сайта и собирает демо-сайт. Заказ №${order.id}.`,
      payload: `order:${order.id}`,
      currency: 'XTR',
      prices: [{ label: PRODUCT, amount: q.stars }],
    });
  }
  if (method === 'card' && hasCard()) {
    const order = newOrder(u, 'card', q, q.toPay, 'RUB');
    return send(chatId, [
      `💳 <b>Оплата переводом — заказ №${order.id}</b>`,
      '',
      `Сумма: <b>${rub(q.toPay)}</b>`,
      `Карта: <code>${esc(S.cardNumber)}</code>`,
      S.cardHolder ? `Получатель: ${esc(S.cardHolder)}` : null,
      S.cardBank ? `Банк: ${esc(S.cardBank)}` : null,
      '',
      'Переведите точную сумму, комментарий к переводу не пишите. Затем нажмите «Я оплатил» и пришлите скриншот чека — после проверки бот пришлёт установщик.',
    ].filter((x) => x !== null).join('\n'), [[btn('✅ Я оплатил', `paid:${order.id}`)], [btn('Отменить', `cancel:${order.id}`)]]);
  }
  if (method === 'crypto' && hasCrypto()) {
    const order = newOrder(u, 'crypto', q, q.usdt, CRYPTO_ASSET);
    if (S.cryptoPayToken) {
      const inv = await crypto('createInvoice', {
        currency_type: 'crypto', asset: CRYPTO_ASSET, amount: String(q.usdt),
        description: `${PRODUCT} — заказ №${order.id}`, payload: order.id, expires_in: 3600,
      });
      order.invoiceId = inv.invoice_id;
      save();
      return send(chatId, `🪙 <b>Оплата криптой — заказ №${order.id}</b>\n\nСчёт на <b>${q.usdt} ${CRYPTO_ASSET}</b> в @CryptoBot действует 1 час. После оплаты бот сам пришлёт установщик.`,
        [[{ text: `Оплатить ${q.usdt} ${CRYPTO_ASSET}`, url: inv.bot_invoice_url ?? inv.pay_url }]]);
    }
    return send(chatId, [
      `🪙 <b>Оплата криптой — заказ №${order.id}</b>`,
      '',
      `Переведите <b>${q.usdt} ${CRYPTO_ASSET}</b> (сеть ${esc(S.cryptoNetwork)}) на адрес:`,
      `<code>${esc(S.cryptoWallet)}</code>`,
      '',
      'Затем нажмите «Я оплатил» и пришлите скриншот или хэш транзакции.',
    ].join('\n'), [[btn('✅ Я оплатил', `paid:${order.id}`)], [btn('Отменить', `cancel:${order.id}`)]]);
  }
  return payScreen(chatId, null, u);
}

/** Чек от покупателя → продавцу с кнопками «Подтвердить / Отклонить». */
async function forwardProof(msg, order) {
  if (!db.adminId) return send(msg.chat.id, 'Чек получен. Продавец проверит оплату и бот пришлёт установщик.');
  order.status = 'review';
  save();
  await api('copyMessage', { chat_id: db.adminId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  await send(db.adminId, `🧾 Чек по заказу №${order.id}: <b>${order.amount} ${order.currency}</b> (${methodName(order.method)}) от ${order.user}`,
    [[btn('✅ Подтвердить', `ok:${order.id}`), btn('❌ Отклонить', `no:${order.id}`)]]);
  return send(msg.chat.id, 'Чек отправлен продавцу. Как только оплата подтвердится, бот пришлёт установщик.');
}

// ---------------------------------------------------------------- поддержка

/** Сообщение покупателя → продавцу. Ответ продавца реплаем уходит покупателю. */
async function forwardSupport(msg) {
  if (!db.adminId) return send(msg.chat.id, 'Поддержка временно недоступна, попробуйте позже.');
  const head = await send(db.adminId, `✉ <b>Сообщение от ${who(msg.from)}</b>\nОтветьте на него (Reply) — ответ уйдёт покупателю.`);
  const copy = await api('copyMessage', { chat_id: db.adminId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  db.supportMap[head.message_id] = msg.chat.id;
  db.supportMap[copy.message_id] = msg.chat.id;
  // храним только последние ~1000 связок
  const keys = Object.keys(db.supportMap);
  if (keys.length > 1000) for (const k of keys.slice(0, keys.length - 1000)) delete db.supportMap[k];
  save();
  return send(msg.chat.id, '✉ Сообщение передано продавцу — ответ придёт сюда.');
}

// ---------------------------------------------------------------- админка

const isAdmin = (id) => db.adminId === id;

const SETTINGS = {
  price: { label: 'Цена в рублях', prompt: 'Пришлите новую цену в рублях, например <code>1990</code>. Звёзды и USDT пересчитаются сами.' },
  star: { label: 'Курс звезды', prompt: 'Сколько рублей стоит 1 звезда для покупателя? Например <code>1.5</code>.' },
  usdt: { label: 'Курс USDT', prompt: 'Курс USDT в рублях, например <code>92.5</code>. <code>0</code> — брать автоматически (@CryptoBot или ЦБ).' },
  ref: { label: 'Реферальный %', prompt: 'Какой процент от покупки друга начислять пригласившему? От 0 до 90.' },
  card: { label: 'Карта', prompt: 'Пришлите реквизиты карты, каждый с новой строки:\n1) номер карты\n2) получатель (необязательно)\n3) банк (необязательно)\n\n<code>-</code> — убрать оплату картой.\nНомер виден покупателю только после выбора оплаты картой.' },
  wallet: { label: 'Кошелёк', prompt: 'Пришлите адрес кошелька USDT и через пробел сеть, например:\n<code>TXyz... TRC20</code>\n\n<code>-</code> — убрать.' },
  cptoken: { label: 'Crypto Pay токен', prompt: 'Пришлите токен приложения из @CryptoBot → Crypto Pay → My Apps.\nС ним бот сам выставляет счёт и видит оплату. <code>-</code> — убрать.' },
  support: { label: 'Контакт поддержки', prompt: 'Ваш контакт для покупателей, например <code>@ваш_ник</code>. <code>-</code> — убрать.' },
};

async function adminPanel(chatId, msgId) {
  const { rate, source } = await usdtRate();
  const q = { stars: toStars(S.priceRub), usdt: toUsdt(S.priceRub, rate) };
  const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
  const text = [
    '👑 <b>Админка</b>',
    '',
    `💰 Цена: <b>${rub(S.priceRub)}</b> ≈ ${q.stars} ⭐ ≈ ${q.usdt} ${CRYPTO_ASSET}`,
    `⭐ 1 звезда = ${S.starRub} ₽`,
    `💵 1 ${CRYPTO_ASSET} = ${Math.round(rate * 100) / 100} ₽ (${source})`,
    `🎁 Рефералам: ${S.refPercent}%`,
    `💳 Карта: ${S.cardNumber ? `•••• ${esc(S.cardNumber.replace(/\D/g, '').slice(-4))}` : 'не задана'}`,
    `🪙 Крипта: ${S.cryptoPayToken ? '@CryptoBot' : S.cryptoWallet ? `кошелёк ${esc(S.cryptoNetwork)}` : 'не задана'}`,
    `☎ Поддержка: ${S.support ? esc(S.support) : 'сообщения приходят сюда'}`,
    `📦 Установщик: ${db.fileId ? esc(db.fileName ?? 'загружен') : DOWNLOAD_URL ? 'ссылка' : '<b>не загружен</b>'}`,
    '',
    `Продаж: ${paid.length} · пользователей: ${Object.keys(db.users).length}`,
  ].join('\n');
  return show(chatId, msgId, text, [
    [btn('💰 Цена', 'adm:price'), btn('⭐ Курс звезды', 'adm:star')],
    [btn('💵 Курс USDT', 'adm:usdt'), btn('🎁 Реф. %', 'adm:ref')],
    [btn('💳 Карта', 'adm:card'), btn('🪙 Кошелёк', 'adm:wallet')],
    [btn('🔑 Crypto Pay', 'adm:cptoken'), btn('☎ Поддержка', 'adm:support')],
    [btn('📦 Загрузить установщик', 'adm:file'), btn('📊 Статистика', 'adm:stats')],
  ]);
}

async function applySetting(chatId, key, raw) {
  const v = raw.trim();
  const num = Number(v.replace(',', '.').replace(/\s/g, ''));
  const clear = v === '-';
  switch (key) {
    case 'price':
      if (!(num >= 1)) return 'Нужно число больше 0';
      S.priceRub = Math.round(num);
      break;
    case 'star':
      if (!(num > 0)) return 'Нужно число больше 0';
      S.starRub = num;
      break;
    case 'usdt':
      if (!(num >= 0)) return 'Нужно число (0 — автоматически)';
      S.usdtRub = num;
      usdtCache.at = 0;
      break;
    case 'ref':
      if (!(num >= 0 && num <= 90)) return 'Нужно число от 0 до 90';
      S.refPercent = Math.round(num);
      break;
    case 'card': {
      if (clear) { S.cardNumber = S.cardHolder = S.cardBank = ''; break; }
      const [num_, holder, bank] = v.split(/\r?\n/).map((x) => x.trim());
      if ((num_.replace(/\D/g, '')).length < 12) return 'В первой строке должен быть номер карты';
      S.cardNumber = num_;
      S.cardHolder = holder ?? '';
      S.cardBank = bank ?? '';
      break;
    }
    case 'wallet': {
      if (clear) { S.cryptoWallet = ''; break; }
      const [addr, net] = v.split(/\s+/);
      S.cryptoWallet = addr;
      if (net) S.cryptoNetwork = net;
      break;
    }
    case 'cptoken':
      if (clear) { S.cryptoPayToken = ''; break; }
      S.cryptoPayToken = v;
      try {
        await crypto('getMe');
      } catch {
        S.cryptoPayToken = '';
        return 'Токен не подошёл — проверьте его в @CryptoBot';
      }
      usdtCache.at = 0;
      break;
    case 'support':
      S.support = clear ? '' : v;
      break;
  }
  save();
  return null;
}

async function stats(chatId, msgId) {
  const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
  const by = (m) => paid.filter((o) => o.method === m);
  const users = Object.values(db.users);
  return show(chatId, msgId, [
    '📊 <b>Статистика</b>',
    '',
    `Продаж: <b>${paid.length}</b> на ≈ ${rub(paid.reduce((a, o) => a + (o.rub ?? 0), 0))}`,
    `⭐ Звёзды: ${by('stars').length} шт · ${by('stars').reduce((a, o) => a + o.amount, 0)} ⭐`,
    `💳 Карта: ${by('card').length} шт · ${rub(by('card').reduce((a, o) => a + o.amount, 0))}`,
    `🪙 Крипта: ${by('crypto').length} шт · ${Math.round(by('crypto').reduce((a, o) => a + o.amount, 0) * 100) / 100} ${CRYPTO_ASSET}`,
    `🎁 Бонусами: ${by('balance').length} шт`,
    '',
    `Пользователей: ${users.length} · пришли по ссылкам: ${users.filter((u) => u.refBy).length}`,
    `Начислено рефералам: ${rub(users.reduce((a, u) => a + (u.earned ?? 0), 0))}`,
  ].join('\n'), [[btn('← Админка', 'adm:panel')]]);
}

// ---------------------------------------------------------------- обработка апдейтов

async function onMessage(msg) {
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const u = msg.from;
  const text = msg.text ?? '';

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

  // продавец отвечает покупателю реплаем на пересланное сообщение
  if (isAdmin(u.id) && msg.reply_to_message && db.supportMap[msg.reply_to_message.message_id]) {
    const to = db.supportMap[msg.reply_to_message.message_id];
    await send(to, '💬 <b>Ответ продавца:</b>');
    await api('copyMessage', { chat_id: to, from_chat_id: chatId, message_id: msg.message_id });
    return send(chatId, '✓ Ответ отправлен');
  }

  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw?.startsWith('/') ? cmdRaw.replace(/@\w+$/, '').toLowerCase() : '';
  const w = waiting.get(chatId);

  // ожидаемый ввод (команды его отменяют)
  if (w && !cmd) {
    if (w.kind === 'file' && isAdmin(u.id) && msg.document) {
      waiting.delete(chatId);
      db.fileId = msg.document.file_id;
      db.fileName = msg.document.file_name ?? null;
      save();
      await send(chatId, `✓ Установщик сохранён: ${esc(db.fileName ?? 'файл')}. Покупатели получат его сразу после оплаты.`);
      if (db.pendingDelivery.length) {
        return send(chatId, `Файла ждут покупатели: ${db.pendingDelivery.length}.`, [[btn(`📤 Отправить всем (${db.pendingDelivery.length})`, 'resend:all')]]);
      }
      return adminPanel(chatId);
    }
    if (w.kind === 'set' && isAdmin(u.id) && text) {
      const err = await applySetting(chatId, w.key, text);
      if (err) return send(chatId, `⚠ ${err}. Попробуйте ещё раз или нажмите «Отмена».`, [[btn('Отмена', 'adm:panel')]]);
      waiting.delete(chatId);
      // сообщение с реквизитами или токеном убираем из переписки
      if (['card', 'cptoken'].includes(w.key)) api('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      await send(chatId, `✓ ${SETTINGS[w.key].label}: сохранено`);
      return adminPanel(chatId);
    }
    if (w.kind === 'proof' && (msg.photo || msg.document || text)) {
      waiting.delete(chatId);
      const order = db.orders[w.orderId];
      if (order && order.status === 'pending') return forwardProof(msg, order);
    }
    if (w.kind === 'support') {
      waiting.delete(chatId);
      return forwardSupport(msg);
    }
  }
  if (cmd) waiting.delete(chatId);

  switch (cmd) {
    case '/start': {
      const { r, isNew } = userRec(u);
      // реферальная ссылка: /start ref_123
      const refId = Number(args[0]?.match(/^ref_(\d+)$/)?.[1]);
      if (isNew && refId && refId !== u.id && db.users[refId]) {
        r.refBy = refId;
        db.users[refId].refCount++;
        send(refId, `👥 По вашей ссылке пришёл новый пользователь. Когда он купит ${esc(PRODUCT)}, вам начислится ${S.refPercent}% от суммы.`).catch(() => {});
      }
      save();
      return welcome(chatId, u);
    }
    case '/pay':
    case '/buy':
      userRec(u);
      return payScreen(chatId, null, u);
    case '/profile':
    case '/me':
      return profile(chatId, null, u);
    case '/ref':
    case '/invite':
      return invite(chatId, null, u);
    case '/paysupport':
    case '/support':
    case '/help':
      return askSupport(chatId);
    case '/terms':
      return send(chatId, `После оплаты вы получаете установщик ${esc(PRODUCT)} для Windows — сразу, в этом чате. Покупка разовая, без подписки. Если файл не пришёл или не запускается — /paysupport.`);
    case '/admin':
      if (!db.adminId && ADMIN_CODE && args[0] === ADMIN_CODE) {
        db.adminId = u.id;
        save();
        await setCommands();
      }
      if (!isAdmin(u.id)) return send(chatId, 'Команда недоступна.');
      return adminPanel(chatId);
  }

  if (isAdmin(u.id)) {
    switch (cmd) {
      case '/stats':
        return stats(chatId);
      case '/setfile':
        waiting.set(chatId, { kind: 'file' });
        return send(chatId, 'Пришлите установщик одним файлом (как документ).', [[btn('Отмена', 'adm:panel')]]);
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
    if (!cmd) return send(chatId, 'Чтобы ответить покупателю, ответьте (Reply) на его пересланное сообщение. /admin — админка.');
  }

  // всё остальное от покупателя — в поддержку, чтобы ни одно сообщение не потерялось
  if (!cmd) return forwardSupport(msg);
  return welcome(chatId, u);
}

async function onCallback(q) {
  const chatId = q.message?.chat.id ?? q.from.id;
  const msgId = q.message?.message_id;
  const u = q.from;
  const [action, arg] = (q.data ?? '').split(':');
  await api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  userRec(u);

  switch (action) {
    case 'home':
      waiting.delete(chatId);
      if (msgId) api('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
      return welcome(chatId, u);
    case 'pay': return payScreen(chatId, msgId, u);
    case 'profile': return profile(chatId, msgId, u);
    case 'invite': return invite(chatId, msgId, u);
    case 'help': return askSupport(chatId);
    case 'download': return db.buyers[u.id] ? sendProduct(chatId) : payScreen(chatId, msgId, u);
    case 'buy':
      try {
        return await buy(chatId, u, arg);
      } catch (e) {
        log('Не удалось создать счёт:', e.message);
        return send(chatId, '⚠ Не получилось создать счёт. Попробуйте другой способ оплаты или напишите в поддержку.', [[btn('🛒 Способы оплаты', 'pay'), btn('❓ Помощь', 'help')]]);
      }
  }

  // отправить установщик покупателю (или всем ожидающим) одной кнопкой
  if (action === 'resend' && isAdmin(u.id)) {
    if (!db.fileId && !DOWNLOAD_URL) {
      return send(chatId, 'Сначала загрузите установщик — потом нажмите «Отправить» ещё раз.', [[btn('📦 Загрузить установщик', 'adm:file')]]);
    }
    const list = arg === 'all' ? [...db.pendingDelivery] : [Number(arg)];
    for (const id of list) await sendProduct(id);
    return show(chatId, msgId, `✓ Установщик отправлен: ${list.length === 1 ? `покупатель id ${list[0]}` : `${list.length} покупателям`}.`, []);
  }

  if (action === 'adm' && isAdmin(u.id)) {
    waiting.delete(chatId);
    if (arg === 'panel') return adminPanel(chatId, msgId);
    if (arg === 'stats') return stats(chatId, msgId);
    if (arg === 'file') {
      waiting.set(chatId, { kind: 'file' });
      return send(chatId, 'Пришлите установщик одним файлом (как документ). Размер не ограничен.', [[btn('Отмена', 'adm:panel')]]);
    }
    if (SETTINGS[arg]) {
      waiting.set(chatId, { kind: 'set', key: arg });
      return send(chatId, `<b>${SETTINGS[arg].label}</b>\n\n${SETTINGS[arg].prompt}`, [[btn('Отмена', 'adm:panel')]]);
    }
    return;
  }

  const order = db.orders[arg];
  if (!order) return;
  if (action === 'paid' && order.userId === u.id && order.status === 'pending') {
    waiting.set(chatId, { kind: 'proof', orderId: order.id });
    return send(chatId, 'Пришлите скриншот чека одним сообщением.');
  }
  if (action === 'cancel' && order.userId === u.id && order.status === 'pending') {
    order.status = 'cancelled';
    save();
    return show(chatId, msgId, `Заказ №${order.id} отменён.`, [[btn('🛒 Выбрать другой способ', 'pay')]]);
  }
  if ((action === 'ok' || action === 'no') && isAdmin(u.id)) {
    if (order.status === 'paid') return send(chatId, `Заказ №${order.id} уже выдан.`);
    if (action === 'ok') {
      await deliver(order);
      return show(chatId, msgId, `✅ Заказ №${order.id} подтверждён${db.fileId || DOWNLOAD_URL ? ', установщик отправлен покупателю' : ''}.`, []);
    }
    order.status = 'rejected';
    save();
    await send(order.chatId, `❌ Оплата по заказу №${order.id} не найдена. Если это ошибка — /paysupport.`);
    return show(chatId, msgId, `Заказ №${order.id} отклонён.`, []);
  }
}

async function onPreCheckout(q) {
  // звёзды: подтверждаем, только если заказ ещё ждёт оплаты и сумма та же
  const order = db.orders[q.invoice_payload.replace('order:', '')];
  const ok = !!order && order.status === 'pending' && order.userId === q.from.id && order.amount === q.total_amount && !db.buyers[q.from.id];
  await api('answerPreCheckoutQuery', ok
    ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: 'Счёт устарел — нажмите /pay и оформите заново.' });
}

// ---------------------------------------------------------------- проверка крипто-счетов

async function pollCrypto() {
  if (!S.cryptoPayToken) return;
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

async function setCommands() {
  const base = [
    { command: 'start', description: 'О программе' },
    { command: 'pay', description: 'Купить' },
    { command: 'profile', description: 'Личный кабинет и бонусы' },
    { command: 'invite', description: 'Пригласить друга' },
    { command: 'paysupport', description: 'Помощь с оплатой' },
    { command: 'terms', description: 'Условия' },
  ];
  await api('setMyCommands', { commands: base });
  if (db.adminId) {
    await api('setMyCommands', { commands: [...base, { command: 'admin', description: 'Админка' }, { command: 'stats', description: 'Статистика' }], scope: { type: 'chat', chat_id: db.adminId } }).catch(() => {});
  }
}

async function setup() {
  const me = await api('getMe');
  botUsername = me.username;
  await setCommands();
  await api('setMyShortDescription', { short_description: `${PRODUCT} — находит клиентов без сайта и собирает им демо-сайт` .slice(0, 120) }).catch(() => {});
  await api('setMyDescription', { description: `${PRODUCT} — программа для Windows: находит компании без сайта в 2ГИС, Яндексе и OpenStreetMap, готовит промпт для нейросети и собирает демо-сайт для клиента.\n\nНажмите «Старт», чтобы узнать больше.`.slice(0, 512) }).catch(() => {});
  log(`Бот @${me.username} запущен. Цена ${S.priceRub} ₽, карта: ${hasCard() ? 'да' : 'нет'}, крипта: ${hasCrypto() ? 'да' : 'нет'}.`);
  if (!db.adminId) log('Администратор не назначен: задайте ADMIN_ID или напишите боту /admin <ADMIN_CODE>');
  if (!db.fileId && !DOWNLOAD_URL) log('Установщик не загружен: /admin → «Загрузить установщик».');
}

async function main() {
  await setup();
  setInterval(pollCrypto, 15_000);
  let offset = 0;
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });
      for (const upd of updates) {
        offset = upd.update_id + 1;
        try {
          if (upd.message) await onMessage(upd.message);
          else if (upd.callback_query) await onCallback(upd.callback_query);
          else if (upd.pre_checkout_query) await onPreCheckout(upd.pre_checkout_query);
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
