// Функция Supabase «voice»: голосовой помощник.
// Приложение присылает запись голоса (или текст) и краткую сводку данных семьи; функция отдаёт их
// бесплатной модели Gemini и возвращает, что человек сказал и какие действия выполнить.
// Сами действия выполняет приложение от имени этого человека (обычные права RLS), функция в базу не пишет.
// Нужный секрет функции (Edge Functions -> Secrets): GEMINI_API_KEY. Необязательный: GEMINI_MODEL.
// Проверку JWT в настройках функции выключить: функция проверяет вход сама.
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

// --- voice:start (обычный JavaScript, его проверяют тесты на Node) ---
const VOICE_TYPES = ['expense', 'income', 'shop', 'bought', 'task', 'task_done'];
const VOICE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'Что сказал пользователь, дословно' },
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
          qty: { type: 'string', description: 'Количество свободным текстом: «2 шт», «1 кг»' },
          due: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: 'HH:MM' },
          who: { type: 'string', enum: ['me', 'other', 'all'] },
          repeat: { type: 'string', description: 'day, week, month, year или пусто' }
        },
        required: ['type']
      }
    },
    reply: { type: 'string', description: 'Короткий ответ пользователю по-русски' }
  },
  required: ['transcript', 'actions', 'reply']
};

// ctx — сводка, которую собирает приложение (voiceCtx в index.html)
function voicePrompt(ctx) {
  const c = ctx || {};
  return [
    'Ты голосовой помощник семейного приложения «Семейный бюджет». Пользователь говорит по-русски.',
    'Разбери, что он просит, и верни JSON строго по схеме: transcript (что он сказал), actions (что сделать), reply (короткий ответ).',
    `Сегодня ${c.today || ''} (${c.weekday || ''}). Говорит: ${c.me || 'пользователь'}${c.other ? '. Второй участник семьи: ' + c.other : ''}.`,
    '',
    'Действия (каждое отдельным элементом actions):',
    '- expense — расход: amount, category (одно название из «Категории расходов» или пусто), note (что или где), date (по умолчанию сегодня; «вчера» — вчерашняя дата).',
    '- income — доход: так же, с «Категориями доходов».',
    '- shop — добавить в список покупок: title, qty (если сказано количество). Каждый товар — отдельное действие.',
    '- bought — отметить купленным товар из «Список покупок»: title как в списке.',
    '- task — новое дело: title, due (дата или пусто), time (HH:MM или пусто), who (me — себе, other — второму участнику, all — общее; по умолчанию all), repeat (day, week, month, year или пусто).',
    '- task_done — отметить сделанным дело из «Дела»: title как в списке.',
    '',
    'Правила:',
    '- Суммы словами переводи в число: «две триста» = 2300, «полторы тысячи» = 1500, «тыщу» = 1000. Сумму не придумывай: если её нет, не делай expense, а переспроси в reply.',
    '- Одна фраза может содержать несколько действий: «в Ленте две триста, из них пятьсот на бытовую химию» — это два расхода: 1800 и 500.',
    '- «Купил молоко» без суммы — это bought, если молоко есть в списке покупок; с суммой — expense.',
    '- Дни недели считай вперёд от сегодняшней даты. «Вечером» без времени — 19:00, «утром» — 09:00, «днём» — 13:00.',
    '- Если это вопрос — ответь в reply в 1–3 предложениях, опираясь только на данные ниже. Ничего не выдумывай. Суммы пиши с «₽».',
    '- Удалять и изменять старые записи ты не можешь: если просят, скажи в reply, что это делается вручную в приложении.',
    '- Если не понял или запись пустая — actions пустой, в reply коротко переспроси.',
    '- Если действия выполнены, reply можно оставить пустым.',
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

// текст ответа модели -> { transcript, actions, reply }; выдерживает ```json и мусор вокруг
function parseVoice(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const actions = (Array.isArray(o.actions) ? o.actions : []).filter(x => x && VOICE_TYPES.includes(x.type)).slice(0, 20);
  return { transcript: String(o.transcript || '').slice(0, 1000), actions, reply: String(o.reply || '').slice(0, 1000) };
}
// --- voice:end ---

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (o: any, status = 200) => {
  if (status >= 400) console.error('voice: ' + status + ' ' + (o && (o.error + (o.detail ? ' ' + o.detail : ''))));
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
};

const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const env = (k: string) => Deno.env.get(k) || '';
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ error: 'no_key' }, 503);

  // только вошедший участник приложения (чтобы чужие не тратили бесплатный лимит)
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await db.auth.getUser(token);
  if (ue || !u.user) return json({ error: 'auth' }, 401);

  let body: any;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (!audio && !text) return json({ error: 'empty' }, 400);
  if (audio.length > 3_000_000) return json({ error: 'too_long' }, 413);        // около минуты речи
  const ctxStr = JSON.stringify(body.ctx || {});
  if (ctxStr.length > 60_000) return json({ error: 'too_big' }, 413);

  const parts: any[] = audio
    ? [{ text: 'Запись голоса пользователя. Расшифруй её в transcript и разбери.' }, { inline_data: { mime_type: audioMime(body.mime), data: audio } }]
    : [{ text: 'Пользователь написал: ' + text }];
  const request = (withSchema: boolean) => JSON.stringify({
    systemInstruction: { parts: [{ text: voicePrompt(JSON.parse(ctxStr)) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', ...(withSchema ? { responseJsonSchema: VOICE_SCHEMA } : {}) }
  });
  const call = async (model: string, withSchema: boolean) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 25000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: request(withSchema), signal: ac.signal });
      return { status: r.status, body: await r.text() };
    } catch (e) { return { status: 0, body: String(e) }; } finally { clearTimeout(t); }
  };

  const primary = env('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
  let res = await call(primary, true);
  // схему ответа не приняли — повторяем без неё (формат всё равно описан в инструкции)
  if (res.status === 400 && /schema|responseJsonSchema|Unknown name|Invalid JSON payload/i.test(res.body)) res = await call(primary, false);
  // модель недоступна или её лимит кончился — пробуем запасную
  if ([0, 404, 429, 500, 503].includes(res.status) && primary !== FALLBACK_MODEL) {
    const r2 = await call(FALLBACK_MODEL, true);
    if (r2.status === 200) res = r2;
  }
  if (res.status === 429) return json({ error: 'limit' }, 429);
  if (res.status === 400 && /API key|API_KEY/i.test(res.body) || res.status === 401 || res.status === 403) return json({ error: 'bad_key', detail: res.body.slice(0, 300) }, 502);
  if (res.status !== 200) return json({ error: 'ai', detail: res.status + ' ' + res.body.slice(0, 300) }, 502);

  let out: any = null;
  try {
    const j = JSON.parse(res.body);
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    out = parseVoice(txt.map((p: any) => p.text || '').join(''));
  } catch (_) { /* разбор ниже */ }
  if (!out) return json({ error: 'ai', detail: 'непонятный ответ модели: ' + res.body.slice(0, 300) }, 502);
  return json(out);
});
