// Функция Supabase «voice»: помощник-чат приложения.
// Приложение присылает сообщение (запись голоса или текст), последние реплики разговора и сводку данных семьи.
// Функция отдаёт это бесплатной модели Gemini и возвращает ответ и действия для приложения
// (поиск Google — только если задан секрет GEMINI_SEARCH=1, на бесплатном тарифе его нет).
// Режим {"mode":"receipt","image":base64} — прочитать фото чека: сумма, магазин, дата, категория.
// Сами действия выполняет приложение от имени этого человека (обычные права RLS), функция в базу не пишет.
// Нужный секрет функции (Edge Functions -> Secrets): GEMINI_API_KEY. Необязательный: GEMINI_MODEL.
// Проверку JWT в настройках функции выключить: функция проверяет вход сама.
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

// --- voice:start (обычный JavaScript, его проверяют тесты на Node) ---
const VOICE_TYPES = ['expense', 'income', 'shop', 'bought', 'task', 'task_done'];
const VOICE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'Что сказал или написал пользователь, дословно' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: VOICE_TYPES },
          amount: { type: 'number', description: 'Сумма в рублях (expense, income)' },
          category: { type: 'string', description: 'Название категории строго из списка или пусто' },
          note: { type: 'string', description: 'Что или где, коротко' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          title: { type: 'string' },
          qty: { type: 'string', description: 'Количество, только если его назвали: «2 шт», «1 кг»' },
          due: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: 'HH:MM' },
          who: { type: 'string', enum: ['me', 'other', 'all'] },
          repeat: { type: 'string', description: 'day, week, month, year или пусто' }
        },
        required: ['type']
      }
    },
    reply: { type: 'string', description: 'Ответ пользователю по-русски' }
  },
  required: ['transcript', 'actions', 'reply']
};

// ctx — сводка, которую собирает приложение (voiceCtx в index.html)
function voicePrompt(ctx, search) {
  const c = ctx || {};
  // родственник: у него в приложении только чат семьи и фото, данных бюджета нет и записывать нечего
  if (c.guest) return [
    'Ты умный и доброжелательный помощник в семейном приложении: как ChatGPT, только встроенный в приложение. Пользователь пишет или говорит по-русски.',
    'Отвечай на любые вопросы: бытовые, кулинария, сад и огород, здоровье в общих чертах, техника и телефон, переводы, тексты и поздравления, советы, расчёты.',
    search ? 'Для свежей информации (погода, новости, курсы, цены, часы работы, события) пользуйся поиском Google.'
      : 'Интернета у тебя нет. Про то, что меняется каждый день (погода, курсы, новости, цены сегодня), честно скажи, что посмотреть не можешь, и подскажи, где узнать. Общие знания отвечай как обычно.',
    `Сегодня ${c.today || ''} (${c.weekday || ''}). Пишет: ${c.me || 'пользователь'}.`,
    '',
    'Ответ — только JSON-объект, без текста до и после: {"transcript": "...", "actions": [], "reply": "..."}.',
    '- transcript — что сказал пользователь (для записи голоса — расшифровка, для текста — сам текст).',
    '- reply — твой ответ. Пиши живо, просто и по делу. Короткий вопрос — короткий ответ; рецепт или инструкция — по пунктам, каждый с новой строки, начиная с «- ». Без разметки Markdown, кроме «- » для пунктов.',
    '- actions всегда пустой: записывать что-то в приложение ты не можешь. О бюджете, делах и покупках семьи ты ничего не знаешь — так и скажи, если спросят.',
    'Если не понял или запись пустая — в reply коротко переспроси.'
  ].join('\n');
  return [
    'Ты умный помощник в семейном приложении «Семейный бюджет»: как ChatGPT, только встроенный в приложение. Пользователь пишет или говорит по-русски.',
    'Отвечай на любые вопросы: бытовые, кулинария, здоровье в общих чертах, техника, учёба, переводы, тексты, советы, расчёты, и про бюджет семьи по данным ниже.',
    search ? 'Для свежей информации (погода, новости, курсы, цены, часы работы, события) пользуйся поиском Google.'
      : 'Интернета у тебя нет. Про то, что меняется каждый день (погода, курсы, новости, цены сегодня), честно скажи, что посмотреть не можешь, и подскажи, где узнать. Общие знания отвечай как обычно.',
    `Сегодня ${c.today || ''} (${c.weekday || ''}). Пишет: ${c.me || 'пользователь'}${c.other ? '. Второй участник семьи: ' + c.other : ''}.`,
    '',
    'Ответ — только JSON-объект, без текста до и после: {"transcript": "...", "actions": [...], "reply": "..."}.',
    '- transcript — что сказал пользователь (для записи голоса — расшифровка, для текста — сам текст).',
    '- reply — твой ответ. Пиши живо и по делу, как собеседник. Короткий вопрос — короткий ответ; рецепт или инструкция — по пунктам, каждый с новой строки, начиная с «- ». Без разметки Markdown, кроме «- » для пунктов.',
    '- actions — действия в приложении. Делай их ТОЛЬКО когда пользователь явно просит что-то записать, добавить, напомнить или отметить. На вопросы и разговор actions пустой.',
    '',
    'Действия (каждое отдельным элементом actions):',
    '- expense — расход: amount, category (одно название из «Категории расходов» или пусто), note (что или где), date (по умолчанию сегодня; «вчера» — вчерашняя дата).',
    '- income — доход: так же, с «Категориями доходов».',
    '- shop — добавить в список покупок: title, qty (только если количество названо). Каждый товар — отдельное действие.',
    '- bought — отметить купленным товар из «Список покупок»: title как в списке.',
    '- task — новое дело: title, due (дата или пусто), time (HH:MM или пусто), who (me — себе, other — второму участнику, all — общее; по умолчанию all), repeat (day, week, month, year или пусто).',
    '- task_done — отметить сделанным дело из «Дела»: title как в списке.',
    '',
    'Правила для действий:',
    '- Суммы словами переводи в число: «две триста» = 2300, «полторы тысячи» = 1500, «тыщу» = 1000. Сумму не придумывай: если её нет, не делай expense, а переспроси.',
    '- Одна фраза может содержать несколько действий: «в Ленте две триста, из них пятьсот на бытовую химию» — два расхода: 1800 и 500.',
    '- «Купил молоко» без суммы — bought, если молоко есть в списке покупок; с суммой — expense.',
    '- Дни недели считай вперёд от сегодняшней даты. «Вечером» без времени — 19:00, «утром» — 09:00, «днём» — 13:00.',
    '- Если действия выполнены, в reply коротко подтверди или оставь пустым.',
    '- Удалять и изменять старые записи ты не можешь: скажи, что это делается вручную в приложении.',
    '- Можно предложить действие («добавить в список покупок?»), но выполнять — только после явной просьбы.',
    '',
    'Про бюджет: считай только по данным ниже, ничего не выдумывай. «Помесячно» — расходы и доходы по месяцам за год. Суммы пиши с «₽».',
    'Если не понял или запись пустая — actions пустой, в reply коротко переспроси.',
    '',
    'Данные семьи:',
    JSON.stringify(c)
  ].join('\n');
}

// MIME записи с телефона -> тип, который понимает Gemini (iPhone пишет audio/mp4, Android — audio/webm)
function audioMime(m) {
  const t = String(m || '').split(';')[0].trim().toLowerCase();
  if (t === 'audio/mp4' || t === 'audio/x-m4a' || t === 'audio/m4a') return 'audio/m4a';
  if (t === 'audio/mpeg' || t === 'audio/mp3') return 'audio/mp3';
  if (/^audio\/(webm|ogg|wav|aac|flac|opus|aiff)$/.test(t)) return t;
  return 'audio/webm';
}

// текст ответа модели -> { transcript, actions, reply }; выдерживает ```json, мусор вокруг,
// а если JSON нет совсем (так бывает с поиском) — весь текст считается ответом
function parseVoice(text) {
  const raw = String(text || '').trim();
  const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  let o = null;
  if (a >= 0 && b > a) { try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { o = null; } }
  if (!o || typeof o !== 'object' || !('reply' in o || 'actions' in o)) {
    return raw && !/^[{\[]/.test(raw) ? { transcript: '', actions: [], reply: raw.slice(0, 6000) } : null;
  }
  const actions = (Array.isArray(o.actions) ? o.actions : []).filter(x => x && VOICE_TYPES.includes(x.type)).slice(0, 20);
  return { transcript: String(o.transcript || '').slice(0, 1000), actions, reply: String(o.reply || '').slice(0, 6000) };
}

// прошлые реплики разговора -> contents для Gemini (роли user/model, только текст, не больше 12)
function historyContents(h) {
  const list = (Array.isArray(h) ? h : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string' && m.text.trim())
    .map(m => ({ role: m.role, parts: [{ text: m.text.slice(0, 3000) }] }));
  while (list.length && list[0].role === 'model') list.shift();      // разговор должен начинаться с пользователя
  return list;
}

// ---- распознавание чека по фото ----
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true, если на фото кассовый чек и итог читается' },
    amount: { type: 'number', description: 'Итоговая сумма к оплате в рублях' },
    store: { type: 'string', description: 'Название магазина или заведения, коротко: «Пятёрочка», «Шоколадница»' },
    date: { type: 'string', description: 'Дата покупки YYYY-MM-DD или пусто' },
    category: { type: 'string', description: 'Одна категория расходов строго из списка или пусто' },
    items: { type: 'array', items: { type: 'string' }, description: 'До 5 самых дорогих позиций, коротко' }
  },
  required: ['ok', 'amount', 'store', 'date', 'category', 'items']
};
function receiptPrompt(ctx) {
  const c = ctx || {};
  return [
    'На фото кассовый чек (обычно российский). Прочитай его и верни JSON по схеме.',
    '- amount — ИТОГ к оплате (строки «ИТОГ», «ИТОГО», «К ОПЛАТЕ», «Безналичными»), не сумма одной позиции и не НДС. Копейки — дробная часть.',
    '- store — название магазина коротко, как его называют люди («Пятёрочка», а не «ООО Агроторг»).',
    '- date — дата с чека в формате YYYY-MM-DD; если года нет или не видно — пусто.',
    '- category — одна из «Категории расходов» ниже, которая лучше всего подходит, или пусто.',
    '- items — до 5 самых дорогих позиций, коротко, без цен.',
    '- Если это не чек или итог не разобрать — ok: false, amount: 0, остальное пусто.',
    `Сегодня ${c.today || ''}.`,
    'Категории расходов: ' + JSON.stringify(c['Категории расходов'] || [])
  ].join('\n');
}
// ответ модели по чеку -> { ok, amount, store, date, category, items } с проверкой значений
function parseReceipt(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  let o; try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  const amount = Math.round(+o.amount * 100) / 100;
  const good = !!o.ok && amount > 0 && amount < 10000000;
  return { ok: good, amount: good ? amount : 0, store: String(o.store || '').trim().slice(0, 80),
    date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : '', category: String(o.category || '').trim().slice(0, 80),
    items: (Array.isArray(o.items) ? o.items : []).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 5) };
}

// источники из поиска Google (если модель искала)
function sourcesOf(cand) {
  const ch = ((cand || {}).groundingMetadata || {}).groundingChunks || [];
  const out = [];
  ch.forEach(c => { const w = c && c.web; if (w && w.uri && out.length < 4 && !out.some(x => x.uri === w.uri)) out.push({ title: String(w.title || w.uri).slice(0, 80), uri: w.uri }); });
  return out;
}
// --- voice:end ---

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (o: any, status = 200) => {
  if (status >= 400) console.error('voice: ' + status + ' ' + (o && (o.error + (o.detail ? ' ' + o.detail : ''))));
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
};

const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
let noSearchUntil = 0;      // пока функция «тёплая», помним, что поиск недавно не дали

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const env = (k: string) => Deno.env.get(k) || '';
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ error: 'no_key' }, 503);

  // только вошедший участник приложения (чтобы чужие не тратили бесплатный лимит)
  // или проверочный вызов из базы с секретом расписания (CRON_SECRET, тот же, что у push-digest)
  const cron = req.headers.get('x-cron-secret');
  if (!(cron && env('CRON_SECRET') && cron === env('CRON_SECRET'))) {
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await db.auth.getUser(token);
    if (ue || !u.user) return json({ error: 'auth' }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  // фото чека -> сумма, магазин, дата, категория (для автозаполнения новой операции)
  if (body.mode === 'receipt') {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image) return json({ error: 'empty' }, 400);
    if (image.length > 6_000_000) return json({ error: 'too_long' }, 413);
    const reqBody = JSON.stringify({
      systemInstruction: { parts: [{ text: receiptPrompt(body.ctx) }] },
      contents: [{ role: 'user', parts: [{ text: 'Вот чек.' }, { inline_data: { mime_type: /^image\/(jpeg|png|webp|heic|heif)$/.test(body.mime || '') ? body.mime : 'image/jpeg', data: image } }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RECEIPT_SCHEMA }
    });
    let r: any = null;
    const tried: string[] = [];
    for (const m of [env('GEMINI_MODEL') || 'gemini-3.8-flash', ...FALLBACK_MODELS]) {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 40000);
      try {
        const x = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: reqBody, signal: ac.signal });
        r = { status: x.status, body: await x.text(), model: m };
      } catch (e) { r = { status: 0, body: String(e), model: m }; } finally { clearTimeout(t); }
      if (r.status === 200) break;
      tried.push(m + ': ' + r.status);
      if (r.status === 401 || r.status === 403) break;
    }
    if (r.status === 429) return json({ error: 'limit' }, 429);
    if (r.status !== 200) return json({ error: 'ai', detail: r.status + ' ' + r.body.slice(0, 300), tried }, 502);
    let rc: any = null;
    try { const j = JSON.parse(r.body); rc = parseReceipt((((j.candidates || [])[0] || {}).content || {}).parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('')); } catch (_) { /* ниже */ }
    if (!rc) return json({ error: 'ai', detail: 'непонятный ответ модели', tried }, 502);
    return json({ receipt: rc, model: r.model, ...(tried.length ? { tried } : {}) });
  }

  const audio = typeof body.audio === 'string' ? body.audio : '';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (!audio && !text) return json({ error: 'empty' }, 400);
  if (audio.length > 3_000_000) return json({ error: 'too_long' }, 413);        // около минуты речи
  const ctxStr = JSON.stringify(body.ctx || {});
  if (ctxStr.length > 80_000) return json({ error: 'too_big' }, 413);

  const parts: any[] = audio
    ? [{ text: 'Запись голоса пользователя. Расшифруй её в transcript и ответь.' }, { inline_data: { mime_type: audioMime(body.mime), data: audio } }]
    : [{ text }];
  const contents = [...historyContents(body.history), { role: 'user', parts }];
  // search: с поиском Google (формат ответа тогда задаёт только инструкция); иначе — строгая схема JSON
  const request = (search: boolean, schema: boolean) => JSON.stringify({
    systemInstruction: { parts: [{ text: voicePrompt(JSON.parse(ctxStr), search) }] },
    contents,
    ...(search ? { tools: [{ google_search: {} }] } : {}),
    ...(schema ? { generationConfig: { responseMimeType: 'application/json', responseJsonSchema: VOICE_SCHEMA } } : {})
  });
  const call = async (model: string, search: boolean, schema: boolean) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 40000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: request(search, schema), signal: ac.signal });
      return { status: r.status, body: await r.text(), model };
    } catch (e) { return { status: 0, body: String(e), model }; } finally { clearTimeout(t); }
  };

  // по очереди: с поиском (умная, потом простая модель) -> умная без поиска -> запасные без поиска.
  // Поиск Google на бесплатном тарифе не дают (ответ 429), поэтому он включается секретом GEMINI_SEARCH=1
  // (когда в Google AI Studio подключена оплата). Если поиск всё равно отвечает «квота» — полчаса его не пробуем.
  const primary = env('GEMINI_MODEL') || 'gemini-3.8-flash';
  const withSearch = env('GEMINI_SEARCH') === '1' && Date.now() > noSearchUntil ? [primary, FALLBACK_MODELS[0]] : [];
  const plan: [string, boolean, boolean][] = [...withSearch.map(m => [m, true, false] as [string, boolean, boolean]),
    [primary, false, true], ...FALLBACK_MODELS.filter(m => m !== primary).map(m => [m, false, true] as [string, boolean, boolean])];
  let res: any = null, searchRefused = 0;
  const tried: string[] = [];     // почему не подошли предыдущие попытки (видно в ответе, для разбора неполадок)
  for (const [m, search, schema] of plan) {
    res = await call(m, search, schema);
    if (res.status === 200) break;
    if (search && res.status === 429 && ++searchRefused === withSearch.length) noSearchUntil = Date.now() + 30 * 60e3;
    tried.push(`${m}${search ? '+поиск' : ''}: ${res.status} ${(res.body.match(/"message":\s*"([^"]{0,160})/) || [, res.body.slice(0, 160)])[1]}`);
    if (res.status === 400 && /API key|API_KEY/i.test(res.body) || res.status === 401 || res.status === 403) break;   // ключ не тот — дальше без толку
    if (res.status === 400 && schema && /schema|responseJsonSchema|Unknown name|Invalid JSON payload/i.test(res.body)) {
      res = await call(m, false, false);                                     // схему не приняли — без неё
      if (res.status === 200) break;
    }
  }
  if (res.status === 429) return json({ error: 'limit' }, 429);
  if (res.status === 400 && /API key|API_KEY/i.test(res.body) || res.status === 401 || res.status === 403) return json({ error: 'bad_key', detail: res.body.slice(0, 300) }, 502);
  if (res.status !== 200) return json({ error: 'ai', detail: res.status + ' ' + res.body.slice(0, 300) }, 502);

  let out: any = null, sources: any[] = [];
  try {
    const j = JSON.parse(res.body);
    const cand = (j.candidates || [])[0] || {};
    out = parseVoice(((cand.content || {}).parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''));
    sources = sourcesOf(cand);
  } catch (_) { /* разбор ниже */ }
  if (!out) return json({ error: 'ai', detail: 'непонятный ответ модели: ' + res.body.slice(0, 300) }, 502);
  return json({ ...out, sources, model: res.model, ...(tried.length ? { tried } : {}) });
});
