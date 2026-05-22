/**
 * ReviewOS — Backend Server v2.0
 * Auth + Multi-account + Reviews + Questions + AI Analytics
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const cron       = require("node-cron");
const Anthropic  = require("@anthropic-ai/sdk");
const axios      = require("axios");
const crypto     = require("crypto");
const fs         = require("fs");
const path       = require("path");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { execFile } = require("child_process");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT             || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_REVIEW_MODEL = String(process.env.ANTHROPIC_REVIEW_MODEL || "claude-sonnet-4-20250514").trim();
const JWT_SECRET    = String(process.env.JWT_SECRET || "").trim();
const JWT_EXPIRES   = "7d";
const DATA_DIR      = path.join(__dirname, "data");
const USERS_FILE    = path.join(DATA_DIR, "users.json");
const APP_ORIGIN = String(process.env.APP_ORIGIN || "").trim();
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "").trim();
const JSON_LIMIT = String(process.env.JSON_LIMIT || "1mb").trim() || "1mb";
const DATA_ENCRYPTION_KEY = String(process.env.DATA_ENCRYPTION_KEY || "").trim();
const BOOTSTRAP_ADMIN = String(process.env.BOOTSTRAP_ADMIN || "").trim().toLowerCase() === "true";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required. Add it to .env before starting ReviewOS.");
}

const secretCipherKey = DATA_ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(DATA_ENCRYPTION_KEY).digest()
  : null;

const app       = express();
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const IS_DEV = String(process.env.NODE_ENV || "").toLowerCase() !== "production";
const allowedOrigins = new Set([
  // localhost разрешён ТОЛЬКО в development. В production все origin'ы — из ALLOWED_ORIGINS/.env
  ...(IS_DEV ? ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3000", "http://127.0.0.1:3000"] : []),
  ...[APP_ORIGIN, ...ALLOWED_ORIGINS.split(",")].map((value) => String(value || "").trim()).filter(Boolean),
]);

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("CORS blocked"));
  },
  credentials: false,
}));

app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток входа. Попробуйте позже." },
});

const cycleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запусков цикла. Подождите минуту и попробуйте снова." },
});

const copilotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов к AI-помощнику. Подождите минуту." },
});

// ─── JSON хранилище ───────────────────────────────────────────────────────────
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const wj = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");

function getApiErrorStatus(error) {
  return Number(error?.response?.status || 0);
}

function getApiErrorPayload(error) {
  return error?.response?.data;
}

function formatApiErrorMessage(error) {
  const payload = getApiErrorPayload(error);
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    if (payload.error?.message) return String(payload.error.message);
    if (payload.message) {
      return payload.code !== undefined
        ? `${payload.message} (code ${payload.code})`
        : String(payload.message);
    }
    try { return JSON.stringify(payload); } catch {}
  }
  return error?.message || "Неизвестная ошибка";
}

function isOzonSubscriptionDenied(error) {
  const payload = getApiErrorPayload(error);
  const code = Number(payload?.code);
  const message = formatApiErrorMessage(error).toLowerCase();
  return code === 7 || (
    message.includes("permissiondenied") ||
    message.includes("not available with existing subscription") ||
    message.includes("permission denied")
  );
}

function isOzonPublishForbidden(error) {
  const status = getApiErrorStatus(error);
  const message = formatApiErrorMessage(error).toLowerCase();
  return status === 403 && (
    message.includes("request not allowed") ||
    message.includes("forbidden") ||
    message.includes("not allowed")
  );
}

function clampScore(value, fallback = 3) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(5, Math.round(parsed)));
}

function buildSecretHint(value) {
  const text = String(value || "").trim();
  return text ? `${text.slice(0, 8)}…` : "";
}

function encryptSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!secretCipherKey) {
    throw new Error("DATA_ENCRYPTION_KEY is required to encrypt Ozon API keys.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretCipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!text.startsWith("enc:v1:")) return text;
  if (!secretCipherKey) {
    throw new Error("DATA_ENCRYPTION_KEY is required to decrypt stored Ozon API keys.");
  }
  const [, , ivB64, tagB64, encryptedB64] = text.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretCipherKey,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function getUsers() { return rj(USERS_FILE, []); }
function stripRuntimeSecrets(user) {
  if (!user || typeof user !== "object") return user;
  const clean = { ...user };
  delete clean.ozon_api_key;
  delete clean.wb_api_key;
  delete clean.openrouter_api_key;
  return clean;
}
function saveUsers(u) { wj(USERS_FILE, (u || []).map(stripRuntimeSecrets)); }
function hydrateUserSecrets(user) {
  if (!user) return user;
  const out = { ...user };
  if (user.ozon_api_key_encrypted) out.ozon_api_key = decryptSecret(user.ozon_api_key_encrypted);
  if (user.wb_api_key_encrypted) out.wb_api_key = decryptSecret(user.wb_api_key_encrypted);
  if (user.openrouter_api_key_encrypted) out.openrouter_api_key = decryptSecret(user.openrouter_api_key_encrypted);
  return out;
}
function getUserById(id) { return hydrateUserSecrets(getUsers().find(u => u.id === id)); }
function getUserByEmail(email) { return hydrateUserSecrets(getUsers().find(u => u.email && u.email.toLowerCase() === String(email || "").toLowerCase())); }
function normalizeEmailInput(value) { return String(value || "").trim().toLowerCase(); }
function sanitizeNameInput(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120); }
function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function migrateUserApiKeysIfNeeded() {
  const users = getUsers();
  let changed = false;
  for (const user of users) {
    if (user.ozon_api_key && !user.ozon_api_key_encrypted) {
      user.ozon_api_key_encrypted = encryptSecret(user.ozon_api_key);
      user.ozon_api_key_hint = buildSecretHint(user.ozon_api_key);
      delete user.ozon_api_key;
      changed = true;
    }
  }
  if (changed) {
    saveUsers(users);
    console.log("🔐 Migrated stored Ozon API keys to encrypted format.");
  }
}

const userDir  = (uid) => { const d = path.join(DATA_DIR, "users", uid); fs.mkdirSync(d, { recursive: true }); return d; };
const userFile = (uid, name) => path.join(userDir(uid), name + ".json");

const getUserData = (uid, name, def) => rj(userFile(uid, name), def);
const setUserData = (uid, name, val) => wj(userFile(uid, name), val);

function updateUserRecord(uid, key, patch) {
  const list = getUserData(uid, key, []);
  const idField = key === "reviews" ? "review_uuid" : "question_id";
  const i = list.findIndex(r => r[idField] === patch[idField]);
  if (i >= 0) { list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() }; }
  else list.unshift({ ...patch, created_at: new Date().toISOString() });
  setUserData(uid, key, list);
}

function addUserLog(uid, message, type = "info") {
  const logs = getUserData(uid, "logs", []);
  logs.push({ id: Date.now(), message, type, created_at: new Date().toISOString() });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  setUserData(uid, "logs", logs);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "Не авторизован" });
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = getUserById(decoded.id);
    if (!req.user) return res.status(401).json({ error: "Пользователь не найден" });
    next();
  } catch { return res.status(401).json({ error: "Токен недействителен" }); }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Нет доступа" });
    next();
  });
}

// ─── Ozon API ────────────────────────────────────────────────────────────────
async function ozonReq(endpoint, body, cid, key) {
  const r = await axios.post(`https://api-seller.ozon.ru${endpoint}`, body, {
    headers: { "Client-Id": cid, "Api-Key": key, "Content-Type": "application/json" },
    timeout: 15000,
  });
  return r.data;
}

async function fetchReviews(cid, key) {
  let all = [], lastId = null;
  while (true) {
    const body = { sort_dir: "DESC", limit: 100, with_photo: false };
    if (lastId) body.last_id = lastId;
    const d = await ozonReq("/v1/review/list", body, cid, key);
    const batch = d.reviews || [];
    if (!batch.length) break;
    all = all.concat(batch.map(r => ({
      review_uuid: r.uuid || r.id, sku: r.sku,
      author: r.author?.name || "Аноним", rating: r.rating || 3,
      text: r.text || "", published_at: r.published_at,
      hasResponse: !!(r.response?.text),
    })));
    lastId = d.last_id;
    if (!lastId || batch.length < 100) break;
  }
  return all;
}

async function fetchQuestions(cid, key) {
  let all = [], lastId = null;
  while (true) {
    const body = { sort_dir: "DESC", limit: 100 };
    if (lastId) body.last_id = lastId;
    const d = await ozonReq("/v1/question/list", body, cid, key);
    const batch = d.questions || [];
    if (!batch.length) break;
    all = all.concat(batch.map(q => ({
      question_id: q.id, sku: q.sku,
      author: q.author_name || "Покупатель",
      text: q.text || "", product_url: q.product_url || "",
      published_at: q.published_at, hasAnswer: q.answers_count > 0,
    })));
    lastId = d.last_id;
    if (!lastId || batch.length < 100) break;
  }
  return all;
}

async function postReviewResp(cid, key, uuid, text) {
  return ozonReq("/v1/review/comment/create", { review_id: uuid, text, mark_review_as_processed: true }, cid, key);
}

async function postQuestionAns(cid, key, qid, sku, text) {
  return ozonReq("/v1/question/answer/create", { question_id: qid, sku: Number(sku), text }, cid, key);
}

// ─── Ozon Chat API (диалоги с покупателями) ──────────────────────────────────
const OZON_CHAT_LIST_CACHE = new Map(); // запоминаем рабочий вариант между вызовами (cid → endpoint)

async function fetchOzonChatList(cid, key, { limit = 100, cursor = "", status = "All" } = {}) {
  // Если уже знаем рабочий вариант — используем его (важно для пагинации).
  const cacheKey = String(cid);
  if (OZON_CHAT_LIST_CACHE.has(cacheKey) && cursor) {
    const cached = OZON_CHAT_LIST_CACHE.get(cacheKey);
    const body = { ...cached.bodyTpl, limit, cursor: String(cursor || "") };
    return ozonReq(cached.path, body, cid, key);
  }

  const attempts = [
    { path: "/v3/chat/list", bodyTpl: { filter: { chat_status: status } } },
    { path: "/v3/chat/list", bodyTpl: { filter: {} } },
    { path: "/v3/chat/list", bodyTpl: {} },
    { path: "/v2/chat/list", bodyTpl: { chat_id_list: [], page: 1 } },
    { path: "/v2/chat/list", bodyTpl: { offset: 0 } },
    { path: "/v1/chat/list", bodyTpl: { offset: 0 } },
  ];
  let lastErr = null, lastEmpty = null;
  for (const a of attempts) {
    try {
      const body = { ...a.bodyTpl, limit, cursor: String(cursor || "") };
      const r = await ozonReq(a.path, body, cid, key);
      const list = r?.chats || r?.result?.chats || r?.result || [];
      if (Array.isArray(list) && list.length > 0) {
        OZON_CHAT_LIST_CACHE.set(cacheKey, a);
        return { ...r, _attempt: a.path };
      }
      lastEmpty = { ...r, _attempt: a.path };
    } catch (e) {
      lastErr = e;
      if (isOzonSubscriptionDenied(e)) throw e;
    }
  }
  if (lastEmpty) return lastEmpty;
  if (lastErr) throw lastErr;
  return { chats: [] };
}
async function fetchOzonChatHistory(cid, key, chatId, { limit = 100, fromMessageId = "" } = {}) {
  const body = { chat_id: String(chatId), limit, direction: "Backward" };
  if (fromMessageId) body.from_message_id = String(fromMessageId);
  return ozonReq("/v3/chat/history", body, cid, key);
}
async function sendOzonChatMessage(cid, key, chatId, text) {
  return ozonReq("/v1/chat/send/message", { chat_id: String(chatId), text: String(text || "") }, cid, key);
}
async function markOzonChatRead(cid, key, chatId, fromMessageId) {
  return ozonReq("/v1/chat/read", { chat_id: String(chatId), from_message_id: String(fromMessageId || "") }, cid, key);
}

// ─── Ozon product cards (для точных ответов на вопросы) ──────────────────────
const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchProductInfoBySkus(cid, key, skus) {
  if (!skus.length) return [];
  const body = { sku: skus.map((s) => String(s)).filter(Boolean) };
  if (!body.sku.length) return [];
  const d = await ozonReq("/v3/product/info/list", body, cid, key);
  return (d?.items || d?.result?.items || []).filter(Boolean);
}

async function fetchProductAttributes(cid, key, productIds) {
  if (!productIds.length) return [];
  const body = {
    filter: { product_id: productIds.map((id) => String(id)).filter(Boolean), visibility: "ALL" },
    limit: 100,
  };
  if (!body.filter.product_id.length) return [];
  const d = await ozonReq("/v4/product/info/attributes", body, cid, key);
  return d?.result || [];
}

async function fetchProductDescription(cid, key, productId, offerId) {
  const body = {};
  if (productId) body.product_id = Number(productId);
  if (offerId) body.offer_id = String(offerId);
  if (!body.product_id && !body.offer_id) return null;
  try {
    const d = await ozonReq("/v1/product/info/description", body, cid, key);
    return d?.result || null;
  } catch (e) {
    return null;
  }
}

function stripHtmlText(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenAttributeEntry(entry) {
  if (!entry) return null;
  const attrs = [];
  for (const a of entry.attributes || []) {
    const values = (a.values || [])
      .map((v) => (v && (v.value || v.dictionary_value_id != null)) ? String(v.value || "").trim() : "")
      .filter(Boolean);
    if (!values.length) continue;
    attrs.push({
      attribute_id: a.attribute_id ?? a.id ?? null,
      complex_id: a.complex_id ?? 0,
      values,
    });
  }
  return attrs;
}

function getUserProducts(uid) { return getUserData(uid, "products", {}); }
function setUserProducts(uid, products) { return setUserData(uid, "products", products); }

async function ensureProductData(uid, cid, key, skus, { force = false } = {}) {
  const cache = getUserProducts(uid);
  const now = Date.now();
  const uniqSkus = Array.from(new Set((skus || []).map((s) => String(s)).filter((s) => s && s !== "0")));
  const stale = uniqSkus.filter((sku) => {
    if (force) return true;
    const e = cache[sku];
    if (!e) return true;
    if (!e.fetched_at) return true;
    return (now - new Date(e.fetched_at).getTime()) > PRODUCT_CACHE_TTL_MS;
  });
  if (!stale.length) return cache;

  for (let i = 0; i < stale.length; i += 100) {
    const batch = stale.slice(i, i + 100);

    let items = [];
    try {
      items = await fetchProductInfoBySkus(cid, key, batch);
    } catch (e) {
      addUserLog(uid, `⚠️ Не удалось получить инфо по товарам Ozon: ${formatApiErrorMessage(e)}`, "warn");
      continue;
    }

    const productIds = [];
    for (const it of items) {
      const sku = String(it.sku ?? it.fbo_sku ?? it.fbs_sku ?? it.id ?? "");
      if (!sku) continue;
      const entry = cache[sku] || {};
      entry.sku = sku;
      entry.product_id = it.id || it.product_id || entry.product_id;
      entry.offer_id = it.offer_id || entry.offer_id;
      entry.name = it.name || entry.name;
      entry.fetched_at = new Date().toISOString();
      cache[sku] = entry;
      if (entry.product_id) productIds.push(entry.product_id);
    }

    let attributeResults = [];
    try {
      attributeResults = await fetchProductAttributes(cid, key, productIds);
    } catch (e) {
      attributeResults = [];
    }
    const attrsByProductId = new Map();
    for (const r of attributeResults) {
      const pid = String(r.id || r.product_id || "");
      if (!pid) continue;
      attrsByProductId.set(pid, flattenAttributeEntry(r));
    }

    for (const sku of batch) {
      const entry = cache[sku];
      if (!entry) continue;
      const pid = String(entry.product_id || "");
      if (pid && attrsByProductId.has(pid)) entry.attributes = attrsByProductId.get(pid);
      const desc = await fetchProductDescription(cid, key, entry.product_id, entry.offer_id);
      if (desc) {
        if (desc.name && !entry.name) entry.name = desc.name;
        if (desc.description) entry.description = stripHtmlText(desc.description).slice(0, 6000);
      }
    }
  }

  setUserProducts(uid, cache);
  return cache;
}

// ─── Тональность ответов (пресеты промпта) ───────────────────────────────────
const TONE_PRESETS = {
  friendly: {
    label: "Дружелюбный",
    description: "Тёплый разговорный тон, лёгкие эмодзи. Подходит большинству позитивных и нейтральных ситуаций.",
    persona: "продавец, относящийся к покупателям как к старым знакомым",
    rules: [
      "Пиши тёплым, дружелюбным тоном.",
      "Можно использовать 1–2 уместных эмодзи (без перебора).",
      "Обращайся на «вы», но без излишней формальности.",
      "Если благодарят — отвечай искренне, не штампами.",
    ],
  },
  formal: {
    label: "Формально-деловой",
    description: "Сдержанный официальный стиль без эмодзи. Подходит для серьёзных категорий и бизнес-аудитории.",
    persona: "представитель магазина в деловом стиле",
    rules: [
      "Сухой деловой тон, без эмодзи и сленга.",
      "Обращайся на «вы». Полные грамотные предложения.",
      "Если есть проблема — конкретное предложение решения.",
      "Никаких восклицаний и междометий.",
    ],
  },
  caring: {
    label: "Забота и эмпатия",
    description: "Подчёркнутая внимательность к клиенту. Лучше всего для негативных отзывов и претензий.",
    persona: "менеджер по работе с клиентами, который искренне хочет помочь",
    rules: [
      "Покажи, что слышишь и понимаешь чувства покупателя.",
      "Принеси извинения по сути (без публичного признания вины компании).",
      "Предложи конкретный способ решения: написать в личные сообщения, оформить возврат, отправить замену.",
      "Не используй шаблонные канцеляризмы вроде «нам очень жаль». Пиши по-человечески.",
    ],
  },
  brief: {
    label: "Короткий и деловой",
    description: "Минимум слов, прямо по делу — 1–2 предложения, без приветствий и подписи.",
    persona: "представитель продавца, отвечающий лаконично",
    rules: [
      "Только суть. Максимум 1–2 коротких предложения.",
      "Без воды, эмодзи и приветствий вроде «Здравствуйте!».",
      "Конкретный ответ или конкретное действие.",
    ],
  },
  sales: {
    label: "Продающий",
    description: "Положительный тон с тонкой допродажей: упоминание других товаров магазина или акции (без навязчивости).",
    persona: "продавец, который умеет благодарить и мягко возвращать клиентов в магазин",
    rules: [
      "Поблагодари искренне, без штампов.",
      "В конце дай мягкий call-to-action: загляните в магазин, посмотрите другие модели, подпишитесь на бренд.",
      "Не превращай ответ в рекламу — допродажа должна занимать не более 1 короткого предложения.",
      "Можно 1 уместный эмодзи.",
    ],
  },
  custom: {
    label: "Свой промпт",
    description: "Полностью пользовательский prompt. Используется текст из поля «Свой промпт» в Settings.",
    persona: null,
    rules: null,
  },
};
const DEFAULT_TONE_ID = "friendly";

function getTonePreset(id) {
  return TONE_PRESETS[id] || TONE_PRESETS[DEFAULT_TONE_ID];
}

function buildToneInstructions(user, kind = "review") {
  const id = String(user?.ai_tone_preset || DEFAULT_TONE_ID);
  if (id === "custom") {
    const custom = String(user?.ai_tone_custom || "").trim();
    if (custom) return `Тон ответа (custom): ${custom}`;
  }
  const preset = getTonePreset(id);
  const lines = [`Тон ответа: ${preset.label}.`];
  if (preset.persona) lines.push(`Роль: ты — ${preset.persona}.`);
  if (preset.rules && preset.rules.length) {
    lines.push("Правила стиля:");
    for (const r of preset.rules) lines.push(`- ${r}`);
  }
  if (kind === "question") {
    lines.push("Это ответ на ВОПРОС покупателя — отвечай по существу вопроса, не превращай в благодарственный отзыв-ответ.");
  } else {
    lines.push("Это ответ на ОТЗЫВ покупателя — учитывай его эмоциональный окрас.");
  }
  return lines.join("\n");
}

// ─── Wildberries public API (бесплатные эндпоинты, без авторизации) ─────────
const WB_DEST = String(process.env.WB_DEST || "-1257786");
const WB_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseWbNmId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d{4,}$/.test(s)) return Number(s);
  const patterns = [
    /\/catalog\/(\d+)\/detail\.aspx/i,
    /\/product\/(\d+)/i,
    /[?&]nm=(\d+)/i,
    /[?&]id=(\d{6,})/i,
    /(\d{6,})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function wbGet(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS", "--compressed", "--max-time", "20",
      "-w", "\n__HTTP_STATUS__:%{http_code}",
      "-H", `User-Agent: ${WB_USER_AGENT}`,
      "-H", "Accept: */*",
      "-H", "Accept-Language: ru-RU,ru;q=0.9,en;q=0.8",
      "-H", "Origin: https://www.wildberries.ru",
      "-H", "Referer: https://www.wildberries.ru/",
      url,
    ];
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`curl: ${err.message}${stderr ? " | " + stderr.trim() : ""}`));
      const m = stdout.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      const body = m ? stdout.slice(0, m.index) : stdout;
      let data;
      try { data = JSON.parse(body); } catch { data = body; }
      resolve({ status, data });
    });
  });
}

async function fetchWbCard(nmId) {
  const hosts = ["card.wb.ru", "u-card.wb.ru"];
  let lastStatus = null;
  let r = null;
  for (const host of hosts) {
    const url = `https://${host}/cards/v4/detail?appType=1&curr=rub&dest=${encodeURIComponent(WB_DEST)}&spp=30&nm=${nmId}`;
    try {
      r = await wbGet(url);
      lastStatus = r.status;
      if (r.status === 200) break;
    } catch (e) {
      lastStatus = `network: ${e.message}`;
    }
  }
  if (!r || r.status !== 200) throw new Error(`WB card.wb.ru вернул HTTP ${lastStatus}`);
  const products = r.data?.products || r.data?.data?.products || [];
  const item = products.find((p) => Number(p.id) === Number(nmId)) || products[0];
  if (!item) throw new Error("WB не вернул карточку для указанного nm_id (нет в продаже либо невалидный id)");
  const toRub = (v) => (Number(v) > 0 ? Number(v) / 100 : null);
  let priceRub = null, basicRub = null;
  for (const s of item.sizes || []) {
    const pr = s?.price;
    if (pr && Number(pr.product) > 0) {
      const candidate = Number(pr.product);
      if (priceRub == null || candidate < priceRub * 100) {
        priceRub = toRub(pr.product);
        basicRub = toRub(pr.basic || pr.product);
      }
    }
  }
  if (priceRub == null) {
    for (const s of item.sizes || []) {
      for (const st of s.stocks || []) {
        if (st && Number(st.price) > 0) {
          const candidate = Number(st.price);
          if (priceRub == null || candidate < priceRub * 100) {
            priceRub = toRub(st.price);
            basicRub = toRub(st.basicPrice || st.price);
          }
        }
      }
    }
  }
  return {
    nm_id: Number(item.id),
    imt_id: Number(item.root || item.imt_id || 0) || null,
    name: item.name || "",
    brand: item.brand || "",
    supplier: item.supplier || "",
    supplier_id: item.supplierId || null,
    rating: Number(item.reviewRating || item.nmReviewRating || item.rating || 0) || 0,
    feedbacks: Number(item.feedbacks || item.nmFeedbacks || 0) || 0,
    price: priceRub,
    base_price: basicRub,
    promo_text: item.promoTextCard || item.promoTextCat || "",
    sale: Number(item.sale || 0) || 0,
    sizes: (item.sizes || []).map((s) => s.origName || s.name).filter(Boolean),
    colors: (item.colors || []).map((c) => c.name).filter(Boolean),
  };
}

async function fetchWbBasketCard(nmId) {
  const vol = Math.floor(nmId / 1e5);
  const part = Math.floor(nmId / 1e3);
  const tryBasket = async (num) => {
    const n = String(num).padStart(2, "0");
    const hosts = [`basket-${n}.wbbasket.ru`, `basket-${n}.wb.ru`];
    for (const host of hosts) {
      const url = `https://${host}/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
      try {
        const r = await wbGet(url);
        if (r.status === 200 && r.data) return r.data;
      } catch (e) {}
    }
    return null;
  };
  const candidates = [];
  for (let i = 1; i <= 50; i++) candidates.push(i);
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const results = await Promise.all(batch.map(tryBasket));
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

function normalizeWbBasket(data) {
  if (!data) return null;
  const characteristics = [];
  const groups = data.grouped_options || data.groupedOptions || [];
  for (const g of groups) {
    for (const opt of g.options || []) {
      if (opt?.name && opt?.value != null) {
        characteristics.push({
          group: g.group_name || g.groupName || "",
          name: String(opt.name),
          value: String(opt.value),
        });
      }
    }
  }
  for (const opt of data.options || []) {
    if (opt?.name && opt?.value != null && !characteristics.find((c) => c.name === opt.name)) {
      characteristics.push({ group: "", name: String(opt.name), value: String(opt.value) });
    }
  }
  return {
    imt_id: Number(data.imt_id || data.imtId || 0) || null,
    subj_name: data.subj_name || data.subjName || "",
    subj_root_name: data.subj_root_name || data.subjRootName || "",
    description: String(data.description || ""),
    characteristics,
  };
}

async function fetchWbFeedbacks(imtId, { maxReviews = 500 } = {}) {
  if (!imtId) return [];
  const limit = Math.max(10, Math.min(maxReviews, 1000));
  const endpoints = [
    `https://feedbacks1.wb.ru/feedbacks/v2/${imtId}`,
    `https://feedbacks2.wb.ru/feedbacks/v2/${imtId}`,
    `https://feedbacks1.wb.ru/feedbacks/v1/${imtId}`,
    `https://feedbacks2.wb.ru/feedbacks/v1/${imtId}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await wbGet(url);
      if (r.status === 200 && r.data && Array.isArray(r.data.feedbacks) && r.data.feedbacks.length) {
        return r.data.feedbacks.slice(0, limit).map((f) => ({
          id: String(f.id || ""),
          rating: Number(f.productValuation || f.valuation || 0) || 0,
          text: String(f.text || "").trim(),
          pros: String(f.pros || "").trim(),
          cons: String(f.cons || "").trim(),
          color: f.color || "",
          size: f.size || "",
          created_at: f.createdDate || "",
          updated_at: f.updatedDate || "",
          photo_count: Array.isArray(f.photo) ? f.photo.length : 0,
          author: f.wbUserDetails?.name || f.wbUserDetails?.fullName || "",
        }));
      }
    } catch (e) {}
  }
  return [];
}

function getUserWbCards(uid) { return getUserData(uid, "wb-cards", {}); }
function setUserWbCards(uid, cards) { return setUserData(uid, "wb-cards", cards); }

async function ensureWbCard(uid, input, { force = false, maxReviews = 300 } = {}) {
  const nmId = parseWbNmId(input);
  if (!nmId) throw new Error("Не удалось распознать nm_id Wildberries (введите ссылку или артикул).");
  const cache = getUserWbCards(uid);
  const existing = cache[nmId];
  const ageMs = existing?.fetched_at ? Date.now() - new Date(existing.fetched_at).getTime() : Infinity;
  const fresh = ageMs < WB_CACHE_TTL_MS;
  const missingPrice = existing && existing.price == null;
  if (existing && fresh && !missingPrice && !force) return existing;

  const [card, basketRaw] = await Promise.all([fetchWbCard(nmId), fetchWbBasketCard(nmId)]);
  const basket = normalizeWbBasket(basketRaw);
  const imtId = basket?.imt_id || card.imt_id || null;
  const reviews = imtId ? await fetchWbFeedbacks(imtId, { maxReviews }) : [];

  const entry = {
    nm_id: nmId,
    imt_id: imtId,
    name: card.name || basket?.subj_name || "",
    brand: card.brand,
    supplier: card.supplier,
    supplier_id: card.supplier_id,
    rating: card.rating,
    feedbacks: card.feedbacks,
    price: card.price,
    base_price: card.base_price,
    promo_text: card.promo_text,
    sale: card.sale,
    sizes: card.sizes,
    colors: card.colors,
    subj_name: basket?.subj_name || "",
    subj_root_name: basket?.subj_root_name || "",
    description: basket?.description || "",
    characteristics: basket?.characteristics || [],
    reviews,
    reviews_count: reviews.length,
    fetched_at: new Date().toISOString(),
  };
  // ВАЖНО: перечитываем кеш с диска перед записью — на случай если параллельный запрос
  // успел добавить другую карточку, пока мы ходили в WB сеть
  const fresh_cache = getUserWbCards(uid);
  fresh_cache[String(nmId)] = entry;
  setUserWbCards(uid, fresh_cache);
  return entry;
}

// ─── Wildberries Seller API (приватные эндпоинты, требуют токен продавца) ───
// Production: https://feedbacks-api.wildberries.ru — реальные отзывы продавца, строгие лимиты
// Sandbox:    https://feedbacks-api-sandbox.wildberries.ru — тестовая среда WB, отдельный токен,
//             фейковые отзывы/вопросы. Можно дёргать без банов — для разработки и тестов.
//
// Переключение per-user: ставь `user.wb_use_sandbox = true` в data/users.json или через UI
const WB_SELLER_BASE_PROD = "https://feedbacks-api.wildberries.ru";
const WB_SELLER_BASE_SANDBOX = "https://feedbacks-api-sandbox.wildberries.ru";
function wbSellerBase(user) {
  return (user && user.wb_use_sandbox === true) ? WB_SELLER_BASE_SANDBOX : WB_SELLER_BASE_PROD;
}
const WB_SELLER_BASE = WB_SELLER_BASE_PROD; // legacy fallback

// Persistent WB ban tracker — переживает рестарт сервера
const WB_BAN_FILE = path.join(DATA_DIR, "wb-bans.json");
function _wbHash(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 16); }
function _loadBans() { return rj(WB_BAN_FILE, {}); }
function _saveBans(b) { wj(WB_BAN_FILE, b); }
function wbBanRemainingSec(token) {
  const h = _wbHash(token);
  const bans = _loadBans();
  const until = bans[h] || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
function wbBanSet(token, sec) {
  const h = _wbHash(token);
  const bans = _loadBans();
  bans[h] = Date.now() + sec * 1000;
  _saveBans(bans);
}
function wbBanClear(token) {
  const h = _wbHash(token);
  const bans = _loadBans();
  delete bans[h];
  _saveBans(bans);
}

async function wbSellerRequest(token, method, path, { params, body, _retry, baseUrl } = {}) {
  if (!token) throw new Error("Не настроен WB API ключ");
  // Если уже в бане — сразу ошибка, не дёргаем WB
  const banLeft = wbBanRemainingSec(token);
  if (banLeft > 0) {
    const err = new Error(`WB лимит запросов: подождите ${banLeft} сек (бан WB активен).`);
    err.code = "wb_rate_limit";
    err.retryAfter = banLeft;
    throw err;
  }
  const url = new URL((baseUrl || WB_SELLER_BASE) + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const r = await axios({
    method,
    url: url.toString(),
    headers: { Authorization: token, "Content-Type": "application/json" },
    data: body || undefined,
    timeout: 20000,
    validateStatus: () => true,
  });
  if (r.status === 401 || r.status === 403) throw new Error("WB API ключ невалиден или нет прав");
  if (r.status === 429) {
    // WB присылает retry-after в нескольких вариантах. Доверяем заголовку x-ratelimit-reset
    // (это реальное время до сброса), а retry-after может быть просто «60» по умолчанию.
    const xReset = Number(r.headers?.["x-ratelimit-reset"]) || 0;
    const retryAfter = Number(r.headers?.["retry-after"]) || 0;
    const msgMatch = Number(String(r.data?.detail || r.data?.message || "").match(/(\d+)\s*(сек|sec|s\b)/i)?.[1]) || 0;
    // Максимум из явных источников (если они есть). Если все 0 — fallback 90 сек.
    const fromWb = Math.max(xReset, retryAfter, msgMatch);
    const effective = fromWb > 0 ? Math.min(fromWb, 30 * 60) : 90;
    wbBanSet(token, effective);
    const min = Math.floor(effective / 60), sec = effective % 60;
    const human = min > 0 ? `${min} мин${sec ? " " + sec + " сек" : ""}` : `${sec} сек`;
    const err = new Error(`WB ограничил API на ${human}. Это бан со стороны WB по seller/session — пересоздание токена не помогает (sid тот же). Подождите.`);
    err.code = "wb_rate_limit";
    err.retryAfter = effective;
    throw err;
  }
  if (r.status >= 400) {
    const msg = r.data?.errorText || r.data?.error || r.data?.message || r.data?.detail || JSON.stringify(r.data).slice(0, 200);
    throw new Error(`WB Seller API ${r.status}: ${msg}`);
  }
  return r.data;
}

function normalizeWbSellerFeedback(f) {
  return {
    review_id: String(f.id || ""),
    rating: Number(f.productValuation || 0) || 0,
    text: String(f.text || "").trim(),
    pros: String(f.pros || "").trim(),
    cons: String(f.cons || "").trim(),
    color: f.color || "",
    size: f.size || "",
    matching_size: f.matchingSize || "",
    is_answered: !!f.isAnswered || !!f.answer,
    existing_answer: f.answer?.text || "",
    product: {
      nm_id: f.productDetails?.nmId || f.nmId || null,
      name: f.productDetails?.productName || "",
      supplier_article: f.productDetails?.supplierArticle || "",
      brand: f.productDetails?.brandName || "",
      imt_id: f.productDetails?.imtId || null,
    },
    created_at: f.createdDate || "",
    user_name: f.userName || "",
  };
}

function normalizeWbSellerQuestion(q) {
  return {
    question_id: String(q.id || ""),
    text: String(q.text || "").trim(),
    is_answered: !!q.answer || q.state === "wbRu" || q.state === "suppliersPortalSynge",
    existing_answer: q.answer?.text || "",
    product: {
      nm_id: q.productDetails?.nmId || q.nmId || null,
      name: q.productDetails?.productName || "",
      supplier_article: q.productDetails?.supplierArticle || "",
      brand: q.productDetails?.brandName || "",
      imt_id: q.productDetails?.imtId || null,
    },
    created_at: q.createdDate || "",
    user_name: q.userName || "",
    state: q.state || "",
  };
}

async function fetchWbSellerFeedbacks(token, { isAnswered = false, take = 100, skip = 0, baseUrl } = {}) {
  const data = await wbSellerRequest(token, "GET", "/api/v1/feedbacks", {
    params: { isAnswered: String(isAnswered), take, skip, order: "dateDesc" },
    baseUrl,
  });
  const arr = data?.data?.feedbacks || data?.feedbacks || [];
  return { items: arr.map(normalizeWbSellerFeedback), total: Number(data?.data?.countUnanswered || data?.data?.countArchive || arr.length) };
}

async function fetchWbSellerQuestions(token, { isAnswered = false, take = 100, skip = 0, baseUrl } = {}) {
  const data = await wbSellerRequest(token, "GET", "/api/v1/questions", {
    params: { isAnswered: String(isAnswered), take, skip, order: "dateDesc" },
    baseUrl,
  });
  const arr = data?.data?.questions || data?.questions || [];
  return { items: arr.map(normalizeWbSellerQuestion), total: Number(data?.data?.countUnanswered || data?.data?.countArchive || arr.length) };
}

// (старая пагинация удалена — слишком агрессивная, WB банит за серии запросов.
//  Sync теперь делает ОДИН запрос с take=200 на тип, см. syncWbSellerFeedbacks/Questions)

async function postWbSellerFeedbackAnswer(token, feedbackId, text) {
  return wbSellerRequest(token, "POST", "/api/v1/feedbacks/answer", {
    body: { id: String(feedbackId), text: String(text || "") },
  });
}

async function postWbSellerQuestionAnswer(token, questionId, text) {
  return wbSellerRequest(token, "PATCH", "/api/v1/questions", {
    body: { id: String(questionId), answer: { text: String(text || "") }, state: "wbRu" },
  });
}

function getUserWbFeedbacksStore(uid) { return getUserData(uid, "wb-feedbacks", []); }
function setUserWbFeedbacksStore(uid, list) { return setUserData(uid, "wb-feedbacks", list); }
function getUserWbQuestionsStore(uid) { return getUserData(uid, "wb-questions", []); }
function setUserWbQuestionsStore(uid, list) { return setUserData(uid, "wb-questions", list); }

function getUserChatsStore(uid) { return getUserData(uid, "chats", { index: [], threads: {} }); }
function setUserChatsStore(uid, store) { return setUserData(uid, "chats", store); }

async function syncWbSellerFeedbacks(uid, token, { includeAnswered = false, baseUrl } = {}) {
  // ВАЖНО: WB агрессивно банит за серии запросов. Делаем ОДИН запрос с take=200.
  const { items: unanswered } = await fetchWbSellerFeedbacks(token, { isAnswered: false, take: 200, skip: 0, baseUrl });
  let answered = [];
  if (includeAnswered) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetchWbSellerFeedbacks(token, { isAnswered: true, take: 200, skip: 0, baseUrl });
    answered = res.items;
  }
  const fresh = [...unanswered, ...answered];
  const existing = getUserWbFeedbacksStore(uid);
  const byId = new Map(existing.map((x) => [x.review_id, x]));
  let added = 0;
  for (const f of fresh) {
    if (!byId.has(f.review_id)) {
      existing.unshift({ ...f, ai_response: "", status: f.is_answered ? "posted" : "pending", source: "wb", created_locally_at: new Date().toISOString() });
      byId.set(f.review_id, existing[0]);
      added++;
    } else {
      const e = byId.get(f.review_id);
      e.text = f.text; e.pros = f.pros; e.cons = f.cons; e.rating = f.rating;
      e.is_answered = f.is_answered;
      if (f.is_answered && f.existing_answer && !e.ai_response) e.ai_response = f.existing_answer;
      if (f.is_answered) e.status = "posted";
      e.product = f.product;
    }
  }
  setUserWbFeedbacksStore(uid, existing.slice(0, 5000));
  return { added, total_remote: fresh.length, total_local: existing.length, unanswered: unanswered.length, answered: answered.length };
}

async function syncWbSellerQuestions(uid, token, { includeAnswered = false, baseUrl } = {}) {
  const { items: unanswered } = await fetchWbSellerQuestions(token, { isAnswered: false, take: 200, skip: 0, baseUrl });
  let answered = [];
  if (includeAnswered) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetchWbSellerQuestions(token, { isAnswered: true, take: 200, skip: 0, baseUrl });
    answered = res.items;
  }
  const fresh = [...unanswered, ...answered];
  const existing = getUserWbQuestionsStore(uid);
  const byId = new Map(existing.map((x) => [x.question_id, x]));
  let added = 0;
  for (const q of fresh) {
    if (!byId.has(q.question_id)) {
      existing.unshift({ ...q, ai_response: "", status_ai: q.is_answered ? "posted" : "pending", source: "wb", created_locally_at: new Date().toISOString() });
      byId.set(q.question_id, existing[0]);
      added++;
    } else {
      const e = byId.get(q.question_id);
      e.text = q.text; e.is_answered = q.is_answered;
      if (q.is_answered && q.existing_answer && !e.ai_response) e.ai_response = q.existing_answer;
      if (q.is_answered) e.status_ai = "posted";
      e.product = q.product;
    }
  }
  setUserWbQuestionsStore(uid, existing.slice(0, 5000));
  return { added, total_remote: fresh.length, total_local: existing.length, unanswered: unanswered.length, answered: answered.length };
}

// ─── Chats: Ozon sync + storage ──────────────────────────────────────────────
function normalizeOzonChatThread(raw) {
  // v3 формат: { chat: {chat_id, chat_status, chat_type, created_date}, last_message_id, unread_count, first_unread_message_id }
  // v2/old формат: { chat_id, chat_status, created_at, customer_name, last_message_text, ... }
  const chat = raw.chat || raw;
  return {
    chat_id: String(chat.chat_id || raw.chat_id || raw.id || ""),
    chat_status: chat.chat_status || raw.chat_status || raw.status || "Opened",
    chat_type: chat.chat_type || raw.chat_type || raw.type || "Buyer_Seller",
    customer_id: raw.customer_id || raw.user?.user_id || null,
    customer_name: raw.customer_name || raw.user?.user_name || chat.user?.user_name || "Покупатель",
    last_message_id: String(raw.last_message_id || raw.last_message?.message_id || ""),
    last_message_text: String(raw.last_message_text || raw.last_message?.content || raw.last_message?.text || "").slice(0, 500),
    last_message_at: raw.last_message_at || raw.last_message?.created_at || raw.updated_at || chat.created_date || chat.created_at || raw.created_at || null,
    unread_count: Number(raw.unread_count || raw.unread_messages || 0) || 0,
    created_at: chat.created_date || chat.created_at || raw.created_at || null,
  };
}

function normalizeOzonChatMessage(m) {
  // v3 формат: { message_id, user: {id, type: "Customer"|"Seller"|"Support"}, created_at, data: ["текст", ...], is_image, is_read }
  // text может быть в m.data (array), m.content, m.text
  let text = "";
  if (Array.isArray(m.data)) text = m.data.map((s) => String(s || "")).join("\n").trim();
  else if (typeof m.content === "string") text = m.content;
  else if (Array.isArray(m.content)) text = m.content.map((p) => (typeof p === "string" ? p : p?.text || p?.value || "")).join(" ").trim();
  else if (m.text) text = String(m.text);
  const userType = String(m.user?.type || m.author?.type || "").toLowerCase();
  return {
    message_id: String(m.message_id || m.id || ""),
    text,
    content_type: m.content_type || m.type || (m.is_image ? "Image" : "Message"),
    is_from_seller: userType === "seller" || userType === "support" || m.is_seller === true || m.from === "seller",
    user_name: m.user?.user_name || m.author_name || (userType === "customer" ? "Покупатель" : "Продавец"),
    created_at: m.created_at || m.created_date || m.timestamp || null,
    is_read: m.is_read,
  };
}

async function syncOzonChats(uid, cid, key, { limitChats = 100, maxPages = 10, limitHistory = 50, status = "All" } = {}) {
  let chatList = [];
  let cursor = "";
  let firstResponse = null;
  let paginationWarning = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      let r;
      try {
        r = await fetchOzonChatList(cid, key, { limit: limitChats, cursor, status });
      } catch (e) {
        const msg = formatApiErrorMessage(e).toLowerCase();
        if (page > 0 && (msg.includes("cursor value is incorrect") || msg.includes("invalidargument"))) {
          paginationWarning = `Пагинация остановлена: Ozon отверг курсор (известный баг API). Собрано ${chatList.length} чатов.`;
          break;
        }
        throw e;
      }
      if (!firstResponse) firstResponse = r;
      const items = r?.chats || r?.result?.chats || r?.result || [];
      if (!Array.isArray(items) || !items.length) break;
      chatList = chatList.concat(items);
      const nextCursor = r?.cursor || r?.result?.cursor || "";
      const hasNext = r?.has_next ?? r?.result?.has_next ?? (items.length >= limitChats);
      if (!nextCursor || nextCursor === cursor || hasNext === false) break;
      cursor = nextCursor;
    }
  } catch (e) {
    if (isOzonSubscriptionDenied(e)) return { skipped: true, reason: "Ozon chat API недоступен на текущей подписке (code 7)" };
    throw e;
  }
  if (paginationWarning) addUserLog(uid, `⚠️ ${paginationWarning}`, "warn");
  if (!chatList.length) {
    addUserLog(uid, `ℹ️ Ozon /v3/chat/list вернул 0 чатов (status=${status}). Полный ответ записан в лог сервера.`, "info");
    console.log("[chat sync] empty list. raw response:", JSON.stringify(firstResponse).slice(0, 500));
  }
  const store = getUserChatsStore(uid);
  store.index = Array.isArray(store.index) ? store.index : [];
  store.threads = store.threads || {};

  let updated = 0, newMsgs = 0;
  for (const raw of chatList) {
    const meta = normalizeOzonChatThread(raw);
    if (!meta.chat_id) continue;
    meta.source = "ozon";
    const existing = store.index.find((x) => x.chat_id === meta.chat_id);
    if (existing) Object.assign(existing, meta);
    else { store.index.unshift(meta); updated++; }

    let history = store.threads[meta.chat_id];
    if (!history) history = { chat_id: meta.chat_id, messages: [], ai_draft: "", intent: null, escalated: false };
    try {
      const hr = await fetchOzonChatHistory(cid, key, meta.chat_id, { limit: limitHistory });
      const msgs = (hr?.messages || hr?.result?.messages || []).map(normalizeOzonChatMessage).filter((m) => m.message_id);
      const known = new Set(history.messages.map((m) => m.message_id));
      for (const m of msgs.reverse()) {
        if (!known.has(m.message_id)) { history.messages.push(m); newMsgs++; }
      }
      history.messages.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } catch (e) {
      if (!isOzonSubscriptionDenied(e)) {
        // мягко логируем, не валим всю синхронизацию
        addUserLog(uid, `⚠️ Ozon chat history ${meta.chat_id}: ${formatApiErrorMessage(e)}`, "warn");
      }
    }
    store.threads[meta.chat_id] = history;
  }

  store.index = store.index.slice(0, 500);
  setUserChatsStore(uid, store);
  return { ok: true, chats_remote: chatList.length, chats_local: store.index.length, updated, new_messages: newMsgs, warning: paginationWarning };
}

const CHAT_INTENT_LABELS = {
  pre_sales: "Вопрос до покупки",
  post_sales: "Вопрос после покупки",
  return: "Возврат/обмен",
  complaint: "Жалоба на качество",
  conflict: "Конфликт — нужен человек",
  delivery: "Доставка",
  other: "Прочее",
};

async function generateChatReply(thread, productCtx, user, marketplace = "Ozon") {
  const messages = (thread.messages || []).slice(-16);
  if (!messages.length) throw new Error("Нет сообщений в диалоге для AI-ответа");
  const dialog = messages.map((m) => `[${m.is_from_seller ? "Продавец" : "Покупатель"}] ${m.text}`).join("\n");
  const toneBlock = buildToneInstructions(user, "question");

  const prompt = `Ты — продавец на маркетплейсе ${marketplace}, ведёшь чат с покупателем. Тебе нужно сгенерировать СЛЕДУЮЩИЙ ответ продавца.

${toneBlock}

ИСТОРИЯ ДИАЛОГА (последние сообщения, сверху вниз — по времени):
${dialog}

${productCtx ? `КОНТЕКСТ ТОВАРА:\n${productCtx}\n` : ""}

ЗАДАЧА:
1. Определи намерение клиента: pre_sales (вопрос о товаре до покупки) / post_sales (как пользоваться, гарантия) / return (возврат, обмен) / complaint (жалоба на качество, брак) / conflict (угрозы, юридические претензии, требование компенсации, эскалация) / delivery (где посылка, сроки) / other.
2. Реши, требуется ли эскалация на ЖИВОГО менеджера: ставь escalate=true для conflict, для прямых угроз ("напишу в РПН", "пожалуюсь"), для требований нестандартной компенсации, для крупных сумм, для медицинских/юридических вопросов.
3. Если escalate=false — сгенерируй конкретный, по делу ответ покупателю. Соблюдай тон. Без воды и шаблонных «здравствуйте!» если в диалоге уже здоровались.
4. Если escalate=true — короткий ответ типа: «Спасибо, что обратились. Передам ваш вопрос менеджеру — он свяжется в ближайшее время.» — и НИЧЕГО не обещай по сути.
5. Жёсткие правила:
   - НЕ обещай возврат денег, скидку, замену, компенсацию, если этого нет в данных диалога или это право покупателя.
   - НЕ выдумывай характеристики товара. Если данных нет — честно скажи, что уточнишь.
   - Для возвратов: предложи оформить через ЛК ${marketplace} (раздел «Возвраты»), а не обещай сделать сам.
   - Не упоминай AI, нейросеть, ассистента.

Верни ТОЛЬКО валидный JSON по схеме:
{
  "intent": "pre_sales|post_sales|return|complaint|conflict|delivery|other",
  "escalate": false,
  "reply": "текст ответа покупателю",
  "internal_note": "1-2 предложения для продавца: что произошло и что делать дальше"
}`;

  const msg = await aiComplete(user, { max_tokens: 900, messages: [{ role: "user", content: prompt }] });
  return parseAiJson(msg.text);
}

function summarizeReviewsForPrompt(reviews, maxItems = 120) {
  return (reviews || []).slice(0, maxItems).map((r, i) => {
    const parts = [];
    if (r.rating) parts.push(`[${r.rating}★]`);
    if (r.text) parts.push(r.text);
    if (r.cons) parts.push(`(минусы: ${r.cons})`);
    if (r.pros) parts.push(`(плюсы: ${r.pros})`);
    return `${i + 1}. ${parts.join(" ")}`;
  }).filter((line) => line.length > 5).join("\n");
}

async function generateInspectionBrief(card, reviews, opts = {}, user = null) {
  const sampleTarget = Number(opts.sample_target) || 50;
  const notes = String(opts.notes || "").trim();
  const charText = (card.characteristics || []).slice(0, 60).map((c) => `${c.name}: ${c.value}`).join("\n");
  const reviewsText = summarizeReviewsForPrompt(reviews, 150);
  if (!reviewsText) throw new Error("Нет отзывов для анализа. Загрузите карточку с отзывами.");

  const msg = await aiComplete(user, {
    max_tokens: 3800,
    messages: [{ role: "user", content: `Ты — руководитель QC, который составляет ТЗ для инспекции товара на китайской фабрике (Pre-shipment inspection).

ТОВАР НА WB:
Название: ${card.name}
Бренд: ${card.brand || "—"}
Категория: ${card.subj_root_name || ""} / ${card.subj_name || ""}
Цена: ${card.price ? card.price + " ₽" : "—"}
Рейтинг WB: ${card.rating || "—"} (${card.feedbacks || 0} отзывов всего, для анализа доступно ${reviews.length})

ХАРАКТЕРИСТИКИ КАРТОЧКИ:
${charText || "—"}

ОТЗЫВЫ ПОКУПАТЕЛЕЙ (реальные, с WB):
${reviewsText}

${notes ? `ЗАМЕТКИ ПРОДАВЦА:\n${notes}\n` : ""}

Целевой размер выборки: ${sampleTarget} шт.

На основе ТОЛЬКО реальных отзывов и характеристик сделай готовый ТЗ для инспектора в Китае. Не выдумывай дефекты — отталкивайся от того, что реально жалуются покупатели.

Верни ТОЛЬКО валидный JSON по схеме:
{
  "summary": "2-3 предложения: что за товар и главные риски качества",
  "top_issues": [
    {"issue":"описание проблемы","mentions":N,"severity":"high|medium|low","root_cause_hypothesis":"вероятная причина"}
  ],
  "qc_checklist": [
    {"step":"что проверять","method":"как проверять (визуально/тест/измерение)","acceptance":"критерий годен/не годен","priority":"critical|major|minor"}
  ],
  "sampling": {
    "plan":"AQL или просто число",
    "sample_size":${sampleTarget},
    "critical_aql":"0",
    "major_aql":"2.5",
    "minor_aql":"4.0",
    "rationale":"почему такой план для этого товара/частоты дефектов"
  },
  "tests_to_perform": [
    {"test":"название","details":"методика","equipment":"что нужно"}
  ],
  "packaging_and_labeling": ["пункт 1","пункт 2","пункт 3"],
  "improvements": [
    {"area":"что улучшить","action":"конкретное действие","expected_effect":"рейтинг/возвраты/конверсия"}
  ],
  "niche_risks": [
    {"risk":"описание","mitigation":"как минимизировать"}
  ]
}
Минимум 3 пункта в каждом массиве. Ничего кроме JSON.` }],
  });
  return parseAiJson(msg.text);
}

async function generateCompetitorComparison(mine, competitor, user = null) {
  const fmtChar = (chs) => (chs || []).slice(0, 60).map((c) => `${c.name}: ${c.value}`).join("\n");
  const fmtCardSummary = (c) =>
    `nm_id ${c.nm_id} | "${c.name}" | бренд ${c.brand || "—"} | цена ${c.price || "—"} ₽ | рейтинг ${c.rating || "—"} (${c.feedbacks || 0} отз.) | категория ${c.subj_name || "—"}`;
  const fmtTopReviews = (c, n = 40) => summarizeReviewsForPrompt(c.reviews || [], n);

  const msg = await aiComplete(user, {
    max_tokens: 3800,
    messages: [{ role: "user", content: `Ты — аналитик маркетплейса. Сравни мой товар на WB и товар конкурента и выдай конкретный план улучшений.

МОЙ ТОВАР:
${fmtCardSummary(mine)}
Характеристики:
${fmtChar(mine.characteristics) || "—"}
Описание карточки (фрагмент):
${(mine.description || "").slice(0, 1500)}
Отзывы (выборка):
${fmtTopReviews(mine) || "—"}

КОНКУРЕНТ:
${fmtCardSummary(competitor)}
Характеристики:
${fmtChar(competitor.characteristics) || "—"}
Описание карточки (фрагмент):
${(competitor.description || "").slice(0, 1500)}
Отзывы (выборка):
${fmtTopReviews(competitor) || "—"}

На основе ТОЛЬКО этих данных дай конкретные шаги: что улучшить чтобы обогнать конкурента, увеличить маржу/качество/конверсию. Никаких выдумок и общих фраз.

Верни ТОЛЬКО валидный JSON по схеме:
{
  "headline": "1 предложение — главный вывод",
  "price_comparison": {
    "mine": ${Number(mine.price) || 0},
    "competitor": ${Number(competitor.price) || 0},
    "verdict": "дороже|дешевле|на уровне",
    "gap_pct": N,
    "comment": "коротко"
  },
  "rating_comparison": {
    "mine_rating": ${Number(mine.rating) || 0},
    "competitor_rating": ${Number(competitor.rating) || 0},
    "mine_reviews": ${Number(mine.feedbacks) || 0},
    "competitor_reviews": ${Number(competitor.feedbacks) || 0},
    "verdict": "коротко"
  },
  "spec_diffs": [
    {"name":"характеристика","mine":"значение","competitor":"значение","verdict":"мы лучше|хуже|на уровне"}
  ],
  "what_competitor_does_better": ["пункт"],
  "what_we_do_better": ["пункт"],
  "review_themes_mine": [{"theme":"тема","sentiment":"positive|negative|neutral","mentions":N}],
  "review_themes_competitor": [{"theme":"тема","sentiment":"positive|negative|neutral","mentions":N}],
  "action_plan": [
    {"action":"что сделать","why":"причина из данных","impact":"эффект на прибыль/рейтинг/конверсию","effort":"low|medium|high"}
  ],
  "pricing_recommendation": {"new_price":N,"reasoning":"короткое обоснование"},
  "card_optimization": ["пункт","пункт","пункт"]
}
Минимум 3 пункта в каждом массиве. Только JSON.` }],
  });
  return parseAiJson(msg.text);
}

// ─── WB period snapshots (до/после доработки) ─────────────────────────────
function getUserWbSnapshots(uid) { return getUserData(uid, "wb-snapshots", {}); }
function setUserWbSnapshots(uid, snapshots) { return setUserData(uid, "wb-snapshots", snapshots); }

function summarizeCardForSnapshot(card) {
  return {
    nm_id: card.nm_id,
    imt_id: card.imt_id,
    name: card.name,
    brand: card.brand,
    price: card.price,
    base_price: card.base_price,
    rating: card.rating,
    feedbacks: card.feedbacks,
    subj_name: card.subj_name,
    subj_root_name: card.subj_root_name,
    characteristics: (card.characteristics || []).slice(0, 80),
  };
}

async function takeWbSnapshot(uid, nmIdRaw, { label = "", notes = "", reviewsKeep = 200 } = {}) {
  const card = await ensureWbCard(uid, nmIdRaw, { force: true, maxReviews: Math.max(reviewsKeep, 200) });
  const all = getUserWbSnapshots(uid);
  const nmKey = String(card.nm_id);
  const snapshot = {
    snapshot_id: uuidv4(),
    taken_at: new Date().toISOString(),
    label: String(label || "").trim().slice(0, 120),
    notes: String(notes || "").trim().slice(0, 2000),
    card: summarizeCardForSnapshot(card),
    reviews_total: card.feedbacks,
    reviews_sample: (card.reviews || []).slice(0, reviewsKeep).map((r) => ({
      rating: r.rating, text: r.text, pros: r.pros, cons: r.cons,
      created_at: r.created_at, photo_count: r.photo_count,
    })),
  };
  const list = Array.isArray(all[nmKey]) ? all[nmKey] : [];
  list.unshift(snapshot);
  all[nmKey] = list.slice(0, 30);
  setUserWbSnapshots(uid, all);
  return snapshot;
}

function summarizeSnapshotForPrompt(snap, maxReviews = 80) {
  const reviews = (snap.reviews_sample || []).slice(0, maxReviews).map((r, i) => {
    const parts = [];
    if (r.rating) parts.push(`[${r.rating}★]`);
    if (r.text) parts.push(r.text);
    if (r.cons) parts.push(`(минусы: ${r.cons})`);
    if (r.pros) parts.push(`(плюсы: ${r.pros})`);
    return `${i + 1}. ${parts.join(" ")}`;
  }).filter((s) => s.length > 5).join("\n");
  const c = snap.card || {};
  return {
    header: `Снимок от ${new Date(snap.taken_at).toLocaleString("ru-RU")} · «${snap.label || "без метки"}»\nРейтинг: ${c.rating || "—"} · отзывов всего: ${snap.reviews_total || c.feedbacks || 0} · цена: ${c.price || "—"} ₽`,
    notes: snap.notes,
    reviews,
  };
}

async function generatePeriodComparison(before, after, opts = {}, user = null) {
  const changeNotes = String(opts.change_notes || "").trim();
  const b = summarizeSnapshotForPrompt(before);
  const a = summarizeSnapshotForPrompt(after);
  const bCard = before.card || {};
  const aCard = after.card || {};

  const msg = await aiComplete(user, {
    max_tokens: 3800,
    messages: [{ role: "user", content: `Ты — аналитик товара на маркетплейсе. У тебя есть два моментальных снимка одного и того же товара на Wildberries — ДО и ПОСЛЕ доработки. Сравни их и скажи, что изменилось, что улучшилось, что ухудшилось, какие новые проблемы появились.

ТОВАР: "${bCard.name || aCard.name || "—"}" (nm_id ${bCard.nm_id || aCard.nm_id})

═══ СНИМОК ДО ═══
${b.header}
${b.notes ? `Заметки: ${b.notes}\n` : ""}
Отзывы (выборка):
${b.reviews || "—"}

═══ СНИМОК ПОСЛЕ ═══
${a.header}
${a.notes ? `Заметки: ${a.notes}\n` : ""}
Отзывы (выборка):
${a.reviews || "—"}

${changeNotes ? `═══ ЧТО ИЗМЕНИЛИ (от продавца) ═══\n${changeNotes}\n` : ""}

На основе ТОЛЬКО реальных данных из снимков, верни валидный JSON по схеме:
{
  "summary": "1-2 предложения — общий эффект доработки",
  "verdict": "успех|частичный успех|без эффекта|регресс",
  "metrics_diff": {
    "rating": {"before": ${bCard.rating || 0}, "after": ${aCard.rating || 0}, "delta": ${Number(((aCard.rating || 0) - (bCard.rating || 0)).toFixed(2))}, "trend": "up|down|flat"},
    "feedbacks_total": {"before": ${bCard.feedbacks || 0}, "after": ${aCard.feedbacks || 0}, "delta": ${(aCard.feedbacks || 0) - (bCard.feedbacks || 0)}, "trend": "up|down|flat"},
    "price": {"before": ${bCard.price || 0}, "after": ${aCard.price || 0}, "delta": ${Number(((aCard.price || 0) - (bCard.price || 0)).toFixed(0))}, "trend": "up|down|flat"}
  },
  "what_got_better": [
    {"theme":"тема","before":"что было в отзывах ДО","after":"что стало ПОСЛЕ","evidence":"цитата или признак"}
  ],
  "what_got_worse": [
    {"theme":"тема","before":"что было","after":"что стало","hypothesis":"вероятная причина"}
  ],
  "new_issues_emerged": [
    {"issue":"новая проблема","frequency":"высокая|средняя|низкая","severity":"high|medium|low","evidence":"что говорят"}
  ],
  "resolved_issues": [
    {"issue":"какая проблема ушла или ослабла","evidence":"исчезла из отзывов / меньше упоминается"}
  ],
  "next_actions": [
    {"action":"что сделать дальше","why":"причина","priority":"high|medium|low","expected_effect":"эффект"}
  ],
  "rating_explanation": "1-2 предложения: почему рейтинг изменился так как изменился"
}
Минимум 2 пункта в каждом массиве (если есть данные). Только JSON.` }],
  });
  return parseAiJson(msg.text);
}

function buildProductContextForPrompt(entry) {
  if (!entry) return "";
  const lines = [];
  if (entry.name) lines.push(`Название: ${entry.name}`);
  if (entry.offer_id) lines.push(`Артикул продавца: ${entry.offer_id}`);
  if (entry.sku) lines.push(`SKU Ozon: ${entry.sku}`);
  if (Array.isArray(entry.attributes) && entry.attributes.length) {
    const lines2 = [];
    for (const a of entry.attributes) {
      if (!a || !Array.isArray(a.values) || !a.values.length) continue;
      lines2.push(`- ${a.values.join("; ")}`);
    }
    if (lines2.length) {
      lines.push("Характеристики из карточки Ozon:");
      lines.push(lines2.slice(0, 80).join("\n"));
    }
  }
  if (entry.description) {
    lines.push("Описание из карточки:");
    lines.push(entry.description);
  }
  return lines.join("\n");
}

// ─── AI Provider abstraction (Anthropic native + OpenRouter) ────────────────
const AI_MODELS = {
  anthropic: [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", note: "флагман, лучшее качество" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "баланс цены/качества" },
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4 (2025-05-14)", note: "стабильный" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "самый быстрый и дешёвый" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)" },
    { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7 (via OpenRouter)" },
    { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (via OpenRouter)" },
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "openai/gpt-4o-mini", label: "GPT-4o mini (дёшево)" },
    { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
    { id: "google/gemini-pro-1.5", label: "Gemini Pro 1.5" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    { id: "mistralai/mistral-large", label: "Mistral Large" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  ],
};
const DEFAULT_AI_PROVIDER = "anthropic";

function resolveAiConfig(user) {
  const provider = String(user?.ai_provider || DEFAULT_AI_PROVIDER);
  const fallback = provider === "openrouter" ? AI_MODELS.openrouter[0].id : ANTHROPIC_REVIEW_MODEL;
  const model = String(user?.ai_model || fallback).trim();
  return { provider, model };
}

async function aiComplete(user, { messages, max_tokens = 800, temperature }) {
  const { provider, model } = resolveAiConfig(user);
  if (provider === "openrouter") {
    const key = user?.openrouter_api_key;
    if (!key) throw new Error("Не настроен OpenRouter API ключ (Settings → AI провайдер)");
    const r = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        messages: messages.map((m) => ({ role: m.role || "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })),
        max_tokens,
        ...(temperature != null ? { temperature } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": String(process.env.APP_ORIGIN || "http://localhost:3001"),
          "X-Title": "ReviewOS",
          "Content-Type": "application/json",
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );
    if (r.status >= 400) {
      const msg = r.data?.error?.message || r.data?.error || JSON.stringify(r.data || "").slice(0, 240);
      throw new Error(`OpenRouter ${r.status}: ${msg}`);
    }
    const text = r.data?.choices?.[0]?.message?.content || "";
    return { text, provider, model };
  }
  if (!ANTHROPIC_KEY) throw new Error("Не настроен ANTHROPIC_API_KEY (в .env)");
  const cleanModel = model.startsWith("anthropic/") ? model.replace(/^anthropic\//, "") : model;
  const msg = await anthropic.messages.create({
    model: cleanModel,
    max_tokens,
    messages,
    ...(temperature != null ? { temperature } : {}),
  });
  const text = msg.content.map((b) => b.text || "").join("");
  return { text, provider, model: cleanModel };
}

function parseAiJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Claude AI ────────────────────────────────────────────────────────────────
async function analyzeReview(text, rating, shopName = "", user = null, marketplace = "Ozon") {
  const t = text || (rating >= 4 ? "Покупатель не оставил текст, но поставил высокую оценку." : rating <= 2 ? "Покупатель не оставил текст, но поставил низкую оценку." : "Покупатель поставил среднюю оценку.");
  const shopRef = shopName ? `Магазин: ${shopName}. ` : "";
  const toneBlock = buildToneInstructions(user, "review");
  const msg = await aiComplete(user, {
    max_tokens: 800,
    messages: [{ role: "user", content: `${shopRef}Ты — менеджер магазина на маркетплейсе ${marketplace}. Проанализируй отзыв и подготовь ответ покупателю.

${toneBlock}

Рейтинг: ${rating}/5
Текст отзыва: "${t}"

Задачи:
1. Определи тональность отзыва: "positive" (4-5★ либо явно положительный), "negative" (1-2★ либо претензия), "neutral" (3★ либо смешанный).
2. Подготовь ответ продавца (2-4 предложения, русский, согласно правилам стиля выше):
   - для НЕГАТИВНОГО — извинения по сути + конкретное решение
   - для ПОЗИТИВНОГО — благодарность в стиле выбранной тональности
   - для НЕЙТРАЛЬНОГО — признательность за обратную связь + готовность помочь

Не упоминай AI/нейросеть/ассистента. Верни ТОЛЬКО валидный JSON: {"sentiment":"positive|negative|neutral","response":"текст ответа"}` }],
  });
  return parseAiJson(msg.text);
}

async function answerQuestion(text, productUrl, productContext = "", user = null, marketplace = "Ozon") {
  const hasContext = String(productContext || "").trim().length > 0;
  const toneBlock = buildToneInstructions(user, "question");
  const promptParts = [
    `Ты — продавец магазина на маркетплейсе ${marketplace}. Ответь на вопрос покупателя строго на основе данных карточки товара.`,
    "",
    toneBlock,
    "",
  ];
  if (hasContext) {
    promptParts.push("ДАННЫЕ ИЗ КАРТОЧКИ ТОВАРА (единственный достоверный источник):");
    promptParts.push(productContext);
    promptParts.push("");
  } else {
    promptParts.push("ДАННЫЕ ИЗ КАРТОЧКИ ТОВАРА: недоступны.");
    promptParts.push("");
  }
  if (productUrl) {
    promptParts.push(`Ссылка на товар: ${productUrl}`);
  }
  promptParts.push(`Вопрос покупателя: "${text}"`);
  promptParts.push("");
  promptParts.push("Жёсткие правила (важнее тона):");
  promptParts.push("- Отвечай ТОЛЬКО на основе данных карточки выше. Не выдумывай и не угадывай характеристики.");
  promptParts.push("- Если в вопросе спрашивают конкретную характеристику (мощность, размер, вес, материал, объём, длина кабеля, комплектация, совместимость, питание и т.п.) — найди точное значение в данных и приведи его дословно, с единицами измерения.");
  promptParts.push("- Если нужной характеристики в данных нет — честно скажи, что эта информация не указана в карточке, и предложи уточнить (например: \"уточним у поставщика и дополним карточку\"). НЕ придумывай число или значение.");
  promptParts.push("- Не упоминай AI, нейросеть, ассистента, не пиши \"по данным карточки\" или \"согласно описанию\".");
  promptParts.push("- Верни ТОЛЬКО текст готового ответа покупателю, без пояснений.");

  const msg = await aiComplete(user, {
    max_tokens: 700,
    messages: [{ role: "user", content: promptParts.join("\n") }],
  });
  return msg.text.trim();
}

function fallbackCopilotAnswer(text) {
  const source = String(text || "").toLowerCase();
  if (["брак", "слом", "не работает", "плохо", "ужас", "разочар"].some((word) => source.includes(word))) {
    return "Здравствуйте! Спасибо, что написали нам. Нам очень жаль, что товар не оправдал ожидания. Пожалуйста, оформите обращение через кабинет маркетплейса или напишите в поддержку, чтобы мы могли разобраться в ситуации.";
  }
  if (["хорош", "отлич", "понрав", "супер", "класс", "спасибо"].some((word) => source.includes(word))) {
    return "Здравствуйте! Спасибо за отзыв и высокую оценку. Очень рады, что товар вам понравился. Будем рады видеть вас снова!";
  }
  return "Здравствуйте! Спасибо за ваш отзыв. Мы внимательно относимся к обратной связи покупателей и используем её, чтобы улучшать товар и сервис. Хорошего дня!";
}

async function generateCopilotAnswer({ text, toneRules, marketplace, kind, user = null }) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Нет текста отзыва или вопроса.");
  const { provider } = resolveAiConfig(user);
  if (provider === "anthropic" && !ANTHROPIC_KEY) return fallbackCopilotAnswer(cleanText);

  const msg = await aiComplete(user, {
    max_tokens: 700,
    messages: [{
      role: "user",
      content: `Ты опытный менеджер поддержки продавца на маркетплейсе.

Маркетплейс: ${marketplace || "unknown"}
Тип обращения: ${kind || "review"}

Правила тона:
${toneRules || "Пиши вежливо, коротко и по-человечески. Не спорь с клиентом. Не обещай компенсацию, скидку или возврат, если этого нет в обращении."}

Текст клиента:
"""${cleanText}"""

Напиши один готовый ответ продавца на русском языке.
Требования:
- 1-4 предложения.
- Без упоминания AI.
- Без выдуманных характеристик товара.
- Без автопубликации и без призывов нарушать правила маркетплейса.
- Верни только текст ответа.`,
    }],
  });

  const answer = (msg.text || "").trim();
  return answer || fallbackCopilotAnswer(cleanText);
}

// ─── Per-user cycle ───────────────────────────────────────────────────────────
const cycleRunning = {};

async function runUserCycle(uid) {
  if (cycleRunning[uid]) return { skipped: true };
  cycleRunning[uid] = true;

  const user = getUserById(uid);
  if (!user) { cycleRunning[uid] = false; return { error: "User not found" }; }

  const cid = user.ozon_client_id;
  const key = user.ozon_api_key;
  const autoPost = user.auto_post === true;

  const res = { reviews: { processed: 0, posted: 0, errors: 0 }, questions: { processed: 0, posted: 0, errors: 0 } };

  try {
    if (!cid || !key) throw new Error("Не настроены Ozon API ключи");
    if (!ANTHROPIC_KEY) throw new Error("Не настроен ANTHROPIC_API_KEY");

    addUserLog(uid, "🔄 Запуск цикла...", "info");

    // Reviews
    addUserLog(uid, "📡 Получаем отзывы...", "info");
    let ozonReviews = [];
    try {
      ozonReviews = await fetchReviews(cid, key);
      const existingReviews = getUserData(uid, "reviews", []);
      const unansweredReviews = ozonReviews.filter(r => !r.hasResponse && r.review_uuid);
      const newReviews = unansweredReviews.filter(r => !existingReviews.find(x => x.review_uuid === r.review_uuid)).length;
      addUserLog(uid, `✅ Отзывов из Ozon: ${ozonReviews.length}, без ответа: ${unansweredReviews.length}, новых: ${newReviews}`, "success");
    } catch (reviewFetchError) {
      const message = formatApiErrorMessage(reviewFetchError);
      if (!isOzonSubscriptionDenied(reviewFetchError)) throw reviewFetchError;
      res.reviews.skipped = true;
      res.reviews.error = message;
      addUserLog(uid, `⚠️ Отзывы недоступны на текущей подписке Ozon Seller API: ${message}`, "warn");
    }

    for (const r of ozonReviews) {
      if (!r.hasResponse && r.review_uuid) {
        const existing = getUserData(uid, "reviews", []).find(x => x.review_uuid === r.review_uuid);
        if (!existing) {
          const list = getUserData(uid, "reviews", []);
          list.unshift({ ...r, status: "pending", created_at: new Date().toISOString() });
          setUserData(uid, "reviews", list);
        }
      }
    }

    const pending = getUserData(uid, "reviews", []).filter(r => r.status === "pending").slice(0, 100);
    if (pending.length) {
      addUserLog(uid, `🤖 Обрабатываем ${pending.length} отзывов...`, "info");
      for (const r of pending) {
        try {
          const { sentiment, response: aiResp } = await analyzeReview(r.text, r.rating, user.shop_name);
          updateUserRecord(uid, "reviews", { review_uuid: r.review_uuid, sentiment, ai_response: aiResp, status: "ready" });
          const e = sentiment === "positive" ? "😊" : sentiment === "negative" ? "😠" : "😐";
          addUserLog(uid, `${e} Ответ готов`, "success");
          res.reviews.processed++;
          if (autoPost) {
            try {
              await postReviewResp(cid, key, r.review_uuid, aiResp);
              updateUserRecord(uid, "reviews", { review_uuid: r.review_uuid, status: "posted" });
              addUserLog(uid, "📤 Отзыв опубликован", "success");
              res.reviews.posted++;
            } catch (postError) {
              if (isOzonPublishForbidden(postError)) {
                updateUserRecord(uid, "reviews", {
                  review_uuid: r.review_uuid,
                  status: "ready",
                  publish_error: formatApiErrorMessage(postError),
                });
                addUserLog(uid, "⚠️ Ozon запретил автопубликацию этого ответа. Оставил его в статусе 'Готов' для ручной проверки.", "warn");
                continue;
              }
              throw postError;
            }
          }
        } catch (e) {
          addUserLog(uid, `❌ Отзыв: ${formatApiErrorMessage(e)}`, "error");
          updateUserRecord(uid, "reviews", { review_uuid: r.review_uuid, status: "error" });
          res.reviews.errors++;
        }
      }
    }

    // Questions
    addUserLog(uid, "📡 Получаем вопросы...", "info");
    let ozonQ = [];
    try {
      ozonQ = await fetchQuestions(cid, key);
      const existingQuestions = getUserData(uid, "questions", []);
      const unansweredQuestions = ozonQ.filter(q => !q.hasAnswer && q.question_id);
      const newQuestions = unansweredQuestions.filter(q => !existingQuestions.find(x => x.question_id === q.question_id)).length;
      addUserLog(uid, `✅ Вопросов из Ozon: ${ozonQ.length}, без ответа: ${unansweredQuestions.length}, новых: ${newQuestions}`, "success");
    } catch (questionFetchError) {
      const message = formatApiErrorMessage(questionFetchError);
      if (!isOzonSubscriptionDenied(questionFetchError)) throw questionFetchError;
      res.questions.skipped = true;
      res.questions.error = message;
      addUserLog(uid, `⚠️ Вопросы недоступны на текущей подписке Ozon Seller API: ${message}`, "warn");
    }

    for (const q of ozonQ) {
      if (!q.hasAnswer && q.question_id) {
        const existing = getUserData(uid, "questions", []).find(x => x.question_id === q.question_id);
        if (!existing) {
          const list = getUserData(uid, "questions", []);
          list.unshift({ ...q, status_ai: "pending", created_at: new Date().toISOString() });
          setUserData(uid, "questions", list);
        }
      }
    }

    const pendingQ = getUserData(uid, "questions", []).filter(q => q.status_ai === "pending").slice(0, 100);
    if (pendingQ.length) {
      addUserLog(uid, `🤖 Обрабатываем ${pendingQ.length} вопросов...`, "info");

      const skuList = pendingQ.map(q => q.sku).filter(Boolean);
      if (skuList.length) {
        try {
          await ensureProductData(uid, cid, key, skuList);
          addUserLog(uid, `📚 Подгрузили карточки товаров: ${new Set(skuList.map(String)).size}`, "info");
        } catch (e) {
          addUserLog(uid, `⚠️ Не удалось подгрузить характеристики товаров: ${formatApiErrorMessage(e)}`, "warn");
        }
      }
      const productCache = getUserProducts(uid);

      for (const q of pendingQ) {
        try {
          const productCtx = buildProductContextForPrompt(productCache[String(q.sku)]);
          const aiAnswer = await answerQuestion(q.text, q.product_url, productCtx);
          updateUserRecord(uid, "questions", { question_id: q.question_id, ai_response: aiAnswer, status_ai: "ready" });
          addUserLog(uid, "💡 Ответ на вопрос готов", "success");
          res.questions.processed++;
          if (autoPost) {
            try {
              await postQuestionAns(cid, key, q.question_id, q.sku, aiAnswer);
              updateUserRecord(uid, "questions", { question_id: q.question_id, status_ai: "posted" });
              addUserLog(uid, "📤 Вопрос опубликован", "success");
              res.questions.posted++;
            } catch (postError) {
              if (isOzonPublishForbidden(postError)) {
                updateUserRecord(uid, "questions", {
                  question_id: q.question_id,
                  status_ai: "ready",
                  publish_error: formatApiErrorMessage(postError),
                });
                addUserLog(uid, "⚠️ Ozon запретил автопубликацию этого ответа на вопрос. Оставил его в статусе 'Готов' для ручной проверки.", "warn");
                continue;
              }
              throw postError;
            }
          }
        } catch (e) {
          addUserLog(uid, `❌ Вопрос: ${formatApiErrorMessage(e)}`, "error");
          updateUserRecord(uid, "questions", { question_id: q.question_id, status_ai: "error" });
          res.questions.errors++;
        }
      }
    }

    // ─── WB Seller: sync + AI-генерация + автопубликация ───
    // ВАЖНО: WB API имеет ОЧЕНЬ строгие лимиты (~1 req/sec, ban 2-5 минут за нарушение).
    // Автоматический cycle, который запускается по cron каждые 5 минут, легко зацикливается:
    //   cycle → WB sync → 429 → ban → следующий cron через 5 мин → ban истёк → опять 429.
    // Поэтому в автоматическом cycle WB sync отключён по умолчанию.
    // Включается только если пользователь явно поставил флаг `wb_auto_sync: true` в users.json
    // (для опытных пользователей с настроенной мониторингом). Обычный путь — ручная кнопка в UI.
    res.wb = { synced: false, feedbacks_replied: 0, questions_replied: 0, feedbacks_posted: 0, questions_posted: 0, errors: 0 };
    if (user.wb_api_key && user.wb_auto_sync === true) {
      // Если WB в бане — пропускаем sync целиком, чтобы не множить ошибки
      const banLeft = wbBanRemainingSec(user.wb_api_key);
      if (banLeft > 0) {
        addUserLog(uid, `⏳ WB sync пропущен: лимит WB активен ещё ${banLeft} сек.`, "warn");
        res.wb.error = `WB ban активен ${banLeft} сек`;
      } else try {
        addUserLog(uid, "📡 WB sync: только новые (без архива, экономим лимит)…", "info");
        // В цикле тянем только неотвеченные, архив подсасывается отдельно через UI
        const fb = await syncWbSellerFeedbacks(uid, user.wb_api_key, { includeAnswered: false });
        await new Promise((r) => setTimeout(r, 2500));
        const qs = await syncWbSellerQuestions(uid, user.wb_api_key, { includeAnswered: false });
        res.wb.synced = true;
        res.wb.feedbacks_added = fb.added;
        res.wb.feedbacks_total = fb.total_local;
        res.wb.questions_added = qs.added;
        res.wb.questions_total = qs.total_local;
        addUserLog(uid, `✅ WB: +${fb.added} отзывов, +${qs.added} вопросов (в кэше: отзывов ${fb.total_local}, вопросов ${qs.total_local})`, "success");
      } catch (e) {
        res.wb.error = formatApiErrorMessage(e);
        addUserLog(uid, `⚠️ WB sync: ${res.wb.error}`, "warn");
      }

      // ─── WB AI-ответы для pending отзывов ───
      const pendingWbRevs = getUserWbFeedbacksStore(uid).filter((r) => r.status === "pending" && !r.is_answered && (r.text || r.pros || r.cons)).slice(0, 50);
      if (pendingWbRevs.length) {
        addUserLog(uid, `🤖 Готовим AI-ответы на ${pendingWbRevs.length} WB-отзывов…`, "info");
        for (const r of pendingWbRevs) {
          try {
            const reviewText = [r.text, r.pros ? `Плюсы: ${r.pros}` : "", r.cons ? `Минусы: ${r.cons}` : ""].filter(Boolean).join(" ").trim();
            const { sentiment, response: aiResp } = await analyzeReview(reviewText, r.rating, user.shop_name || r.product?.brand || "", user, "Wildberries");
            const list = getUserWbFeedbacksStore(uid);
            const idx = list.findIndex((x) => x.review_id === r.review_id);
            if (idx >= 0) {
              list[idx].sentiment = sentiment;
              list[idx].ai_response = aiResp;
              list[idx].status = "ready";
              setUserWbFeedbacksStore(uid, list);
            }
            res.wb.feedbacks_replied++;
            if (autoPost) {
              try {
                await postWbSellerFeedbackAnswer(user.wb_api_key, r.review_id, aiResp);
                const ll = getUserWbFeedbacksStore(uid);
                const ii = ll.findIndex((x) => x.review_id === r.review_id);
                if (ii >= 0) { ll[ii].status = "posted"; ll[ii].posted_at = new Date().toISOString(); setUserWbFeedbacksStore(uid, ll); }
                res.wb.feedbacks_posted++;
                addUserLog(uid, `📤 WB отзыв ${r.review_id} опубликован`, "success");
                await new Promise((x) => setTimeout(x, 1200));
              } catch (postErr) {
                addUserLog(uid, `❌ WB публикация отзыва ${r.review_id}: ${formatApiErrorMessage(postErr)}`, "error");
                res.wb.errors++;
              }
            }
          } catch (e) {
            addUserLog(uid, `❌ AI ответ на WB-отзыв ${r.review_id}: ${formatApiErrorMessage(e)}`, "error");
            res.wb.errors++;
          }
        }
      }

      // ─── WB AI-ответы для pending вопросов ───
      const pendingWbQs = getUserWbQuestionsStore(uid).filter((q) => q.status_ai === "pending" && !q.is_answered && q.text).slice(0, 50);
      if (pendingWbQs.length) {
        addUserLog(uid, `🤖 Готовим AI-ответы на ${pendingWbQs.length} WB-вопросов…`, "info");
        for (const q of pendingWbQs) {
          try {
            let productCtx = "";
            if (q.product?.nm_id) {
              try {
                const card = await ensureWbCard(uid, String(q.product.nm_id), { force: false, maxReviews: 50 });
                const lines = [];
                if (card.name) lines.push(`Название: ${card.name}`);
                if (card.brand) lines.push(`Бренд: ${card.brand}`);
                if (card.price) lines.push(`Цена: ${card.price} ₽`);
                if (Array.isArray(card.characteristics) && card.characteristics.length) {
                  lines.push("Характеристики:");
                  for (const c of card.characteristics.slice(0, 60)) lines.push(`- ${c.name}: ${c.value}`);
                }
                if (card.description) lines.push("Описание:\n" + card.description.slice(0, 3000));
                productCtx = lines.join("\n");
              } catch {}
            }
            const productUrl = q.product?.nm_id ? `https://www.wildberries.ru/catalog/${q.product.nm_id}/detail.aspx` : "";
            const aiAnswer = await answerQuestion(q.text, productUrl, productCtx, user, "Wildberries");
            const list = getUserWbQuestionsStore(uid);
            const idx = list.findIndex((x) => x.question_id === q.question_id);
            if (idx >= 0) {
              list[idx].ai_response = aiAnswer;
              list[idx].status_ai = "ready";
              setUserWbQuestionsStore(uid, list);
            }
            res.wb.questions_replied++;
            if (autoPost) {
              try {
                await postWbSellerQuestionAnswer(user.wb_api_key, q.question_id, aiAnswer);
                const ll = getUserWbQuestionsStore(uid);
                const ii = ll.findIndex((x) => x.question_id === q.question_id);
                if (ii >= 0) { ll[ii].status_ai = "posted"; ll[ii].posted_at = new Date().toISOString(); setUserWbQuestionsStore(uid, ll); }
                res.wb.questions_posted++;
                addUserLog(uid, `📤 WB вопрос ${q.question_id} опубликован`, "success");
                await new Promise((x) => setTimeout(x, 1200));
              } catch (postErr) {
                addUserLog(uid, `❌ WB публикация вопроса ${q.question_id}: ${formatApiErrorMessage(postErr)}`, "error");
                res.wb.errors++;
              }
            }
          } catch (e) {
            addUserLog(uid, `❌ AI ответ на WB-вопрос ${q.question_id}: ${formatApiErrorMessage(e)}`, "error");
            res.wb.errors++;
          }
        }
      }
    }

    // Save last cycle time
    const users = getUsers();
    const ui = users.findIndex(u => u.id === uid);
    if (ui >= 0) { users[ui].last_cycle = new Date().toISOString(); saveUsers(users); }

    if (!pending.length && !pendingQ.length) {
      const checkedSources = [];
      if (!res.reviews.skipped) checkedSources.push("отзывов");
      if (!res.questions.skipped) checkedSources.push("вопросов");
      if (checkedSources.length) addUserLog(uid, `ℹ️ Нет новых ${checkedSources.join(" и ")} Ozon`, "info");
    }

    const reviewSummary = res.reviews.skipped ? "недоступны" : res.reviews.processed;
    const questionSummary = res.questions.skipped ? "недоступны" : res.questions.processed;
    let wbPart = "";
    if (res.wb.synced) {
      wbPart = ` | WB: +${res.wb.feedbacks_added}/+${res.wb.questions_added} новых, AI: ${res.wb.feedbacks_replied}/${res.wb.questions_replied}`;
      if (autoPost) wbPart += `, опубл.: ${res.wb.feedbacks_posted}/${res.wb.questions_posted}`;
    }
    addUserLog(uid, `✅ Цикл завершён. Ozon отзывы: ${reviewSummary} | Ozon вопросы: ${questionSummary}${wbPart}`, "success");

  } catch (e) {
    addUserLog(uid, `❌ ${formatApiErrorMessage(e)}`, "error");
    res.error = formatApiErrorMessage(e);
  }

  cycleRunning[uid] = false;
  return res;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// Регистрация
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = normalizeEmailInput(req.body?.email);
  const password = String(req.body?.password || "");
  const name = sanitizeNameInput(req.body?.name);
  if (!email || !password || !name) return res.status(400).json({ error: "Заполните все поля" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Введите корректный email" });
  if (password.length < 6) return res.status(400).json({ error: "Пароль минимум 6 символов" });
  if (getUserByEmail(email)) return res.status(400).json({ error: "Email уже зарегистрирован" });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), email, name,
    password: hash, role: "user",
    plan: "trial", trial_ends: new Date(Date.now() + 14 * 86400000).toISOString(),
    created_at: new Date().toISOString(),
    ozon_client_id: "", ozon_api_key: "",
    auto_post: false, cron_interval: "*/5 * * * *",
    shop_name: name,
  };

  const users = getUsers(); users.push(user); saveUsers(users);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ ok: true, token, user: sanitizeUser(user) });
});

// Вход
app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = normalizeEmailInput(req.body?.email);
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Введите email и пароль" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Введите корректный email" });

  const user = getUserByEmail(email);
  if (!user) return res.status(401).json({ error: "Неверный email или пароль" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Неверный email или пароль" });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ ok: true, token, user: sanitizeUser(user) });
});

// Текущий пользователь
app.get("/api/auth/me", auth, (req, res) => {
  res.json({ ok: true, user: sanitizeUser(req.user) });
});

function sanitizeUser(u) {
  const { password, ozon_api_key, ozon_api_key_encrypted, wb_api_key, wb_api_key_encrypted, openrouter_api_key, openrouter_api_key_encrypted, ...safe } = u;
  return {
    ...safe,
    ozon_api_key_set: !!(ozon_api_key_encrypted || ozon_api_key),
    ozon_api_key_hint: safe.ozon_api_key_hint || buildSecretHint(ozon_api_key),
    wb_api_key_set: !!(wb_api_key_encrypted || wb_api_key),
    wb_api_key_hint: safe.wb_api_key_hint || buildSecretHint(wb_api_key),
    wb_use_sandbox: !!safe.wb_use_sandbox,
    openrouter_api_key_set: !!(openrouter_api_key_encrypted || openrouter_api_key),
    openrouter_api_key_hint: safe.openrouter_api_key_hint || buildSecretHint(openrouter_api_key),
    ai_tone_preset: safe.ai_tone_preset || DEFAULT_TONE_ID,
    ai_tone_custom: safe.ai_tone_custom || "",
    ai_provider: safe.ai_provider || DEFAULT_AI_PROVIDER,
    ai_model: safe.ai_model || ANTHROPIC_REVIEW_MODEL,
  };
}

// ─── User API Routes ──────────────────────────────────────────────────────────

app.get("/api/status", auth, (req, res) => {
  const uid = req.user.id;
  const reviews   = getUserData(uid, "reviews",   []);
  const questions = getUserData(uid, "questions",  []);
  res.json({
    ok: true,
    cycleRunning: !!cycleRunning[uid],
    lastCycle: req.user.last_cycle,
    cronSchedule: req.user.cron_interval || "*/5 * * * *",
    autoPost: req.user.auto_post,
    plan: req.user.plan,
    trial_ends: req.user.trial_ends,
    stats: {
      reviews: {
        total:    reviews.length,
        positive: reviews.filter(r => r.sentiment === "positive").length,
        negative: reviews.filter(r => r.sentiment === "negative").length,
        neutral:  reviews.filter(r => r.sentiment === "neutral").length,
        posted:   reviews.filter(r => r.status === "posted").length,
        pending:  reviews.filter(r => r.status === "pending").length,
        ready:    reviews.filter(r => r.status === "ready").length,
        errors:   reviews.filter(r => r.status === "error").length,
      },
      questions: {
        total:   questions.length,
        pending: questions.filter(q => q.status_ai === "pending").length,
        ready:   questions.filter(q => q.status_ai === "ready").length,
        posted:  questions.filter(q => q.status_ai === "posted").length,
        errors:  questions.filter(q => q.status_ai === "error").length,
      },
    },
  });
});

app.get("/api/reviews",   auth, (req, res) => { let l = getUserData(req.user.id,"reviews",[]); if(req.query.sentiment)l=l.filter(r=>r.sentiment===req.query.sentiment); res.json({reviews:l}); });
app.get("/api/questions", auth, (req, res) => { let l = getUserData(req.user.id,"questions",[]); res.json({questions:l}); });
app.get("/api/logs",      auth, (req, res) => { res.json({logs: getUserData(req.user.id,"logs",[])}); });

app.post("/api/cycle", auth, cycleLimiter, async (req, res) => {
  const results = await runUserCycle(req.user.id);
  res.json({ ok: true, results });
});

// Review actions
app.post("/api/reviews/:uuid/post", auth, async (req, res) => {
  const uid = req.user.id;
  const r = getUserData(uid,"reviews",[]).find(r => r.review_uuid === req.params.uuid);
  if (!r) return res.status(404).json({ error: "Не найден" });
  if (!r.ai_response) return res.status(400).json({ error: "Нет AI-ответа" });
  try {
    await postReviewResp(req.user.ozon_client_id, req.user.ozon_api_key, req.params.uuid, r.ai_response);
    updateUserRecord(uid, "reviews", { review_uuid: req.params.uuid, status: "posted" });
    addUserLog(uid, `📤 Отзыв опубликован: ${req.params.uuid}`, "success");
    res.json({ ok: true });
  } catch(e) {
    if (isOzonPublishForbidden(e)) {
      updateUserRecord(uid, "reviews", {
        review_uuid: req.params.uuid,
        status: "ready",
        publish_error: formatApiErrorMessage(e),
      });
      addUserLog(uid, `⚠️ Ozon не разрешил публикацию ответа на отзыв ${req.params.uuid}. Ответ сохранён как готовый.`, "warn");
      return res.status(403).json({ error: "Ozon запретил публикацию этого ответа через API. Ответ сохранён у вас в системе как готовый." });
    }
    res.status(500).json({ error: formatApiErrorMessage(e) });
  }
});

app.post("/api/reviews/:uuid/regenerate", auth, async (req, res) => {
  const uid = req.user.id;
  const r = getUserData(uid,"reviews",[]).find(r => r.review_uuid === req.params.uuid);
  if (!r) return res.status(404).json({ error: "Не найден" });
  try {
    const { sentiment, response: aiResponse } = await analyzeReview(r.text, r.rating, req.user.shop_name);
    updateUserRecord(uid, "reviews", { review_uuid: req.params.uuid, sentiment, ai_response: aiResponse, status: "ready" });
    res.json({ ok: true, sentiment, aiResponse });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/reviews/:uuid", auth, (req, res) => {
  if (!req.body.ai_response) return res.status(400).json({ error: "Нужен ai_response" });
  updateUserRecord(req.user.id, "reviews", { review_uuid: req.params.uuid, ai_response: req.body.ai_response });
  res.json({ ok: true });
});

// Question actions
app.post("/api/questions/:id/post", auth, async (req, res) => {
  const uid = req.user.id;
  const q = getUserData(uid,"questions",[]).find(q => q.question_id === req.params.id);
  if (!q) return res.status(404).json({ error: "Не найден" });
  if (!q.ai_response) return res.status(400).json({ error: "Нет AI-ответа" });
  try {
    await postQuestionAns(req.user.ozon_client_id, req.user.ozon_api_key, req.params.id, q.sku, q.ai_response);
    updateUserRecord(uid, "questions", { question_id: req.params.id, status_ai: "posted" });
    addUserLog(uid, `📤 Вопрос опубликован`, "success");
    res.json({ ok: true });
  } catch(e) {
    if (isOzonPublishForbidden(e)) {
      updateUserRecord(uid, "questions", {
        question_id: req.params.id,
        status_ai: "ready",
        publish_error: formatApiErrorMessage(e),
      });
      addUserLog(uid, `⚠️ Ozon не разрешил публикацию ответа на вопрос ${req.params.id}. Ответ сохранён как готовый.`, "warn");
      return res.status(403).json({ error: "Ozon запретил публикацию этого ответа через API. Ответ сохранён у вас в системе как готовый." });
    }
    res.status(500).json({ error: formatApiErrorMessage(e) });
  }
});

app.post("/api/questions/:id/regenerate", auth, async (req, res) => {
  const uid = req.user.id;
  const q = getUserData(uid,"questions",[]).find(q => q.question_id === req.params.id);
  if (!q) return res.status(404).json({ error: "Не найден" });
  try {
    const user = getUserById(uid);
    const force = req.body?.refresh_product === true;
    if (user?.ozon_client_id && user?.ozon_api_key && q.sku) {
      try {
        await ensureProductData(uid, user.ozon_client_id, user.ozon_api_key, [q.sku], { force });
      } catch (productError) {
        addUserLog(uid, `⚠️ Не удалось обновить карточку SKU ${q.sku}: ${formatApiErrorMessage(productError)}`, "warn");
      }
    }
    const productCtx = buildProductContextForPrompt(getUserProducts(uid)[String(q.sku)]);
    const aiAnswer = await answerQuestion(q.text, q.product_url, productCtx);
    updateUserRecord(uid, "questions", { question_id: req.params.id, ai_response: aiAnswer, status_ai: "ready" });
    res.json({ ok: true, aiAnswer });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/questions/:id", auth, (req, res) => {
  if (!req.body.ai_response) return res.status(400).json({ error: "Нужен ai_response" });
  updateUserRecord(req.user.id, "questions", { question_id: req.params.id, ai_response: req.body.ai_response });
  res.json({ ok: true });
});

// ─── Wildberries (бесплатный публичный API) ─────────────────────────────────
app.post("/api/wb/fetch", auth, async (req, res) => {
  try {
    const input = req.body?.input;
    const force = req.body?.force === true;
    const maxReviews = Math.max(50, Math.min(1000, Number(req.body?.max_reviews) || 300));
    const card = await ensureWbCard(req.user.id, input, { force, maxReviews });
    addUserLog(
      req.user.id,
      `🛍 WB карточка ${card.nm_id} (${card.name?.slice(0, 60) || "—"}): отзывов в анализе ${card.reviews_count}, всего ${card.feedbacks}`,
      "info"
    );
    res.json({ ok: true, card });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/wb/cards", auth, (req, res) => {
  const cards = getUserWbCards(req.user.id);
  const list = Object.values(cards)
    .sort((a, b) => new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0))
    .map((c) => ({
      nm_id: c.nm_id, imt_id: c.imt_id, name: c.name, brand: c.brand,
      rating: c.rating, feedbacks: c.feedbacks, price: c.price,
      reviews_count: c.reviews_count, fetched_at: c.fetched_at,
      subj_name: c.subj_name, subj_root_name: c.subj_root_name,
      characteristics_count: (c.characteristics || []).length,
      has_description: !!c.description,
    }));
  res.json({ cards: list });
});

app.get("/api/wb/cards/:nmId", auth, (req, res) => {
  const card = getUserWbCards(req.user.id)[String(req.params.nmId)];
  if (!card) return res.status(404).json({ error: "Карточка не найдена. Сначала загрузите через /api/wb/fetch." });
  res.json({ card });
});

app.delete("/api/wb/cards/:nmId", auth, (req, res) => {
  const cards = getUserWbCards(req.user.id);
  if (!cards[String(req.params.nmId)]) return res.status(404).json({ error: "Не найдено" });
  delete cards[String(req.params.nmId)];
  setUserWbCards(req.user.id, cards);
  res.json({ ok: true });
});

// Диагностика карточки: видно сразу что подтянулось, что нет (basket, characteristics, reviews)
app.get("/api/wb/cards/:nmId/diagnose", auth, (req, res) => {
  const card = getUserWbCards(req.user.id)[String(req.params.nmId)];
  if (!card) return res.status(404).json({ ok: false, error: "Карточки нет в кеше" });
  res.json({
    ok: true,
    nm_id: card.nm_id,
    name: card.name || null,
    has_basket_data: !!(card.subj_name || (card.characteristics?.length)),
    characteristics_count: (card.characteristics || []).length,
    has_description: !!card.description,
    description_length: (card.description || "").length,
    reviews_count: card.reviews_count || 0,
    price: card.price,
    rating: card.rating,
    fetched_at: card.fetched_at,
  });
});

app.post("/api/wb/inspection-brief", auth, async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, error: "Не настроен ANTHROPIC_API_KEY" });
    const nmId = String(req.body?.nm_id || req.body?.nmId || "");
    const card = getUserWbCards(req.user.id)[nmId];
    if (!card) return res.status(404).json({ ok: false, error: "Сначала загрузите карточку через /api/wb/fetch." });
    const brief = await generateInspectionBrief(card, card.reviews || [], {
      sample_target: req.body?.sample_target,
      notes: req.body?.notes,
    }, req.user);
    addUserLog(req.user.id, `🧪 ТЗ для инспекции по nm_id ${card.nm_id} готово`, "success");
    res.json({
      ok: true,
      nm_id: card.nm_id,
      name: card.name,
      reviews_analyzed: (card.reviews || []).length,
      generated_at: new Date().toISOString(),
      brief,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/wb/compare", auth, async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, error: "Не настроен ANTHROPIC_API_KEY" });
    const myNm = String(req.body?.my_nm_id || "");
    const compNm = String(req.body?.competitor_nm_id || "");
    if (!myNm || !compNm) return res.status(400).json({ ok: false, error: "Нужны my_nm_id и competitor_nm_id." });
    const cards = getUserWbCards(req.user.id);
    const mine = cards[myNm];
    const competitor = cards[compNm];
    if (!mine || !competitor) return res.status(400).json({ ok: false, error: "Обе карточки должны быть предварительно загружены через /api/wb/fetch." });
    const comparison = await generateCompetitorComparison(mine, competitor, req.user);
    addUserLog(req.user.id, `⚖️ Сравнение ${mine.nm_id} vs ${competitor.nm_id} готово`, "success");
    res.json({
      ok: true,
      my_nm_id: mine.nm_id,
      competitor_nm_id: competitor.nm_id,
      generated_at: new Date().toISOString(),
      comparison,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── WB периодические снимки + сравнение по периодам ────────────────────────
app.post("/api/wb/snapshot", auth, async (req, res) => {
  try {
    const input = req.body?.input || req.body?.nm_id;
    if (!input) return res.status(400).json({ ok: false, error: "Нужен input или nm_id" });
    const snap = await takeWbSnapshot(req.user.id, input, {
      label: req.body?.label || "",
      notes: req.body?.notes || "",
      reviewsKeep: Math.min(500, Math.max(50, Number(req.body?.reviews_keep) || 200)),
    });
    addUserLog(req.user.id, `📸 Снимок WB nm ${snap.card.nm_id}: «${snap.label || "без метки"}», рейтинг ${snap.card.rating}, отзывов ${snap.reviews_total}`, "info");
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/wb/snapshots/:nmId", auth, (req, res) => {
  const list = getUserWbSnapshots(req.user.id)[String(req.params.nmId)] || [];
  res.json({
    nm_id: Number(req.params.nmId),
    snapshots: list.map((s) => ({
      snapshot_id: s.snapshot_id,
      taken_at: s.taken_at,
      label: s.label,
      notes: s.notes,
      rating: s.card?.rating,
      feedbacks: s.card?.feedbacks,
      price: s.card?.price,
      reviews_sampled: (s.reviews_sample || []).length,
      reviews_total: s.reviews_total,
    })),
  });
});

app.delete("/api/wb/snapshots/:nmId/:snapshotId", auth, (req, res) => {
  const all = getUserWbSnapshots(req.user.id);
  const key = String(req.params.nmId);
  const list = all[key] || [];
  const before = list.length;
  all[key] = list.filter((s) => s.snapshot_id !== req.params.snapshotId);
  if (all[key].length === before) return res.status(404).json({ ok: false, error: "Снимок не найден" });
  if (!all[key].length) delete all[key];
  setUserWbSnapshots(req.user.id, all);
  res.json({ ok: true });
});

app.post("/api/wb/period-compare", auth, async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, error: "Не настроен ANTHROPIC_API_KEY" });
    const nmKey = String(req.body?.nm_id || "");
    const beforeId = String(req.body?.before_id || "");
    const afterId = String(req.body?.after_id || "");
    if (!nmKey || !beforeId || !afterId) return res.status(400).json({ ok: false, error: "Нужны nm_id, before_id и after_id" });
    if (beforeId === afterId) return res.status(400).json({ ok: false, error: "before_id и after_id должны различаться" });
    const list = getUserWbSnapshots(req.user.id)[nmKey] || [];
    const before = list.find((s) => s.snapshot_id === beforeId);
    const after = list.find((s) => s.snapshot_id === afterId);
    if (!before || !after) return res.status(404).json({ ok: false, error: "Один из снимков не найден в кеше" });
    const sortedBefore = new Date(before.taken_at) > new Date(after.taken_at) ? after : before;
    const sortedAfter = sortedBefore === before ? after : before;
    const comparison = await generatePeriodComparison(sortedBefore, sortedAfter, {
      change_notes: req.body?.change_notes || "",
    }, req.user);
    addUserLog(req.user.id, `🔁 Сравнение периодов nm ${nmKey}: «${sortedBefore.label || "до"}» → «${sortedAfter.label || "после"}»`, "success");
    res.json({
      ok: true,
      nm_id: Number(nmKey),
      before: { snapshot_id: sortedBefore.snapshot_id, label: sortedBefore.label, taken_at: sortedBefore.taken_at, rating: sortedBefore.card?.rating, feedbacks: sortedBefore.card?.feedbacks },
      after: { snapshot_id: sortedAfter.snapshot_id, label: sortedAfter.label, taken_at: sortedAfter.taken_at, rating: sortedAfter.card?.rating, feedbacks: sortedAfter.card?.feedbacks },
      generated_at: new Date().toISOString(),
      comparison,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Chats: автоответы в диалогах с покупателями (Ozon) ────────────────────
app.post("/api/chats/sync", auth, async (req, res) => {
  try {
    const cid = req.user.ozon_client_id, key = req.user.ozon_api_key;
    if (!cid || !key) return res.status(400).json({ ok: false, error: "Не настроены Ozon Client-Id и API-key" });
    const r = await syncOzonChats(req.user.id, cid, key, {
      limitChats: Math.min(200, Number(req.body?.limit_chats) || 50),
      status: String(req.body?.status || "All"),
    });
    if (r.skipped) {
      addUserLog(req.user.id, `⚠️ Чаты Ozon: ${r.reason}`, "warn");
      return res.json({ ok: true, skipped: true, reason: r.reason });
    }
    addUserLog(req.user.id, `📥 Чаты Ozon синхронизированы: ${r.chats_local} (+${r.updated} новых, ${r.new_messages} новых сообщений)`, "success");
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: formatApiErrorMessage(e) }); }
});

// Диагностика: показать сырой ответ Ozon /v3/chat/list для проверки структуры
app.post("/api/chats/debug", auth, async (req, res) => {
  try {
    const cid = req.user.ozon_client_id, key = req.user.ozon_api_key;
    if (!cid || !key) return res.status(400).json({ ok: false, error: "Не настроены Ozon Client-Id и API-key" });
    const status = String(req.body?.status || "All");
    const limit = Math.min(50, Number(req.body?.limit) || 5);
    const raw = await fetchOzonChatList(cid, key, { limit, status });
    const list = raw?.chats || raw?.result?.chats || raw?.result || [];
    res.json({
      ok: true,
      raw_response: raw,
      detected_chats_count: Array.isArray(list) ? list.length : 0,
      first_chat_keys: Array.isArray(list) && list[0] ? Object.keys(list[0]) : [],
      first_chat: Array.isArray(list) ? list[0] : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: formatApiErrorMessage(e), payload: getApiErrorPayload(e) });
  }
});

app.get("/api/chats", auth, (req, res) => {
  const store = getUserChatsStore(req.user.id);
  const f = String(req.query.filter || "all");
  let index = (store.index || []).slice();
  if (f === "unread") index = index.filter((x) => (x.unread_count || 0) > 0);
  if (f === "escalated") index = index.filter((x) => store.threads?.[x.chat_id]?.escalated);
  if (f === "drafted") index = index.filter((x) => store.threads?.[x.chat_id]?.ai_draft);
  const REPLY_WINDOW_HOURS = 48;
  const now = Date.now();
  // Сортируем по дате последнего сообщения (свежие сверху)
  const sortedIndex = index.slice().sort((a, b) => (new Date(b.last_message_at || 0)) - (new Date(a.last_message_at || 0)));
  // Фильтруем системные чаты — оставляем только диалоги где есть РЕАЛЬНОЕ сообщение от покупателя
  // (Ozon возвращает chat_type=BUYER_SELLER даже для системных нотификаций, поэтому смотрим на содержимое треда)
  const SYSTEM_AUTHORS = ["ozon", "озон", "robot", "бот", "ozon support", "поддержка ozon", "система"];
  const buyerOnly = sortedIndex.filter((m) => {
    const showAll = req.query.include_system === "1";
    if (showAll) return true;
    const t = store.threads?.[m.chat_id];
    if (!t || !Array.isArray(t.messages) || !t.messages.length) return false;
    return t.messages.some((msg) => {
      if (msg.is_from_seller) return false;
      const author = String(msg.user_name || "").toLowerCase();
      // Системные «от покупателя» имеют user_name типа "Ozon", "Бот", иногда "Продавец" (странный quirk Ozon)
      if (!author || author === "продавец" || SYSTEM_AUTHORS.some((s) => author.includes(s))) return false;
      // Сообщение от системы часто содержит markdown-разметку или специфичные ссылки на seller.ozon.ru
      const txt = String(msg.text || "");
      if (/seller\.ozon\.ru|seller-edu\.ozon\.ru/i.test(txt)) return false;
      return txt.trim().length > 0;
    });
  });
  const items = buyerOnly.map((m) => {
    const t = store.threads?.[m.chat_id] || {};
    const msgs = t.messages || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const lastBuyerMsg = [...msgs].reverse().find((x) => !x.is_from_seller);
    const lastBuyerAt = lastBuyerMsg?.created_at ? new Date(lastBuyerMsg.created_at).getTime() : null;
    const hoursSinceBuyer = lastBuyerAt ? Math.round((now - lastBuyerAt) / 36e5) : null;
    const windowExpired = lastBuyerAt ? (now - lastBuyerAt) > REPLY_WINDOW_HOURS * 36e5 : false;
    const preview = m.last_message_text && m.last_message_text.trim()
      ? m.last_message_text
      : (last ? last.text : "");
    return {
      ...m,
      last_message_text: preview,
      last_message_from_seller: last ? !!last.is_from_seller : false,
      messages_count: msgs.length,
      last_buyer_hours_ago: hoursSinceBuyer,
      reply_window_expired: windowExpired,
      reply_window_hours: REPLY_WINDOW_HOURS,
      intent: t.intent || null,
      escalated: !!t.escalated,
      has_draft: !!t.ai_draft,
    };
  });
  res.json({ chats: items, intents: CHAT_INTENT_LABELS, reply_window_hours: REPLY_WINDOW_HOURS });
});

function buildChatResponse(uid, chatId) {
  const store = getUserChatsStore(uid);
  const meta = (store.index || []).find((x) => x.chat_id === String(chatId));
  const thread = store.threads?.[String(chatId)];
  if (!meta || !thread) return null;
  const msgs = thread.messages || [];
  const lastBuyer = [...msgs].reverse().find((x) => !x.is_from_seller);
  const lastBuyerAt = lastBuyer?.created_at ? new Date(lastBuyer.created_at).getTime() : null;
  const hours = lastBuyerAt ? Math.round((Date.now() - lastBuyerAt) / 36e5) : null;
  const windowExpired = lastBuyerAt ? (Date.now() - lastBuyerAt) > 48 * 36e5 : false;
  return {
    ...meta, ...thread,
    last_buyer_hours_ago: hours,
    reply_window_expired: windowExpired,
    reply_window_hours: 48,
  };
}

app.get("/api/chats/:chatId", auth, (req, res) => {
  const chat = buildChatResponse(req.user.id, req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: "Чат не найден" });
  res.json({ ok: true, chat });
});

app.post("/api/chats/:chatId/generate", auth, async (req, res) => {
  try {
    const store = getUserChatsStore(req.user.id);
    const chatId = String(req.params.chatId);
    const thread = store.threads?.[chatId];
    if (!thread) return res.status(404).json({ ok: false, error: "Диалог не найден. Сначала /api/chats/sync" });
    let productCtx = "";
    if (req.body?.sku && req.user.ozon_client_id && req.user.ozon_api_key) {
      try {
        await ensureProductData(req.user.id, req.user.ozon_client_id, req.user.ozon_api_key, [req.body.sku]);
        productCtx = buildProductContextForPrompt(getUserProducts(req.user.id)[String(req.body.sku)]);
      } catch {}
    }
    const out = await generateChatReply(thread, productCtx, req.user, "Ozon");
    thread.ai_draft = String(out.reply || "");
    thread.intent = out.intent || null;
    thread.escalated = !!out.escalate;
    thread.internal_note = String(out.internal_note || "");
    thread.ai_draft_at = new Date().toISOString();
    store.threads[chatId] = thread;
    setUserChatsStore(req.user.id, store);
    res.json({ ok: true, chat: buildChatResponse(req.user.id, chatId) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch("/api/chats/:chatId", auth, (req, res) => {
  const store = getUserChatsStore(req.user.id);
  const chatId = String(req.params.chatId);
  const thread = store.threads?.[chatId];
  if (!thread) return res.status(404).json({ ok: false, error: "Не найден" });
  if (typeof req.body?.ai_draft === "string") thread.ai_draft = req.body.ai_draft;
  if (typeof req.body?.internal_note === "string") thread.internal_note = req.body.internal_note;
  store.threads[chatId] = thread;
  setUserChatsStore(req.user.id, store);
  res.json({ ok: true, chat: buildChatResponse(req.user.id, chatId) });
});

app.post("/api/chats/:chatId/escalate", auth, (req, res) => {
  const store = getUserChatsStore(req.user.id);
  const chatId = String(req.params.chatId);
  const thread = store.threads?.[chatId];
  if (!thread) return res.status(404).json({ ok: false, error: "Не найден" });
  thread.escalated = req.body?.escalated !== false;
  if (typeof req.body?.internal_note === "string") thread.internal_note = req.body.internal_note;
  store.threads[chatId] = thread;
  setUserChatsStore(req.user.id, store);
  addUserLog(req.user.id, `🚨 Чат ${chatId} ${thread.escalated ? "помечен как требующий человека" : "снят с эскалации"}`, "info");
  res.json({ ok: true, chat: buildChatResponse(req.user.id, chatId) });
});

app.post("/api/chats/:chatId/send", auth, async (req, res) => {
  try {
    const cid = req.user.ozon_client_id, key = req.user.ozon_api_key;
    if (!cid || !key) return res.status(400).json({ ok: false, error: "Не настроены Ozon ключи" });
    const store = getUserChatsStore(req.user.id);
    const chatId = String(req.params.chatId);
    const thread = store.threads?.[chatId];
    if (!thread) return res.status(404).json({ ok: false, error: "Чат не найден" });
    const text = String(req.body?.text || thread.ai_draft || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Нет текста ответа" });
    await sendOzonChatMessage(cid, key, chatId, text);
    thread.messages.push({
      message_id: `local-${Date.now()}`,
      text, content_type: "Message", is_from_seller: true,
      user_name: req.user.name || req.user.email || "Продавец",
      created_at: new Date().toISOString(),
    });
    thread.ai_draft = "";
    thread.last_sent_at = new Date().toISOString();
    store.threads[chatId] = thread;
    const meta = (store.index || []).find((x) => x.chat_id === chatId);
    if (meta) { meta.last_message_text = text.slice(0, 500); meta.last_message_at = new Date().toISOString(); meta.unread_count = 0; }
    setUserChatsStore(req.user.id, store);
    addUserLog(req.user.id, `📤 Сообщение отправлено в чат Ozon ${chatId}`, "success");
    res.json({ ok: true, chat: buildChatResponse(req.user.id, chatId) });
  } catch (e) {
    const msg = formatApiErrorMessage(e).toLowerCase();
    if (msg.includes("access period has expired") || msg.includes("actions with this chat not permitted")) {
      return res.status(409).json({
        ok: false,
        error: "Окно ответа в Ozon истекло. Через API можно отвечать только в течение ~48 часов после последнего сообщения покупателя. Ответьте в личном кабинете Ozon в браузере.",
        reason: "ozon_chat_window_expired",
      });
    }
    if (isOzonPublishForbidden(e)) return res.status(403).json({ ok: false, error: "Ozon не разрешил отправку этого сообщения через API." });
    res.status(500).json({ ok: false, error: formatApiErrorMessage(e) });
  }
});

// ─── WB Seller: отзывы и вопросы (приватный API, требует токен) ─────────────
const WB_SYNC_COOLDOWN_MS = 30 * 1000;
const wbSyncCooldown = new Map(); // uid → last sync ts

app.post("/api/wb-seller/sync", auth, async (req, res) => {
  try {
    const key = req.user.wb_api_key;
    if (!key) return res.status(400).json({ ok: false, error: "Не настроен WB API ключ в Settings" });
    // Если у WB активен глобальный бан — не пытаемся
    const wbBan = wbBanRemainingSec(key);
    if (wbBan > 0) {
      return res.status(429).json({
        ok: false,
        error: `WB API лимит активен. Подождите ${wbBan} сек (≈ ${Math.ceil(wbBan/60)} мин). Это бан со стороны WB, не наше ограничение.`,
        retry_after: wbBan,
      });
    }
    // Защита от частых кликов (WB имеет жёсткий rate limit)
    const last = wbSyncCooldown.get(req.user.id) || 0;
    const remaining = Math.ceil((WB_SYNC_COOLDOWN_MS - (Date.now() - last)) / 1000);
    if (remaining > 0) {
      return res.status(429).json({
        ok: false,
        error: `Подождите ${remaining} сек перед следующей синхронизацией WB (наш cooldown).`,
        retry_after: remaining,
      });
    }
    wbSyncCooldown.set(req.user.id, Date.now());
    const type = String(req.body?.type || "both");
    const includeAnswered = req.body?.include_answered === true || req.body?.include_answered === "true";
    const result = {};
    if (type === "reviews" || type === "both") {
      result.feedbacks = await syncWbSellerFeedbacks(req.user.id, key, { includeAnswered, baseUrl: wbSellerBase(req.user) });
      addUserLog(req.user.id, `📥 WB отзывы: +${result.feedbacks.added} новых · в кэше ${result.feedbacks.total_local}${includeAnswered?` (без ответа ${result.feedbacks.unanswered}, отвеченных ${result.feedbacks.answered})`:""}`, "success");
      if (type === "both") await new Promise((r) => setTimeout(r, 1500));
    }
    if (type === "questions" || type === "both") {
      result.questions = await syncWbSellerQuestions(req.user.id, key, { includeAnswered, baseUrl: wbSellerBase(req.user) });
      addUserLog(req.user.id, `📥 WB вопросы: +${result.questions.added} новых · в кэше ${result.questions.total_local}${includeAnswered?` (без ответа ${result.questions.unanswered}, отвеченных ${result.questions.answered})`:""}`, "success");
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === "wb_rate_limit") {
      return res.status(429).json({ ok: false, error: e.message, retry_after: e.retryAfter || 30 });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/wb-seller/reviews", auth, (req, res) => {
  const f = String(req.query.filter || "all");
  let list = getUserWbFeedbacksStore(req.user.id);
  if (f === "pending") list = list.filter((x) => x.status === "pending");
  else if (f === "ready") list = list.filter((x) => x.status === "ready");
  else if (f === "posted") list = list.filter((x) => x.status === "posted");
  res.json({ reviews: list });
});

app.get("/api/wb-seller/questions", auth, (req, res) => {
  const f = String(req.query.filter || "all");
  let list = getUserWbQuestionsStore(req.user.id);
  if (f === "pending") list = list.filter((x) => x.status_ai === "pending");
  else if (f === "ready") list = list.filter((x) => x.status_ai === "ready");
  else if (f === "posted") list = list.filter((x) => x.status_ai === "posted");
  res.json({ questions: list });
});

// Preview AI-ответ для тестов: НЕ сохраняет, НЕ публикует — просто отдаёт что AI ответил бы
app.post("/api/wb-seller/reviews/:id/preview-ai", auth, async (req, res) => {
  try {
    const item = getUserWbFeedbacksStore(req.user.id).find((x) => x.review_id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Отзыв не найден" });
    const reviewText = [item.text, item.pros ? `Плюсы: ${item.pros}` : "", item.cons ? `Минусы: ${item.cons}` : ""].filter(Boolean).join(" ").trim();
    if (!reviewText) return res.status(400).json({ ok: false, error: "У отзыва нет текста — AI не на что отвечать." });
    const { sentiment, response: aiResp } = await analyzeReview(reviewText, item.rating, req.user.shop_name || item.product?.brand || "", req.user, "Wildberries");
    const { provider, model } = resolveAiConfig(req.user);
    res.json({
      ok: true,
      review_id: item.review_id,
      review_text: reviewText,
      rating: item.rating,
      existing_answer: item.existing_answer || (item.is_answered ? "(текст ответа не возвращён WB)" : ""),
      ai_answer: aiResp,
      sentiment,
      provider, model,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Preview AI для вопросов
app.post("/api/wb-seller/questions/:id/preview-ai", auth, async (req, res) => {
  try {
    const item = getUserWbQuestionsStore(req.user.id).find((x) => x.question_id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Вопрос не найден" });
    if (!item.text) return res.status(400).json({ ok: false, error: "У вопроса нет текста." });
    let productCtx = "";
    if (item.product?.nm_id) {
      try {
        const card = await ensureWbCard(req.user.id, String(item.product.nm_id), { force: false, maxReviews: 30 });
        const lines = [];
        if (card.name) lines.push(`Название: ${card.name}`);
        if (card.brand) lines.push(`Бренд: ${card.brand}`);
        if (Array.isArray(card.characteristics) && card.characteristics.length) {
          lines.push("Характеристики:");
          for (const c of card.characteristics.slice(0, 50)) lines.push(`- ${c.name}: ${c.value}`);
        }
        if (card.description) lines.push("Описание:\n" + card.description.slice(0, 2000));
        productCtx = lines.join("\n");
      } catch {}
    }
    const productUrl = item.product?.nm_id ? `https://www.wildberries.ru/catalog/${item.product.nm_id}/detail.aspx` : "";
    const aiAnswer = await answerQuestion(item.text, productUrl, productCtx, req.user, "Wildberries");
    const { provider, model } = resolveAiConfig(req.user);
    res.json({
      ok: true,
      question_id: item.question_id,
      question_text: item.text,
      existing_answer: item.existing_answer || (item.is_answered ? "(текст ответа не возвращён WB)" : ""),
      ai_answer: aiAnswer,
      provider, model,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Текущий бан WB API (для индикатора в UI)
app.get("/api/wb-seller/status", auth, (req, res) => {
  const banLeft = req.user.wb_api_key ? wbBanRemainingSec(req.user.wb_api_key) : 0;
  const last = wbSyncCooldown.get(req.user.id) || 0;
  const cooldown = Math.max(0, Math.ceil((WB_SYNC_COOLDOWN_MS - (Date.now() - last)) / 1000));
  res.json({
    ok: true,
    has_key: !!req.user.wb_api_key,
    wb_ban_sec: banLeft,
    sync_cooldown_sec: cooldown,
  });
});

// Ручной сброс локального ban-таймера (на свой страх и риск).
// Если WB всё ещё держит токен в бане — следующий запрос тут же получит 429 и таймер вернётся.
app.post("/api/wb-seller/clear-ban", auth, (req, res) => {
  if (!req.user.wb_api_key) return res.status(400).json({ ok: false, error: "Нет WB ключа" });
  wbBanClear(req.user.wb_api_key);
  res.json({ ok: true });
});

// Лёгкая проверка: один запрос take=1. Используется чтобы понять, снял ли WB бан, без полного sync.
app.post("/api/wb-seller/probe", auth, async (req, res) => {
  if (!req.user.wb_api_key) return res.status(400).json({ ok: false, error: "Нет WB ключа" });
  const ban = wbBanRemainingSec(req.user.wb_api_key);
  if (ban > 0) {
    return res.status(429).json({ ok: false, error: `WB API ещё заблокирован на ${Math.ceil(ban/60)} мин (наш локальный таймер)`, retry_after: ban });
  }
  try {
    const r = await wbSellerRequest(req.user.wb_api_key, "GET", "/api/v1/feedbacks", { params: { isAnswered: "false", take: 1, skip: 0, order: "dateDesc" }, baseUrl: wbSellerBase(req.user) });
    const fb = r?.data?.feedbacks || r?.feedbacks || [];
    res.json({
      ok: true,
      access_ok: true,
      sample_count: fb.length,
      unanswered_total: r?.data?.countUnanswered ?? null,
      archive_total: r?.data?.countArchive ?? null,
    });
  } catch (e) {
    res.status(e.code === "wb_rate_limit" ? 429 : 500).json({ ok: false, error: e.message, retry_after: e.retryAfter });
  }
});

app.post("/api/wb-seller/reviews/:id/generate", auth, async (req, res) => {
  try {
    const list = getUserWbFeedbacksStore(req.user.id);
    const idx = list.findIndex((x) => x.review_id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Отзыв не найден" });
    const item = list[idx];
    const reviewText = [item.text, item.pros ? `Плюсы: ${item.pros}` : "", item.cons ? `Минусы: ${item.cons}` : ""].filter(Boolean).join(" ").trim();
    const { sentiment, response: aiResp } = await analyzeReview(reviewText, item.rating, req.user.shop_name || item.product?.brand || "", req.user, "Wildberries");
    item.sentiment = sentiment;
    item.ai_response = aiResp;
    item.status = "ready";
    list[idx] = item;
    setUserWbFeedbacksStore(req.user.id, list);
    res.json({ ok: true, sentiment, ai_response: aiResp });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch("/api/wb-seller/reviews/:id", auth, (req, res) => {
  const list = getUserWbFeedbacksStore(req.user.id);
  const idx = list.findIndex((x) => x.review_id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "Не найден" });
  if (typeof req.body?.ai_response !== "string") return res.status(400).json({ ok: false, error: "Нужен ai_response" });
  list[idx].ai_response = req.body.ai_response;
  if (list[idx].status === "pending") list[idx].status = "ready";
  setUserWbFeedbacksStore(req.user.id, list);
  res.json({ ok: true });
});

app.post("/api/wb-seller/reviews/:id/post", auth, async (req, res) => {
  try {
    const key = req.user.wb_api_key;
    if (!key) return res.status(400).json({ ok: false, error: "Не настроен WB API ключ" });
    const list = getUserWbFeedbacksStore(req.user.id);
    const idx = list.findIndex((x) => x.review_id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Отзыв не найден" });
    const item = list[idx];
    const text = String(req.body?.text || item.ai_response || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Нет текста ответа" });
    await postWbSellerFeedbackAnswer(key, item.review_id, text);
    item.ai_response = text;
    item.status = "posted";
    item.posted_at = new Date().toISOString();
    list[idx] = item;
    setUserWbFeedbacksStore(req.user.id, list);
    addUserLog(req.user.id, `📤 WB: ответ на отзыв ${item.review_id} опубликован`, "success");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/wb-seller/questions/:id/generate", auth, async (req, res) => {
  try {
    const list = getUserWbQuestionsStore(req.user.id);
    const idx = list.findIndex((x) => x.question_id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Вопрос не найден" });
    const item = list[idx];
    let productCtx = "";
    if (item.product?.nm_id) {
      try {
        const card = await ensureWbCard(req.user.id, String(item.product.nm_id), { force: false, maxReviews: 50 });
        const lines = [];
        if (card.name) lines.push(`Название: ${card.name}`);
        if (card.brand) lines.push(`Бренд: ${card.brand}`);
        if (card.price) lines.push(`Цена: ${card.price} ₽`);
        if (Array.isArray(card.characteristics) && card.characteristics.length) {
          lines.push("Характеристики:");
          for (const c of card.characteristics.slice(0, 60)) lines.push(`- ${c.name}: ${c.value}`);
        }
        if (card.description) lines.push("Описание:\n" + card.description.slice(0, 3000));
        productCtx = lines.join("\n");
      } catch {}
    }
    const aiAnswer = await answerQuestion(item.text, item.product?.nm_id ? `https://www.wildberries.ru/catalog/${item.product.nm_id}/detail.aspx` : "", productCtx, req.user, "Wildberries");
    item.ai_response = aiAnswer;
    item.status_ai = "ready";
    list[idx] = item;
    setUserWbQuestionsStore(req.user.id, list);
    res.json({ ok: true, ai_response: aiAnswer });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch("/api/wb-seller/questions/:id", auth, (req, res) => {
  const list = getUserWbQuestionsStore(req.user.id);
  const idx = list.findIndex((x) => x.question_id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "Не найден" });
  if (typeof req.body?.ai_response !== "string") return res.status(400).json({ ok: false, error: "Нужен ai_response" });
  list[idx].ai_response = req.body.ai_response;
  if (list[idx].status_ai === "pending") list[idx].status_ai = "ready";
  setUserWbQuestionsStore(req.user.id, list);
  res.json({ ok: true });
});

app.post("/api/wb-seller/questions/:id/post", auth, async (req, res) => {
  try {
    const key = req.user.wb_api_key;
    if (!key) return res.status(400).json({ ok: false, error: "Не настроен WB API ключ" });
    const list = getUserWbQuestionsStore(req.user.id);
    const idx = list.findIndex((x) => x.question_id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Вопрос не найден" });
    const item = list[idx];
    const text = String(req.body?.text || item.ai_response || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Нет текста ответа" });
    await postWbSellerQuestionAnswer(key, item.question_id, text);
    item.ai_response = text;
    item.status_ai = "posted";
    item.posted_at = new Date().toISOString();
    list[idx] = item;
    setUserWbQuestionsStore(req.user.id, list);
    addUserLog(req.user.id, `📤 WB: ответ на вопрос ${item.question_id} опубликован`, "success");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Settings
app.get("/api/settings", auth, (req, res) => {
  res.json(sanitizeUser(req.user));
});

app.post("/api/settings", auth, (req, res) => {
  const { ozon_client_id, ozon_api_key, wb_api_key, wb_use_sandbox, openrouter_api_key, auto_post, cron_interval, shop_name, ai_tone_preset, ai_tone_custom, ai_provider, ai_model } = req.body;
  const users = getUsers();
  const i = users.findIndex(u => u.id === req.user.id);
  if (i < 0) return res.status(404).json({ error: "Пользователь не найден" });
  if (cron_interval !== undefined && cron_interval && !cron.validate(String(cron_interval))) {
    return res.status(400).json({ error: "Некорректный cron interval" });
  }
  if (ozon_client_id !== undefined) users[i].ozon_client_id = ozon_client_id;
  if (ozon_api_key !== undefined) {
    const normalizedKey = String(ozon_api_key || "").trim();
    if (normalizedKey) {
      users[i].ozon_api_key_encrypted = encryptSecret(normalizedKey);
      users[i].ozon_api_key_hint = buildSecretHint(normalizedKey);
    } else {
      delete users[i].ozon_api_key_encrypted;
      users[i].ozon_api_key_hint = "";
    }
    delete users[i].ozon_api_key;
  }
  if (wb_api_key !== undefined) {
    const normalizedKey = String(wb_api_key || "").trim();
    // При смене WB-ключа сбрасываем persistent ban для НОВОГО токена —
    // т.к. наш ban мог накопиться от прошлых попыток с этим же ключом, а пользователь хочет начать чисто
    if (normalizedKey) {
      try { wbBanClear(normalizedKey); } catch {}
      users[i].wb_api_key_encrypted = encryptSecret(normalizedKey);
      users[i].wb_api_key_hint = buildSecretHint(normalizedKey);
    } else {
      delete users[i].wb_api_key_encrypted;
      users[i].wb_api_key_hint = "";
    }
    delete users[i].wb_api_key;
  }
  if (openrouter_api_key !== undefined) {
    const normalizedKey = String(openrouter_api_key || "").trim();
    if (normalizedKey) {
      users[i].openrouter_api_key_encrypted = encryptSecret(normalizedKey);
      users[i].openrouter_api_key_hint = buildSecretHint(normalizedKey);
    } else {
      delete users[i].openrouter_api_key_encrypted;
      users[i].openrouter_api_key_hint = "";
    }
    delete users[i].openrouter_api_key;
  }
  if (ai_provider !== undefined) {
    const p = String(ai_provider || "").trim();
    users[i].ai_provider = (p === "openrouter" || p === "anthropic") ? p : DEFAULT_AI_PROVIDER;
  }
  if (ai_model !== undefined) {
    users[i].ai_model = String(ai_model || "").trim().slice(0, 200);
  }
  if (ai_tone_preset !== undefined) {
    const id = String(ai_tone_preset || "").trim();
    users[i].ai_tone_preset = TONE_PRESETS[id] ? id : DEFAULT_TONE_ID;
  }
  if (ai_tone_custom !== undefined) {
    users[i].ai_tone_custom = String(ai_tone_custom || "").slice(0, 4000);
  }
  if (auto_post      !== undefined) users[i].auto_post       = auto_post === "true" || auto_post === true;
  if (wb_use_sandbox !== undefined) users[i].wb_use_sandbox   = wb_use_sandbox === "true" || wb_use_sandbox === true;
  if (cron_interval  !== undefined) users[i].cron_interval   = cron_interval;
  if (shop_name      !== undefined) users[i].shop_name        = sanitizeNameInput(shop_name);
  saveUsers(users);
  addUserLog(req.user.id, "⚙️ Настройки обновлены", "info");
  res.json({ ok: true });
});

// Список пресетов тональности для UI
app.get("/api/tone/presets", auth, (req, res) => {
  const presets = Object.entries(TONE_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    description: p.description,
    persona: p.persona,
    rules: p.rules,
  }));
  res.json({ presets, default: DEFAULT_TONE_ID, current: req.user.ai_tone_preset || DEFAULT_TONE_ID });
});

// Проверка WB API ключа
app.post("/api/test-wb", auth, async (req, res) => {
  const key = String(req.body?.wb_api_key || req.user.wb_api_key || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "Не указан WB API ключ" });
  try {
    const data = await wbSellerRequest(key, "GET", "/api/v1/feedbacks", { params: { isAnswered: "false", take: 1, skip: 0, order: "dateDesc" }, baseUrl: wbSellerBase(req.user) });
    const total = data?.data?.countUnanswered ?? data?.data?.countArchive ?? data?.countUnanswered ?? null;
    res.json({ ok: true, sample_count: (data?.data?.feedbacks || data?.feedbacks || []).length, unanswered: total });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── AI provider routes ─────────────────────────────────────────────────────
app.get("/api/ai/models", auth, (req, res) => {
  res.json({
    ok: true,
    providers: [
      { id: "anthropic", label: "Anthropic (нативный SDK)", requires_key: "ANTHROPIC_API_KEY (.env)" },
      { id: "openrouter", label: "OpenRouter (универсальный)", requires_key: "OpenRouter API key (в Settings)" },
    ],
    models: AI_MODELS,
    current: {
      provider: req.user.ai_provider || DEFAULT_AI_PROVIDER,
      model: req.user.ai_model || ANTHROPIC_REVIEW_MODEL,
    },
  });
});

app.post("/api/test-openrouter", auth, async (req, res) => {
  const key = String(req.body?.openrouter_api_key || req.user.openrouter_api_key || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "Не указан OpenRouter API ключ" });
  try {
    const r = await axios.get("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status >= 400) return res.status(400).json({ ok: false, error: `OpenRouter ${r.status}: ${r.data?.error?.message || JSON.stringify(r.data).slice(0,160)}` });
    res.json({ ok: true, info: { label: r.data?.data?.label || null, usage: r.data?.data?.usage ?? null, limit: r.data?.data?.limit ?? null } });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/ai/tone-preview", auth, async (req, res) => {
  try {
    const sample = String(req.body?.text || "").trim() || "Товар пришёл повреждённый, коробка вмятая. Хотел сделать подарок, очень расстроен.";
    const rating = Number(req.body?.rating) || 2;
    const result = await analyzeReview(sample, rating, req.user.shop_name || "", req.user, "Wildberries");
    const { provider, model } = resolveAiConfig(req.user);
    res.json({ ok: true, sample, rating, provider, model, sentiment: result.sentiment, response: result.response });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update profile
app.patch("/api/auth/profile", auth, async (req, res) => {
  const name = req.body?.name !== undefined ? sanitizeNameInput(req.body.name) : undefined;
  const password = String(req.body?.password || "");
  const new_password = String(req.body?.new_password || "");
  const users = getUsers();
  const i = users.findIndex(u => u.id === req.user.id);
  if (i < 0) return res.status(404).json({ error: "Не найден" });
  if (name) users[i].name = name;
  if (new_password && password) {
    const ok = await bcrypt.compare(password, users[i].password);
    if (!ok) return res.status(400).json({ error: "Неверный текущий пароль" });
    if (new_password.length < 6) return res.status(400).json({ error: "Новый пароль минимум 6 символов" });
    users[i].password = await bcrypt.hash(new_password, 10);
  }
  saveUsers(users);
  res.json({ ok: true, user: sanitizeUser(users[i]) });
});

// Test Ozon
app.post("/api/test-ozon", auth, async (req, res) => {
  const cid = String(req.body.ozon_client_id || req.user.ozon_client_id || "").trim();
  const key = String(req.body.ozon_api_key   || req.user.ozon_api_key   || "").trim();
  if (!cid || !key) {
    return res.status(400).json({ ok: false, error: "Укажите Ozon Client ID и API Key в настройках." });
  }
  const result = { ok: true, reviews: null, questions: null, warnings: [] };

  try {
    const rv = await fetchReviews(cid, key);
    result.reviews = rv.length;
  } catch (error) {
    const message = formatApiErrorMessage(error);
    if (!isOzonSubscriptionDenied(error)) {
      return res.status(400).json({ ok: false, error: message });
    }
    result.reviews_error = message;
    result.warnings.push(`Отзывы недоступны на текущей подписке Ozon Seller API: ${message}`);
  }

  try {
    const qs = await fetchQuestions(cid, key);
    result.questions = qs.length;
  } catch (error) {
    const message = formatApiErrorMessage(error);
    if (!isOzonSubscriptionDenied(error)) {
      return res.status(400).json({ ok: false, error: message });
    }
    result.questions_error = message;
    result.warnings.push(`Вопросы недоступны на текущей подписке Ozon Seller API: ${message}`);
  }

  if (result.reviews === null && result.questions === null) {
    return res.status(403).json({ ok: false, error: result.warnings.join(" ") || "Ozon API недоступен на текущей подписке." });
  }

  res.json(result);
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.get("/api/admin/users", adminAuth, (req, res) => {
  const users = getUsers().map(sanitizeUser);
  res.json({ users });
});

app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Не найден" });
  const { plan, role, trial_ends } = req.body;
  if (plan)       users[i].plan       = plan;
  if (role)       users[i].role       = role;
  if (trial_ends) users[i].trial_ends = trial_ends;
  saveUsers(users);
  res.json({ ok: true, user: sanitizeUser(users[i]) });
});

// ─── Cron — запускаем для каждого пользователя ────────────────────────────────
cron.schedule("* * * * *", () => {
  const users = getUsers();
  const now   = new Date();
  for (const user of users) {
    if (!user.ozon_client_id || !user.ozon_api_key) continue;
    const schedule = user.cron_interval || "*/5 * * * *";
    if (cron.validate(schedule) && shouldRun(schedule, now)) {
      addUserLog(user.id, `⏰ Cron запуск`, "info");
      runUserCycle(user.id).catch(e => console.error("Cron error:", e.message));
    }
  }
});

// Простая проверка cron (каждые 5 мин по умолчанию)
function shouldRun(schedule, now) {
  const parts = schedule.split(" ");
  const minPart = parts[0];
  if (minPart.startsWith("*/")) {
    const interval = parseInt(minPart.slice(2));
    return now.getMinutes() % interval === 0;
  }
  return now.getMinutes() % 5 === 0;
}

app.get("/health", (_, res) => {
  const users = getUsers();
  const usersCount = users.length;
  const adminExists = users.some((u) => u.role === "admin");
  res.json({
    ok: true,
    version: "2.1.0",
    uptime_sec: Math.round(process.uptime()),
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    components: {
      jwt: !!JWT_SECRET,
      data_encryption: !!DATA_ENCRYPTION_KEY,
      anthropic_key_env: !!ANTHROPIC_KEY,
      cron_default: !!cron.validate("*/5 * * * *"),
      users: usersCount,
      admin_exists: adminExists,
    },
    docs: "/login.html → /  (UI), /wb.html (WB Studio)",
  });
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.message === "CORS blocked") {
    return res.status(403).json({ error: "CORS blocked for this origin" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 ReviewOS v2.0 на http://localhost:${PORT}`);
  console.log(`   Claude API : ${ANTHROPIC_KEY ? "✅" : "❌"}`);
  console.log(`   Auth       : JWT ✅\n`);
  console.log(`   CORS       : ${Array.from(allowedOrigins).join(", ") || "no origins configured"}\n`);
  console.log(`   Secrets    : ${secretCipherKey ? "encrypted at rest ✅" : "not configured ❌"}\n`);

  // Создаём admin только по явному запросу
  if (!getUsers().find(u => u.role === "admin")) {
    if (BOOTSTRAP_ADMIN && ADMIN_EMAIL && ADMIN_PASSWORD) {
      bcrypt.hash(ADMIN_PASSWORD, 10).then(hash => {
        const users = getUsers();
        users.push({
          id: uuidv4(), email: normalizeEmailInput(ADMIN_EMAIL), name: "Администратор",
          password: hash, role: "admin", plan: "unlimited",
          created_at: new Date().toISOString(),
          ozon_client_id: "", ozon_api_key: "",
          auto_post: false, cron_interval: "*/5 * * * *",
          shop_name: "ReviewOS",
        });
        saveUsers(users);
        console.log(`👤 Admin bootstrap выполнен для ${ADMIN_EMAIL}`);
        console.log("   ⚠️  Смените пароль после первого входа!\n");
      }).catch((error) => {
        console.error("Admin bootstrap failed:", error);
      });
    } else {
      console.warn("⚠️  Admin bootstrap disabled. Set BOOTSTRAP_ADMIN=true, ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin automatically.");
    }
  }
});

module.exports = app;
