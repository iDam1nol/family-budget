// Функция Supabase «push-digest»: утренняя сводка семьи в push-уведомлении.
// Вызывается двумя способами:
//  1) по расписанию (update-14.sql) с заголовком x-cron-secret: сводка всем включённым телефонам;
//  2) кнопкой «Прислать проверочное» в приложении (вход пользователя): только на его телефоны.
// Нужные секреты функции (Edge Functions -> Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET.
// Проверку JWT в настройках функции нужно выключить: функция проверяет вход сама.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

// --- digest:start (обычный JavaScript, его проверяют тесты на Node) ---
const norm = s => String(s || '').trim().toLowerCase().replace(/ё/g, 'е');
const rub = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
const addDay = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const listNames = (names, max) => names.slice(0, max).join(', ') + (names.length > max ? ' и ещё ' + (names.length - max) : '');

// d: { today, userId, tasks, recur, tx, pantry, products, cats } -> { title, body } или null, если ничего срочного
function buildDigest(d) {
  const lines = [];
  const today = d.today, tomorrow = addDay(today, 1);
  const [y, m, day] = today.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), monthStart = today.slice(0, 8) + '01';
  const tx = (d.tx || []).filter(t => t.kind === 'expense' && !t.excluded && t.date >= monthStart);

  // дела на сегодня и просроченные: общие и свои
  const tasks = (d.tasks || []).filter(t => !t.done && t.due && t.due <= today && (!t.assignee || t.assignee === d.userId))
    .sort((a, b) => a.due.localeCompare(b.due) || String(a.due_time || '99').localeCompare(String(b.due_time || '99')));
  if (tasks.length) {
    const late = tasks.filter(t => t.due < today).length;
    lines.push('Дела: ' + listNames(tasks.map(t => t.title + (t.due_time ? ' в ' + String(t.due_time).slice(0, 5) : '')), 3) + (late ? ' (просрочено: ' + late + ')' : ''));
  }

  // платежи с сегодняшним днём, если ещё не оплачены
  const used = new Set();
  const paid = r => tx.find(t => !used.has(t.id) && (t.recurring_id === r.id || (r.keyword && !t.recurring_id && norm(t.note).includes(norm(r.keyword)))));
  const pays = (d.recur || []).filter(r => Math.min(r.day, dim) === day && r.skip_month !== monthStart)
    .filter(r => { const t = paid(r); if (t) used.add(t.id); return !t; });
  if (pays.length) lines.push('Платёж сегодня: ' + pays.map(r => r.name + ' ' + rub(+r.amount)).join(', '));

  // продукты, у которых срок годности сегодня или завтра
  const pname = id => ((d.products || []).find(p => p.id === id) || {}).name;
  const exp = [];
  (d.pantry || []).filter(b => b.expires_on === today || b.expires_on === tomorrow).forEach(b => {
    const n = pname(b.product_id);
    const s = n && n + (b.expires_on === today ? ' (сегодня)' : ' (завтра)');
    if (s && !exp.includes(s)) exp.push(s);
  });
  if (exp.length) lines.push('Срок годности: ' + listNames(exp, 3));

  // лимит категории превышен именно вчерашними и сегодняшними тратами (чтобы не напоминать каждый день)
  const yesterday = addDay(today, -1);
  const crossed = (d.cats || []).filter(c => c.kind === 'expense' && +c.monthly_limit > 0).filter(c => {
    const mine = tx.filter(t => t.category_id === c.id);
    const before = mine.filter(t => t.date < yesterday).reduce((s, t) => s + +t.amount, 0);
    const now = mine.reduce((s, t) => s + +t.amount, 0);
    return before <= +c.monthly_limit && now > +c.monthly_limit;
  });
  if (crossed.length) lines.push('Превышен лимит: ' + crossed.map(c => c.name).join(', '));

  return lines.length ? { title: 'Семья: на сегодня', body: lines.join('\n') } : null;
}
// --- digest:end ---

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const env = (k: string) => Deno.env.get(k) || '';
  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_ROLE_KEY')) return json({ error: 'у функции нет SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY' }, 500);
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY')) return json({ error: 'не заданы секреты VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY' }, 500);
  webpush.setVapidDetails('https://idam1nol.github.io/family-budget/', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // кто вызывает: расписание (секрет) или человек из приложения (его вход)
  let onlyUser: string | null = null, test = false;
  const cron = req.headers.get('x-cron-secret');
  if (cron) {
    if (!env('CRON_SECRET') || cron !== env('CRON_SECRET')) return json({ error: 'forbidden' }, 403);
  } else {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return json({ error: 'нужен вход в приложение' }, 401);
    onlyUser = data.user.id; test = true;
  }

  let q = db.from('push_subscriptions').select('*');
  if (onlyUser) q = q.eq('user_id', onlyUser);
  const { data: subs, error: se } = await q;
  if (se) return json({ error: se.message }, 500);
  if (!subs || !subs.length) return json({ sent: 0, note: 'на этом аккаунте нет телефонов с включёнными уведомлениями' });

  const today = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
  const monthStart = today.slice(0, 8) + '01';
  const byHousehold = new Map<string, any[]>();
  subs.forEach((s: any) => byHousehold.set(s.household_id, [...(byHousehold.get(s.household_id) || []), s]));

  let sent = 0, removed = 0;
  for (const [hh, list] of byHousehold) {
    // таблица может ещё не существовать (не выполнен update-N.sql): тогда этот раздел просто пустой
    const rows = async (table: string, f = (x: any) => x) => { const { data, error } = await f(db.from(table).select('*').eq('household_id', hh)); return error ? [] : data; };
    const [tasks, recur, tx, pantry, products, cats] = await Promise.all([
      rows('tasks', x => x.eq('done', false)), rows('recurring_payments'), rows('transactions', x => x.gte('date', monthStart)),
      rows('pantry_items', x => x.not('expires_on', 'is', null)), rows('products'), rows('categories')
    ]);
    for (const s of list) {
      const msg = buildDigest({ today, userId: s.user_id, tasks, recur, tx, pantry, products, cats })
        || (test ? { title: 'Семья', body: 'Проверка: уведомления работают. Сегодня ничего срочного.' } : null);
      if (!msg) continue;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ ...msg, tag: 'digest', url: './' }), { TTL: 12 * 3600 });
        sent++;
      } catch (e: any) {
        // телефон отписался или удалил приложение: подписка больше не нужна
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { await db.from('push_subscriptions').delete().eq('id', s.id); removed++; }
      }
    }
  }
  return json({ sent, removed });
});
