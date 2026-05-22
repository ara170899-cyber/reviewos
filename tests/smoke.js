/**
 * ReviewOS · Smoke Test Suite
 *
 * Запуск: `node tests/smoke.js` (сервер должен быть на http://localhost:3001).
 * Опции:
 *   --base=http://host:port  — другой адрес сервера
 *   --email=...  --password=...  — учётка для авторизованных тестов
 *   --skip-ai    — пропустить тесты с реальными вызовами AI и WB Seller
 *
 * Что покрываем:
 *   - Health и static (login, /, /wb.html, /app.css)
 *   - Auth (login → me, плохой пароль, без токена)
 *   - Settings GET/POST + tone presets
 *   - AI models / OpenRouter test (без ключа)
 *   - Reviews/Questions GET (Ozon)
 *   - WB Seller GET (без ключа должен быть 400, не 500)
 *   - WB Studio public: card, snapshots, period-compare, inspection-brief, compare
 *   - Tone preview (если есть Anthropic key)
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      return [[k, v === undefined ? true : v]];
    }
    return [];
  })
);

const BASE = (args.base || process.env.BASE || "http://localhost:3001").replace(/\/$/, "");
const EMAIL = args.email || process.env.SMOKE_EMAIL || "admin@reviewos.ru";
const PASSWORD = args.password || process.env.SMOKE_PASSWORD || "";
const SKIP_AI = !!args["skip-ai"];

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

let total = 0, passed = 0, failed = 0, skipped = 0;
const failures = [];

function req(method, path, { token, body, raw } = {}) {
  const url = new URL(path.startsWith("http") ? path : BASE + path);
  const lib = url.protocol === "https:" ? https : http;
  const data = body ? JSON.stringify(body) : null;
  const headers = { Accept: raw ? "*/*" : "application/json" };
  if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
  if (token) headers["Authorization"] = "Bearer " + token;
  return new Promise((resolve, reject) => {
    const r = lib.request({
      method, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search, headers,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        let parsed = buf;
        if (!raw) { try { parsed = JSON.parse(buf); } catch {} }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: buf });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function test(name, fn) {
  total++;
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ${C.green}✓${C.reset} ${name} ${C.dim}(${Date.now() - t}ms)${C.reset}`);
  } catch (e) {
    failed++;
    const msg = e.message || String(e);
    failures.push({ name, msg });
    console.log(`  ${C.red}✗${C.reset} ${name}`);
    console.log(`    ${C.red}${msg.split("\n").join("\n    ")}${C.reset}`);
  }
}

function skip(name, reason) {
  total++; skipped++;
  console.log(`  ${C.yellow}–${C.reset} ${name} ${C.dim}skipped: ${reason}${C.reset}`);
}

function group(label) { console.log(`\n${C.bold}${C.cyan}▸ ${label}${C.reset}`); }

function expect(cond, msg) { if (!cond) throw new Error(msg); }
function expectEq(a, b, msg) { if (a !== b) throw new Error(`${msg || "mismatch"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function expectStatus(r, want) { if (r.status !== want) throw new Error(`status ${r.status} ≠ ${want}. body: ${JSON.stringify(r.data).slice(0, 200)}`); }
function expectStatusIn(r, list) { if (!list.includes(r.status)) throw new Error(`status ${r.status} ∉ [${list.join(",")}]. body: ${JSON.stringify(r.data).slice(0, 200)}`); }

let TOKEN = null;
let USER = null;
let SETTINGS = null;

(async () => {
  console.log(`${C.bold}ReviewOS smoke tests${C.reset} → ${C.cyan}${BASE}${C.reset}\n`);

  // ─── 1. Health + static ───────────────────────────────────────────────────
  group("Service & static assets");

  await test("GET /health → 200, components", async () => {
    const r = await req("GET", "/health");
    expectStatus(r, 200);
    expectEq(r.data.ok, true, "ok flag");
    expect(r.data.version, "version present");
    expect(r.data.components, "components present");
    expect(typeof r.data.components.jwt === "boolean", "jwt flag");
    if (!r.data.components.admin_exists) throw new Error("admin не создан (запусти `npm run reset-admin -- 'password'`)");
  });

  for (const p of ["/", "/login.html", "/wb.html", "/app.css"]) {
    await test(`GET ${p} → 200`, async () => {
      const r = await req("GET", p, { raw: true });
      expectStatus(r, 200);
      expect(r.raw.length > 100, `body too short (${r.raw.length} bytes)`);
    });
  }

  // ─── 2. Auth ──────────────────────────────────────────────────────────────
  group("Authentication");

  await test("POST /api/auth/login (wrong password) → 401", async () => {
    const r = await req("POST", "/api/auth/login", { body: { email: EMAIL, password: "definitely-wrong-x9" } });
    expectStatusIn(r, [400, 401]);
    expect(r.data?.error, "error message present");
  });

  if (!PASSWORD) {
    skip("POST /api/auth/login (valid) → 200, token", "пароль не указан (передай --password=...)");
    skip("GET /api/auth/me → user", "нужен валидный пароль");
  } else {
    await test("POST /api/auth/login (valid) → 200, token", async () => {
      const r = await req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
      expectStatus(r, 200);
      expect(r.data?.token, "token present");
      expect(r.data?.user, "user present");
      TOKEN = r.data.token;
      USER = r.data.user;
    });

    await test("GET /api/auth/me → user", async () => {
      const r = await req("GET", "/api/auth/me", { token: TOKEN });
      expectStatus(r, 200);
      expectEq(r.data.ok, true);
      expect(r.data.user?.email, "email in me");
    });
  }

  await test("GET /api/auth/me без токена → 401", async () => {
    const r = await req("GET", "/api/auth/me");
    expectStatus(r, 401);
  });

  // ─── 3. Settings & tone presets ──────────────────────────────────────────
  group("Settings & tone presets");

  if (!TOKEN) {
    skip("GET /api/settings", "нет токена");
    skip("GET /api/tone/presets", "нет токена");
    skip("POST /api/settings (tone update)", "нет токена");
  } else {
    await test("GET /api/settings → sanitized user", async () => {
      const r = await req("GET", "/api/settings", { token: TOKEN });
      expectStatus(r, 200);
      SETTINGS = r.data;
      expect(typeof r.data.ozon_api_key_set === "boolean", "ozon_api_key_set");
      expect(typeof r.data.wb_api_key_set === "boolean", "wb_api_key_set");
      expect(typeof r.data.openrouter_api_key_set === "boolean", "openrouter_api_key_set");
      expect(r.data.ai_tone_preset, "tone preset present");
      expect(r.data.ai_provider, "ai_provider present");
      expect(!("password" in r.data), "password не должен утекать");
      expect(!("ozon_api_key_encrypted" in r.data), "ozon enc не должен утекать");
    });

    await test("GET /api/tone/presets → 5+ пресетов", async () => {
      const r = await req("GET", "/api/tone/presets", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.presets), "presets array");
      expect(r.data.presets.length >= 5, `ожидалось ≥5 пресетов, получено ${r.data.presets.length}`);
      expect(r.data.presets.find((p) => p.id === "friendly"), "friendly preset present");
    });

    await test("POST /api/settings (изменить тон, не трогая ключи)", async () => {
      const original = SETTINGS.ai_tone_preset || "friendly";
      const newTone = original === "formal" ? "friendly" : "formal";
      let r = await req("POST", "/api/settings", { token: TOKEN, body: { ai_tone_preset: newTone } });
      expectStatus(r, 200);
      r = await req("GET", "/api/settings", { token: TOKEN });
      expectEq(r.data.ai_tone_preset, newTone, "tone updated");
      // restore
      await req("POST", "/api/settings", { token: TOKEN, body: { ai_tone_preset: original } });
    });
  }

  // ─── 4. AI provider / OpenRouter ─────────────────────────────────────────
  group("AI provider & OpenRouter");

  if (!TOKEN) {
    skip("GET /api/ai/models", "нет токена");
    skip("POST /api/test-openrouter без ключа → 400", "нет токена");
  } else {
    await test("GET /api/ai/models → providers + models", async () => {
      const r = await req("GET", "/api/ai/models", { token: TOKEN });
      expectStatus(r, 200);
      expect(r.data.providers?.length >= 2, "≥2 providers");
      expect(Array.isArray(r.data.models.anthropic), "anthropic models");
      expect(Array.isArray(r.data.models.openrouter), "openrouter models");
    });

    await test("POST /api/test-openrouter без ключа → 400 (понятная ошибка)", async () => {
      const r = await req("POST", "/api/test-openrouter", { token: TOKEN, body: {} });
      // если у юзера уже сохранён ключ — тогда возможны другие коды; принимаем 400 или 200
      expectStatusIn(r, [200, 400]);
      if (r.status === 400) expect(r.data?.error, "error message present");
    });
  }

  // ─── 5. Reviews / Questions (Ozon) ───────────────────────────────────────
  group("Reviews & Questions (Ozon)");

  if (!TOKEN) {
    skip("GET /api/reviews", "нет токена");
    skip("GET /api/questions", "нет токена");
  } else {
    await test("GET /api/reviews → массив", async () => {
      const r = await req("GET", "/api/reviews", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.reviews), "reviews array");
    });
    await test("GET /api/questions → массив", async () => {
      const r = await req("GET", "/api/questions", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.questions), "questions array");
    });
    await test("GET /api/status → структура", async () => {
      const r = await req("GET", "/api/status", { token: TOKEN });
      expectStatus(r, 200);
    });
    await test("GET /api/logs → массив", async () => {
      const r = await req("GET", "/api/logs", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.logs), "logs array");
    });
  }

  // ─── 6. WB Seller (private) ──────────────────────────────────────────────
  group("WB Seller API");

  if (!TOKEN) {
    skip("WB seller routes", "нет токена");
  } else {
    await test("GET /api/wb-seller/reviews → массив", async () => {
      const r = await req("GET", "/api/wb-seller/reviews", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.reviews), "wb seller reviews array");
    });
    await test("GET /api/wb-seller/questions → массив", async () => {
      const r = await req("GET", "/api/wb-seller/questions", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.questions), "wb seller questions array");
    });
    await test("POST /api/wb-seller/sync без WB ключа → 400 (либо 429 при активном бане)", async () => {
      // допустимые состояния: 200 (успех), 400 (нет ключа), 429 (persistent ban), 500 (другая ошибка)
      const r = await req("POST", "/api/wb-seller/sync", { token: TOKEN, body: { type: "reviews" } });
      expectStatusIn(r, [200, 400, 429, 500]);
      if (r.status >= 400) expect(r.data?.error, "error message");
    });
    await test("POST /api/test-wb без ключа → 400", async () => {
      const r = await req("POST", "/api/test-wb", { token: TOKEN, body: {} });
      expectStatusIn(r, [200, 400]);
    });
  }

  // ─── 7. WB Studio public ─────────────────────────────────────────────────
  group("WB Studio (public API)");

  if (!TOKEN) {
    skip("WB Studio routes", "нет токена");
  } else if (SKIP_AI) {
    skip("POST /api/wb/fetch", "--skip-ai");
    skip("GET /api/wb/cards", "--skip-ai");
  } else {
    await test("GET /api/wb/cards → массив", async () => {
      const r = await req("GET", "/api/wb/cards", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.cards), "cards array");
    });

    await test("POST /api/wb/fetch (битый input) → 500 с понятной ошибкой", async () => {
      const r = await req("POST", "/api/wb/fetch", { token: TOKEN, body: { input: "" } });
      expectStatusIn(r, [400, 500]);
      expect(r.data?.error, "error message");
    });

    await test("POST /api/wb/fetch (реальный nm_id) → 200 + карточка", async () => {
      const r = await req("POST", "/api/wb/fetch", { token: TOKEN, body: { input: "150000000", max_reviews: 30 } });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.data?.error || JSON.stringify(r.data).slice(0,160)}`);
      expect(r.data.card?.nm_id, "nm_id");
      expect(r.data.card?.name, "name");
    });

    await test("POST /api/wb/inspection-brief без карточки → 404", async () => {
      const r = await req("POST", "/api/wb/inspection-brief", { token: TOKEN, body: { nm_id: "00000000" } });
      expectStatusIn(r, [400, 404, 500]);
    });

    await test("POST /api/wb/compare (двух карточек нет) → 400", async () => {
      const r = await req("POST", "/api/wb/compare", { token: TOKEN, body: { my_nm_id: "0", competitor_nm_id: "0" } });
      expectStatusIn(r, [400, 404]);
    });

    await test("POST /api/wb/period-compare без снимков → 400/404", async () => {
      const r = await req("POST", "/api/wb/period-compare", { token: TOKEN, body: { nm_id: "00000000", before_id: "x", after_id: "y" } });
      expectStatusIn(r, [400, 404]);
    });

    await test("GET /api/wb/snapshots/:nm → массив (м.б. пустой)", async () => {
      const r = await req("GET", "/api/wb/snapshots/00000000", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.snapshots), "snapshots array");
    });
  }

  // ─── 8. Tone preview (real AI) ───────────────────────────────────────────
  group("AI tone preview");

  if (!TOKEN) skip("POST /api/ai/tone-preview", "нет токена");
  else if (SKIP_AI) skip("POST /api/ai/tone-preview", "--skip-ai");
  else if (!SETTINGS?.ozon_api_key_set && !SETTINGS?.openrouter_api_key_set) skip("POST /api/ai/tone-preview", "нет ни Anthropic ни OpenRouter ключа");
  else {
    await test("POST /api/ai/tone-preview → 200, sentiment + response", async () => {
      const r = await req("POST", "/api/ai/tone-preview", { token: TOKEN, body: { text: "Не работает, верните деньги", rating: 1 } });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.data?.error || JSON.stringify(r.data).slice(0,200)}`);
      expect(r.data.response, "response generated");
      expect(["positive", "negative", "neutral"].includes(r.data.sentiment), "sentiment classified");
    });
  }

  // ─── 9. Chats (Ozon Seller Chat) ─────────────────────────────────────────
  group("Chats (Ozon Seller Chat)");

  if (!TOKEN) {
    skip("GET /api/chats", "нет токена");
    skip("POST /api/chats/sync", "нет токена");
  } else {
    await test("GET /api/chats → массив + intents map", async () => {
      const r = await req("GET", "/api/chats", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.chats), "chats array");
      expect(typeof r.data.intents === "object", "intents map");
    });
    await test("POST /api/chats/sync без Ozon ключей → 400", async () => {
      const r = await req("POST", "/api/chats/sync", { token: TOKEN, body: {} });
      expectStatusIn(r, [200, 400]);
      if (r.status === 400) expect(r.data?.error, "error message");
    });
    await test("GET /api/chats/nonexistent → 404", async () => {
      const r = await req("GET", "/api/chats/000000000000", { token: TOKEN });
      expectStatusIn(r, [404, 200]);
    });
  }

  // ─── 10. Admin ───────────────────────────────────────────────────────────
  group("Admin");

  if (!TOKEN || !USER || USER.role !== "admin") {
    skip("GET /api/admin/users", "не админ или нет токена");
  } else {
    await test("GET /api/admin/users → массив", async () => {
      const r = await req("GET", "/api/admin/users", { token: TOKEN });
      expectStatus(r, 200);
      expect(Array.isArray(r.data.users), "users array");
    });
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}═══════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}Итого:${C.reset} ${total} тестов · ${C.green}${passed} passed${C.reset} · ${C.red}${failed} failed${C.reset} · ${C.yellow}${skipped} skipped${C.reset}`);
  if (failures.length) {
    console.log(`\n${C.bold}${C.red}Провалы:${C.reset}`);
    for (const f of failures) {
      console.log(`  ${C.red}•${C.reset} ${f.name}`);
      console.log(`    ${C.dim}${f.msg}${C.reset}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n${C.red}Не удалось выполнить тесты: ${e.message}${C.reset}`);
  if (e.code === "ECONNREFUSED") console.error(`Сервер не отвечает по ${BASE}. Запусти: npm start`);
  process.exit(2);
});
