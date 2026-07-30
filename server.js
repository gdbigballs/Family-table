const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 15515);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'family-table.db'));
const sessions = new Map();
const reviewWindows = new Map();

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS dishes (id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(category_id) REFERENCES categories(id));
  CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, date TEXT NOT NULL, time_slot TEXT NOT NULL, guests INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '待确认', contact_name TEXT NOT NULL, contact_info TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', admin_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, access_token TEXT NOT NULL, reservation_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT '待确认', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, FOREIGN KEY(reservation_id) REFERENCES reservations(id));
  CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, dish_name TEXT NOT NULL, quantity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '[]', FOREIGN KEY(order_id) REFERENCES orders(id));
  CREATE TABLE IF NOT EXISTS dish_reviews (id INTEGER PRIMARY KEY, dish_id INTEGER NOT NULL, author TEXT NOT NULL, rating INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(dish_id) REFERENCES dishes(id));
  CREATE TABLE IF NOT EXISTS closed_days (date TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '当日暂停预约');
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, hash] = encoded.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(actual, 'hex'));
}

function setting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function isSetupComplete() {
  return setting('setup_completed', '0') === '1';
}

// Installations created before the setup flow already have an administrator.
// Treat them as configured so an update never sends an existing family back to setup.
if (db.prepare('SELECT id FROM admins LIMIT 1').get() && !db.prepare("SELECT key FROM settings WHERE key = 'setup_completed'").get()) {
  setSetting('setup_completed', '1');
}

function seed() {
  const defaults = {
    title: '家宴点单',
    welcome: '今天想吃点什么？提前选好菜，到家就能开饭。',
    logo_url: '',
    favicon_url: '',
    site_open: '1',
    schedule: JSON.stringify({ days: [0, 6], slots: ['11:30', '17:30'], maxPeople: 8, maxOrders: 4, minLeadHours: 2, maxDays: 30 })
  };
  for (const [key, value] of Object.entries(defaults)) if (!db.prepare('SELECT key FROM settings WHERE key = ?').get(key)) setSetting(key, value);
  if (!db.prepare('SELECT id FROM categories LIMIT 1').get()) {
    const addCategory = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    addCategory.run('招牌热菜', 1); addCategory.run('清爽小菜', 2); addCategory.run('主食汤品', 3);
    const addDish = db.prepare('INSERT INTO dishes (category_id, name, description, image_url, options_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    const hot = JSON.stringify([{ name: '辣度', type: 'single', required: true, values: ['不辣', '微辣', '中辣', '重辣'] }, { name: '分量', type: 'single', required: true, values: ['标准份', '加量'] }, { name: '忌口', type: 'multiple', required: false, values: ['不要香菜', '少盐', '不要葱'] }]);
    const light = JSON.stringify([{ name: '口味', type: 'single', required: false, values: ['正常', '少盐', '少油'] }]);
    addDish.run(1, '家常小炒肉', '鲜香下饭，现炒更有锅气。', 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?auto=format&fit=crop&w=900&q=80', hot, 1);
    addDish.run(1, '番茄炖牛腩', '酸甜浓郁，慢炖入味。', 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=80', JSON.stringify([{ name: '分量', type: 'single', required: true, values: ['标准份', '加量'] }, { name: '搭配', type: 'multiple', required: false, values: ['多汤汁', '加土豆'] }]), 2);
    addDish.run(2, '凉拌木耳', '清爽脆嫩，微酸开胃。', 'https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=900&q=80', light, 1);
    addDish.run(3, '菌菇鸡汤', '慢火煨出的清甜暖汤。', 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=900&q=80', JSON.stringify([{ name: '分量', type: 'single', required: true, values: ['小盅', '分享份'] }]), 1);
  }
  if (!db.prepare('SELECT id FROM dish_reviews LIMIT 1').get()) {
    const dishes = db.prepare('SELECT id, name FROM dishes').all();
    const ids = Object.fromEntries(dishes.map(dish => [dish.name, dish.id]));
    const addReview = db.prepare('INSERT INTO dish_reviews (dish_id, author, rating, content, created_at) VALUES (?, ?, ?, ?, ?)');
    const examples = [
      ['家常小炒肉', '小林', 5, '微辣刚刚好，配米饭很香，下次还想点。', '2026-07-18T12:10:00.000Z'],
      ['家常小炒肉', '阿姨', 4, '肉很嫩，建议可以再多一点青椒。', '2026-07-12T11:42:00.000Z'],
      ['番茄炖牛腩', '小周', 5, '汤汁浓，牛腩也软烂，孩子很喜欢。', '2026-07-20T18:36:00.000Z'],
      ['凉拌木耳', '小米', 4, '清爽开胃，少放一点醋会更适合我。', '2026-07-08T17:20:00.000Z']
    ];
    for (const [name, author, rating, content, createdAt] of examples) if (ids[name]) addReview.run(ids[name], author, rating, content, createdAt);
  }
}
seed();

// The order workflow no longer uses intermediate production or cancellation states.
db.prepare("UPDATE orders SET status = '已确认' WHERE status = '制作中'").run();
db.prepare("UPDATE orders SET status = '已拒绝' WHERE status = '已取消'").run();
db.prepare("UPDATE reservations SET status = '已拒绝' WHERE status = '已取消'").run();

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 6 * 1024 * 1024) { reject(new Error('请求内容过大')); req.destroy(); } else body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('无效的请求数据')); } });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(item => item.length === 2));
}

function admin(req) {
  const token = cookies(req).family_admin;
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return false; }
  return true;
}

function requireAdmin(req, res) {
  if (!admin(req)) { json(res, 401, { error: '请先登录后台' }); return false; }
  return true;
}

function publicSettings() {
  return {
    title: setting('title', '家宴点单'),
    welcome: setting('welcome', ''),
    logoUrl: setting('logo_url', ''),
    faviconUrl: setting('favicon_url', ''),
    siteOpen: setting('site_open', '1') === '1',
    schedule: JSON.parse(setting('schedule', '{}'))
  };
}

function adminSettings() {
  return { ...publicSettings(), wecomWebhookConfigured: Boolean(setting('wecom_webhook_url', '')) };
}

function menu() {
  const categories = db.prepare('SELECT id, name FROM categories WHERE active = 1 ORDER BY sort_order, id').all();
  const dishRows = db.prepare(`SELECT d.id, d.category_id, d.name, d.description, d.image_url, d.options_json, d.active, d.sort_order,
    (SELECT COUNT(*) FROM dish_reviews r WHERE r.dish_id = d.id AND r.visible = 1) AS review_count,
    COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM dish_reviews r WHERE r.dish_id = d.id AND r.visible = 1), 0) AS average_rating,
    (SELECT COUNT(*) FROM order_items oi WHERE oi.dish_name = d.name) AS order_count
    FROM dishes d ORDER BY d.sort_order, d.id`).all();
  return categories.map(category => ({ ...category, dishes: dishRows.filter(dish => dish.category_id === category.id && dish.active).map(dish => ({ id: dish.id, name: dish.name, description: dish.description, imageUrl: dish.image_url, options: JSON.parse(dish.options_json), reviewCount: dish.review_count, averageRating: dish.average_rating, orderCount: dish.order_count })) }));
}

function scheduleForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { slots: [], reason: '日期格式不正确' };
  if (!publicSettings().siteOpen) return { slots: [], reason: '当前暂停营业，暂不接受预约' };
  const closed = db.prepare('SELECT reason FROM closed_days WHERE date = ?').get(date);
  if (closed) return { slots: [], reason: closed.reason };
  const schedule = publicSettings().schedule;
  const day = new Date(`${date}T12:00:00`).getDay();
  if (!schedule.days.includes(day)) return { slots: [], reason: '当天不提供预约' };
  const now = new Date(); const selected = new Date(`${date}T00:00:00`);
  const limit = new Date(now); limit.setDate(limit.getDate() + schedule.maxDays);
  if (selected < new Date(now.getFullYear(), now.getMonth(), now.getDate()) || selected > limit) return { slots: [], reason: '该日期暂不可预约' };
  return { slots: schedule.slots.map(time => {
    const slotStart = new Date(`${date}T${time}:00`);
    const leadTimeReached = slotStart.getTime() - now.getTime() < schedule.minLeadHours * 60 * 60 * 1000;
    const used = db.prepare("SELECT COUNT(*) AS orders, COALESCE(SUM(guests), 0) AS guests FROM reservations WHERE date = ? AND time_slot = ? AND status IN ('待确认', '已确认')").get(date, time);
    return { time, remainingOrders: Math.max(0, schedule.maxOrders - used.orders), remainingGuests: Math.max(0, schedule.maxPeople - used.guests), available: !leadTimeReached && used.orders < schedule.maxOrders && used.guests < schedule.maxPeople };
  }) };
}

function makeCode() { return `FT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function timestamp() { return new Date().toISOString(); }
function text(value, max = 300) { return String(value || '').trim().slice(0, max); }

function wecomWebhookUrl(value) {
  const webhook = text(value, 1000);
  let url;
  try { url = new URL(webhook); } catch { throw new Error('企业微信 Webhook 地址不正确'); }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key')) throw new Error('请填写企业微信机器人的 Webhook 地址');
  return url.toString();
}

async function sendWecomText(content) {
  const webhook = setting('wecom_webhook_url', '');
  if (!webhook) return false;
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  });
  let result = {};
  try { result = await response.json(); } catch { /* 企业微信异常响应会在下方统一处理。 */ }
  if (!response.ok || result.errcode !== 0) throw new Error(result.errmsg || `企业微信返回 HTTP ${response.status}`);
  return true;
}

function wecomOrderMessage(order) {
  const type = order.kind === 'immediate' ? '立即点菜' : '预约点菜';
  const dishes = order.items.length ? order.items.map(item => `${item.name} x${item.quantity}`).join('、') : '未选择菜品';
  return ['新订单提醒', `订单编号：${order.code}`, `类型：${type}`, `用餐：${order.date} ${order.timeSlot}，${order.guests} 人`, `下单人：${order.contactName}`, `联系方式：${order.contactInfo}`, `菜品：${dishes}`, order.note ? `备注：${order.note}` : '备注：无'].join('\n');
}

function notifyWecomNewOrder(order) {
  void sendWecomText(wecomOrderMessage(order)).catch(error => console.error(`企业微信订单通知发送失败：${error.message}`));
}

function menuExport() {
  const categories = db.prepare('SELECT id, name, sort_order, active FROM categories ORDER BY sort_order, id').all();
  const categoryIndex = new Map(categories.map((category, index) => [category.id, index]));
  const dishes = db.prepare('SELECT category_id, name, description, image_url, options_json, active, sort_order FROM dishes ORDER BY sort_order, id').all();
  return {
    format: 'family-table-menu',
    version: 1,
    exportedAt: timestamp(),
    categories: categories.map(category => ({ name: category.name, sortOrder: category.sort_order, active: Boolean(category.active) })),
    dishes: dishes.map(dish => ({ categoryIndex: categoryIndex.get(dish.category_id), name: dish.name, description: dish.description, imageUrl: dish.image_url, options: JSON.parse(dish.options_json), active: Boolean(dish.active), sortOrder: dish.sort_order }))
  };
}

function importText(value, label, max, required = false) {
  if (typeof value !== 'string') throw new Error(`${label}格式不正确`);
  const result = value.trim();
  if ((required && !result) || result.length > max) throw new Error(`${label}填写不正确`);
  return result;
}

function importSortOrder(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 100000) throw new Error('排序数据不正确');
  return value;
}

function importOptions(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('菜品规格数据不正确');
  return value.map(option => {
    if (!option || typeof option !== 'object' || !['single', 'multiple'].includes(option.type) || !Array.isArray(option.values) || !option.values.length || option.values.length > 30) throw new Error('菜品规格数据不正确');
    return { name: importText(option.name, '规格名称', 50, true), type: option.type, required: option.required === true, values: option.values.map(item => importText(item, '规格选项', 50, true)) };
  });
}

function importedMenu(value) {
  if (!value || typeof value !== 'object' || value.format !== 'family-table-menu' || value.version !== 1 || !Array.isArray(value.categories) || !Array.isArray(value.dishes)) throw new Error('不是可识别的菜单导出文件');
  if (value.categories.length > 200 || value.dishes.length > 2000) throw new Error('导入的菜单数量超过限制');
  const categories = value.categories.map((category, index) => {
    if (!category || typeof category !== 'object') throw new Error('分类数据不正确');
    return { name: importText(category.name, '分类名称', 50, true), active: category.active !== false, sortOrder: importSortOrder(category.sortOrder, index + 1) };
  });
  const dishes = value.dishes.map((dish, index) => {
    if (!dish || typeof dish !== 'object' || !Number.isInteger(dish.categoryIndex) || dish.categoryIndex < 0 || dish.categoryIndex >= categories.length) throw new Error('菜品所属分类不正确');
    return { categoryIndex: dish.categoryIndex, name: importText(dish.name, '菜品名称', 80, true), description: importText(dish.description || '', '菜品描述', 300), imageUrl: importText(dish.imageUrl || '', '图片地址', 500), options: importOptions(dish.options), active: dish.active !== false, sortOrder: importSortOrder(dish.sortOrder, index + 1) };
  });
  return { categories, dishes };
}

function importMenu(value, mode) {
  const data = importedMenu(value);
  if (!['replace', 'append'].includes(mode)) throw new Error('导入方式不正确');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      db.prepare('DELETE FROM dish_reviews').run();
      db.prepare('DELETE FROM dishes').run();
      db.prepare('DELETE FROM categories').run();
    }
    const addCategory = db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, ?)');
    const categoryIds = data.categories.map(category => Number(addCategory.run(category.name, category.sortOrder, category.active ? 1 : 0).lastInsertRowid));
    const addDish = db.prepare('INSERT INTO dishes (category_id, name, description, image_url, options_json, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const dish of data.dishes) addDish.run(categoryIds[dish.categoryIndex], dish.name, dish.description, dish.imageUrl, JSON.stringify(dish.options), dish.active ? 1 : 0, dish.sortOrder);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { categories: data.categories.length, dishes: data.dishes.length, mode };
}

function createBooking(input, kind) {
  const contactName = text(input.contactName, 50); const contactInfo = text(input.contactInfo, 100);
  const immediate = kind === 'immediate';
  if (!publicSettings().siteOpen) throw new Error('当前暂停营业，暂不接受新的点单或预约');
  const date = immediate ? new Date().toISOString().slice(0, 10) : text(input.date, 10);
  const timeSlot = immediate ? '立即点菜' : text(input.timeSlot, 10);
  const guests = immediate ? 1 : Number(input.guests);
  if (!contactName || !contactInfo || !Number.isInteger(guests) || guests < 1 || guests > 30 || (!immediate && (!date || !timeSlot))) throw new Error('请完整填写联系人、联系方式、日期、时间和人数');
  if (!immediate) {
    const availability = scheduleForDate(date); const slot = availability.slots.find(item => item.time === timeSlot);
    if (!slot || !slot.available || slot.remainingGuests < guests) throw new Error('该预约时段已满或不可用，请选择其他时间');
  }
  const items = Array.isArray(input.items) ? input.items : [];
  if ((kind === 'order' || immediate) && !items.length) throw new Error('请至少选择一道菜');
  const now = timestamp(); const code = makeCode(); const token = crypto.randomBytes(18).toString('base64url');
  const notificationItems = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const reservation = db.prepare('INSERT INTO reservations (date, time_slot, guests, status, contact_name, contact_info, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(date, timeSlot, guests, immediate ? '无需预约' : '待确认', contactName, contactInfo, text(input.note), now);
    const order = db.prepare('INSERT INTO orders (code, access_token, reservation_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(code, token, reservation.lastInsertRowid, kind, text(input.note), now);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, dish_name, quantity, note, options_json) VALUES (?, ?, ?, ?, ?)');
    for (const item of items.slice(0, 30)) {
      if (!text(item.name, 80) || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 20) throw new Error('菜品数据不正确');
      const name = text(item.name, 80); const quantity = Number(item.quantity);
      insertItem.run(order.lastInsertRowid, name, quantity, text(item.note), JSON.stringify(Array.isArray(item.options) ? item.options : []));
      notificationItems.push({ name, quantity });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { code, token, notification: { code, kind, date, timeSlot, guests, contactName, contactInfo, note: text(input.note), items: notificationItems } };
}

function listOrders() {
  const rows = db.prepare(`SELECT o.id, o.code, o.access_token, o.kind, o.status, o.note, o.created_at, r.date, r.time_slot, r.guests, r.contact_name, r.contact_info FROM orders o JOIN reservations r ON r.id = o.reservation_id ORDER BY r.date DESC, r.time_slot DESC, o.id DESC`).all();
  const itemStmt = db.prepare('SELECT dish_name, quantity, note, options_json FROM order_items WHERE order_id = ?');
  return rows.map(row => ({ ...row, items: itemStmt.all(row.id).map(item => ({ ...item, options: JSON.parse(item.options_json) })) }));
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const extension = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const headers = { 'Content-Type': types[extension] || 'application/octet-stream' };
  if (['.html', '.css', '.js'].includes(extension)) headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers); fs.createReadStream(file).pipe(res); return true;
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`); const { pathname } = url;
  try {
    if (pathname.startsWith('/uploads/')) {
      const file = path.resolve(UPLOAD_DIR, path.basename(pathname));
      if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); return; }
      return json(res, 404, { error: '图片不存在' });
    }
    if (req.method === 'GET' && pathname === '/api/setup') return json(res, 200, { complete: isSetupComplete() });
    if (req.method === 'POST' && pathname === '/api/setup') {
      if (isSetupComplete()) return json(res, 409, { error: '此站点已经完成初始化' });
      const input = await readBody(req);
      const title = text(input.title, 80);
      const password = String(input.password || '');
      if (!title) throw new Error('请输入站点名称');
      if (!password) throw new Error('请输入管理密码');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (isSetupComplete() || db.prepare('SELECT id FROM admins LIMIT 1').get()) throw new Error('此站点已经完成初始化');
        db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', hashPassword(password));
        setSetting('title', title);
        setSetting('setup_completed', '1');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 201, { ok: true });
    }
    if (!isSetupComplete()) {
      if (pathname === '/' || pathname === '/index.html') { res.writeHead(302, { Location: '/setup.html' }); res.end(); return; }
      if (pathname.startsWith('/api/')) return json(res, 409, { error: '请先完成站点初始化' });
    }
    if (req.method === 'GET' && pathname === '/api/site') return json(res, 200, publicSettings());
    if (req.method === 'GET' && pathname === '/api/menu') return json(res, 200, menu());
    if (req.method === 'GET' && /^\/api\/dishes\/\d+\/reviews$/.test(pathname)) {
      const dishId = Number(pathname.split('/')[3]);
      const reviews = db.prepare('SELECT id, author, rating, content, created_at FROM dish_reviews WHERE dish_id = ? AND visible = 1 ORDER BY created_at DESC, id DESC').all(dishId);
      const summary = db.prepare('SELECT COUNT(*) AS count, COALESCE(ROUND(AVG(rating), 1), 0) AS average FROM dish_reviews WHERE dish_id = ? AND visible = 1').get(dishId);
      return json(res, 200, { reviews, count: summary.count, average: summary.average });
    }
    if (req.method === 'POST' && /^\/api\/dishes\/\d+\/reviews$/.test(pathname)) {
      const dishId = Number(pathname.split('/')[3]); const input = await readBody(req);
      if (!db.prepare('SELECT id FROM dishes WHERE id = ?').get(dishId)) return json(res, 404, { error: '菜品不存在' });
      const rating = Number(input.rating); const author = text(input.author, 30) || '匿名'; const content = text(input.content, 300);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('请选择 1 到 5 星评分');
      if (content.length < 2) throw new Error('建议至少写两个字');
      const client = req.socket.remoteAddress || 'unknown'; const now = Date.now(); const window = reviewWindows.get(client) || [];
      const recent = window.filter(value => now - value < 15 * 60 * 1000);
      if (recent.length >= 3) return json(res, 429, { error: '请稍后再提交点评' });
      recent.push(now); reviewWindows.set(client, recent);
      const result = db.prepare('INSERT INTO dish_reviews (dish_id, author, rating, content, created_at) VALUES (?, ?, ?, ?, ?)').run(dishId, author, rating, content, timestamp());
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    if (req.method === 'GET' && pathname === '/api/availability') return json(res, 200, scheduleForDate(url.searchParams.get('date') || ''));
    if (req.method === 'GET' && pathname === '/api/lookup') {
      const order = db.prepare('SELECT id, code, kind, status, note, created_at, reservation_id FROM orders WHERE code = ? AND access_token = ?').get(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!order) return json(res, 404, { error: '未找到对应订单，请检查编号和查询凭证' });
      const reservation = db.prepare('SELECT date, time_slot, guests, contact_name, contact_info, note, status FROM reservations WHERE id = ?').get(order.reservation_id);
      const items = db.prepare('SELECT dish_name, quantity, note, options_json FROM order_items WHERE order_id = ?').all(order.id).map(item => ({ ...item, options: JSON.parse(item.options_json) }));
      return json(res, 200, { ...order, reservation, items });
    }
    if (req.method === 'POST' && (pathname === '/api/order' || pathname === '/api/immediate-order')) {
      const booking = createBooking(await readBody(req), pathname === '/api/order' ? 'order' : 'immediate');
      const { notification, ...response } = booking;
      json(res, 201, response);
      notifyWecomNewOrder(notification);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const input = await readBody(req); const user = db.prepare('SELECT password_hash FROM admins WHERE username = ?').get(text(input.username || 'admin', 50));
      if (!user || !verifyPassword(String(input.password || ''), user.password_hash)) return json(res, 401, { error: '管理密码不正确' });
      const remember = input.remember === true || input.remember === 'on'; const maxAge = remember ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
      const token = crypto.randomBytes(24).toString('base64url'); sessions.set(token, { expires: Date.now() + maxAge * 1000 });
      return json(res, 200, { ok: true }, { 'Set-Cookie': `family_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` });
    }
    if (req.method === 'POST' && pathname === '/api/admin/logout') { const token = cookies(req).family_admin; if (token) sessions.delete(token); return json(res, 200, { ok: true }, { 'Set-Cookie': 'family_admin=; HttpOnly; Path=/; Max-Age=0' }); }
    if (req.method === 'GET' && pathname === '/api/admin/me') return json(res, admin(req) ? 200 : 401, admin(req) ? { loggedIn: true } : { error: '未登录' });
    if (pathname.startsWith('/api/admin/') && !requireAdmin(req, res)) return;
    if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
      const all = listOrders(); const today = new Date().toISOString().slice(0, 10);
      return json(res, 200, { pending: all.filter(item => item.status === '待确认').length, confirmed: all.filter(item => item.status === '已确认').length, today: all.filter(item => item.date === today), recent: all.slice(0, 6) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/orders') return json(res, 200, listOrders());
    if (req.method === 'GET' && pathname === '/api/admin/review-summary') return json(res, 200, db.prepare('SELECT d.id, d.name, d.image_url, COUNT(r.id) AS review_count, COALESCE(ROUND(AVG(r.rating), 1), 0) AS average_rating, SUM(CASE WHEN r.visible = 0 THEN 1 ELSE 0 END) AS hidden_count FROM dishes d LEFT JOIN dish_reviews r ON r.dish_id = d.id GROUP BY d.id ORDER BY d.sort_order, d.id').all());
    if (req.method === 'GET' && pathname === '/api/admin/reviews') {
      const dishId = Number(url.searchParams.get('dishId'));
      const sql = dishId ? 'SELECT r.id, r.dish_id, r.author, r.rating, r.content, r.created_at, r.visible, d.name AS dish_name FROM dish_reviews r JOIN dishes d ON d.id = r.dish_id WHERE r.dish_id = ? ORDER BY r.created_at DESC, r.id DESC' : 'SELECT r.id, r.dish_id, r.author, r.rating, r.content, r.created_at, r.visible, d.name AS dish_name FROM dish_reviews r JOIN dishes d ON d.id = r.dish_id ORDER BY r.created_at DESC, r.id DESC';
      return json(res, 200, dishId ? db.prepare(sql).all(dishId) : db.prepare(sql).all());
    }
    if (req.method === 'PUT' && /^\/api\/admin\/reviews\/\d+$/.test(pathname)) {
      const input = await readBody(req); const id = Number(pathname.split('/').pop());
      if (typeof input.visible !== 'boolean') throw new Error('点评状态不正确');
      const result = db.prepare('UPDATE dish_reviews SET visible = ? WHERE id = ?').run(input.visible ? 1 : 0, id);
      if (!result.changes) return json(res, 404, { error: '点评不存在' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && /^\/api\/admin\/reviews\/\d+$/.test(pathname)) {
      const id = Number(pathname.split('/').pop()); const result = db.prepare('DELETE FROM dish_reviews WHERE id = ?').run(id);
      if (!result.changes) return json(res, 404, { error: '点评不存在' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && /^\/api\/admin\/orders\/\d+$/.test(pathname)) {
      const input = await readBody(req); const id = Number(pathname.split('/').pop()); const allowed = ['待确认', '已确认', '已完成', '已拒绝'];
      if (!allowed.includes(input.status)) throw new Error('无效状态');
      const existing = db.prepare('SELECT reservation_id, kind FROM orders WHERE id = ?').get(id); if (!existing) return json(res, 404, { error: '订单不存在' });
      db.prepare('UPDATE orders SET status = ?, note = ? WHERE id = ?').run(input.status, text(input.note), id);
      const reservationStatus = input.status === '已拒绝' ? '已拒绝' : existing.kind === 'immediate' ? '无需预约' : input.status === '待确认' ? '待确认' : '已确认';
      db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(reservationStatus, existing.reservation_id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/admin/settings') return json(res, 200, adminSettings());
    if (req.method === 'PUT' && pathname === '/api/admin/settings') {
      const input = await readBody(req);
      const textSettings = { title: ['title', 80], welcome: ['welcome', 300], logoUrl: ['logo_url', 500], faviconUrl: ['favicon_url', 500] };
      for (const [key, [settingKey, max]] of Object.entries(textSettings)) if (key in input) setSetting(settingKey, text(input[key], max));
      const webhook = text(input.wecomWebhookUrl, 1000);
      if (webhook && input.clearWecomWebhook === true) throw new Error('请只选择保存或移除企业微信 Webhook 其中一项');
      if (webhook) setSetting('wecom_webhook_url', wecomWebhookUrl(webhook));
      if (input.clearWecomWebhook === true) setSetting('wecom_webhook_url', '');
      if ('siteOpen' in input) setSetting('site_open', input.siteOpen ? '1' : '0');
      if (input.schedule) {
        const schedule = input.schedule;
        const days = Array.isArray(schedule.days) ? [...new Set(schedule.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b) : [];
        const slots = Array.isArray(schedule.slots) ? [...new Set(schedule.slots.map(value => text(value, 5)).filter(value => /^\d{2}:\d{2}$/.test(value)))].sort() : [];
        const maxPeople = Number(schedule.maxPeople); const maxOrders = Number(schedule.maxOrders); const minLeadHours = Number(schedule.minLeadHours); const maxDays = Number(schedule.maxDays);
        if (!days.length || !slots.length || !Number.isInteger(maxPeople) || maxPeople < 1 || maxPeople > 100 || !Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 100 || !Number.isInteger(minLeadHours) || minLeadHours < 0 || minLeadHours > 168 || !Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365) throw new Error('预约规则填写不正确');
        setSetting('schedule', JSON.stringify({ days, slots, maxPeople, maxOrders, minLeadHours, maxDays }));
      }
      return json(res, 200, adminSettings());
    }
    if (req.method === 'POST' && pathname === '/api/admin/wecom-webhook/test') {
      if (!setting('wecom_webhook_url', '')) throw new Error('请先保存企业微信 Webhook 地址');
      await sendWecomText(`家宴点单测试消息\n站点：${setting('title', '家宴点单')}\n企业微信新订单推送已连接成功。`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && pathname === '/api/admin/password') {
      const input = await readBody(req); const account = db.prepare('SELECT id, password_hash FROM admins WHERE username = ?').get('admin');
      const nextPassword = String(input.newPassword || '');
      if (!account || !verifyPassword(String(input.currentPassword || ''), account.password_hash)) throw new Error('当前密码不正确');
      if (!nextPassword) throw new Error('请输入新密码');
      db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(nextPassword), account.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/admin/menu-export') {
      const filename = `family-table-menu-${new Date().toISOString().slice(0, 10)}.json`;
      return json(res, 200, menuExport(), { 'Content-Disposition': `attachment; filename="${filename}"` });
    }
    if (req.method === 'POST' && pathname === '/api/admin/menu-import') {
      const input = await readBody(req);
      return json(res, 200, importMenu(input.data, input.mode));
    }
    if (req.method === 'GET' && pathname === '/api/admin/menu') return json(res, 200, { categories: db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all(), dishes: db.prepare('SELECT * FROM dishes ORDER BY sort_order, id').all().map(row => ({ ...row, options: JSON.parse(row.options_json) })) });
    if (req.method === 'PUT' && pathname === '/api/admin/categories/order') {
      const input = await readBody(req); const ids = Array.isArray(input.ids) ? input.ids.map(Number) : [];
      const existing = db.prepare('SELECT id FROM categories ORDER BY sort_order, id').all().map(row => row.id);
      if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id) || !existing.includes(id))) throw new Error('分类排序数据不正确');
      db.exec('BEGIN IMMEDIATE');
      try {
        const update = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
        ids.forEach((id, index) => update.run(index + 1, id));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && /^\/api\/admin\/categories\/\d+$/.test(pathname)) {
      const input = await readBody(req); const id = Number(pathname.split('/').pop()); const name = text(input.name, 50);
      if (!name) throw new Error('分类名称不能为空');
      const result = db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
      if (!result.changes) return json(res, 404, { error: '分类不存在' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/admin/categories') { const input = await readBody(req); const result = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(text(input.name, 50), Number(input.sortOrder || 99)); return json(res, 201, { id: Number(result.lastInsertRowid) }); }
    if (req.method === 'DELETE' && /^\/api\/admin\/categories\/\d+$/.test(pathname)) {
      const id = Number(pathname.split('/').pop()); const count = db.prepare('SELECT COUNT(*) AS count FROM dishes WHERE category_id = ?').get(id).count;
      if (count) return json(res, 409, { error: '该分类下还有菜品，请先删除或移动菜品' });
      const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      if (!result.changes) return json(res, 404, { error: '分类不存在' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/admin/dishes') { const input = await readBody(req); const result = db.prepare('INSERT INTO dishes (category_id, name, description, image_url, options_json, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(Number(input.categoryId), text(input.name, 80), text(input.description, 300), text(input.imageUrl, 500), JSON.stringify(input.options || []), input.active === false ? 0 : 1, Number(input.sortOrder || 99)); return json(res, 201, { id: Number(result.lastInsertRowid) }); }
    if (req.method === 'DELETE' && /^\/api\/admin\/dishes\/\d+$/.test(pathname)) {
      const id = Number(pathname.split('/').pop());
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM dish_reviews WHERE dish_id = ?').run(id);
        const result = db.prepare('DELETE FROM dishes WHERE id = ?').run(id);
        if (!result.changes) { db.exec('ROLLBACK'); return json(res, 404, { error: '菜品不存在' }); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && /^\/api\/admin\/dishes\/\d+$/.test(pathname)) { const input = await readBody(req); const id = Number(pathname.split('/').pop()); db.prepare('UPDATE dishes SET category_id=?, name=?, description=?, image_url=?, options_json=?, active=?, sort_order=? WHERE id=?').run(Number(input.categoryId), text(input.name, 80), text(input.description, 300), text(input.imageUrl, 500), JSON.stringify(input.options || []), input.active === false ? 0 : 1, Number(input.sortOrder || 99), id); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && pathname === '/api/admin/images') {
      const used = new Set(db.prepare("SELECT image_url FROM dishes WHERE image_url LIKE '/uploads/%'").all().map(row => row.image_url));
      const logo = setting('logo_url', ''); if (logo.startsWith('/uploads/')) used.add(logo);
      const favicon = setting('favicon_url', ''); if (favicon.startsWith('/uploads/')) used.add(favicon);
      const images = fs.readdirSync(UPLOAD_DIR).filter(name => /\.(png|jpe?g|webp)$/i.test(name)).map(name => {
        const file = path.join(UPLOAD_DIR, name); const stat = fs.statSync(file); const url = `/uploads/${name}`;
        return { name, url, size: stat.size, modifiedAt: stat.mtime.toISOString(), inUse: used.has(url) };
      }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return json(res, 200, images);
    }
    if (req.method === 'DELETE' && /^\/api\/admin\/images\/[^/]+$/.test(pathname)) {
      const name = decodeURIComponent(pathname.split('/').pop());
      if (name !== path.basename(name) || !/\.(png|jpe?g|webp)$/i.test(name)) throw new Error('图片文件名不正确');
      const file = path.join(UPLOAD_DIR, name); if (!fs.existsSync(file)) return json(res, 404, { error: '图片不存在' });
      const url = `/uploads/${name}`; const dishUses = db.prepare('SELECT COUNT(*) AS count FROM dishes WHERE image_url = ?').get(url).count;
      const logoUses = setting('logo_url', '') === url; const faviconUses = setting('favicon_url', '') === url;
      if (dishUses || logoUses || faviconUses) return json(res, 409, { error: '这张图片正在被菜品、Logo 或 Favicon 使用，暂时不能删除' });
      fs.unlinkSync(file); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/admin/upload') {
      const input = await readBody(req); const match = String(input.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/); if (!match) throw new Error('请上传 PNG、JPG 或 WebP 图片');
      const buffer = Buffer.from(match[2], 'base64'); if (buffer.length > 4 * 1024 * 1024) throw new Error('图片不能超过 4MB');
      const ext = match[1] === 'image/png' ? '.png' : match[1] === 'image/webp' ? '.webp' : '.jpg'; const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer); return json(res, 201, { url: `/uploads/${filename}` });
    }
    if (serveStatic(res, pathname)) return;
    json(res, 404, { error: '页面不存在' });
  } catch (error) { console.error(error); json(res, 400, { error: error.message || '请求处理失败' }); }
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Family Table running at http://localhost:${PORT}`));
