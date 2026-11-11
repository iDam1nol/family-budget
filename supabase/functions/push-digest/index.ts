// Функция Supabase «push-digest»: утренняя сводка семьи в push-уведомлении.
// Вызывается двумя способами:
//  1) по расписанию (update-14.sql) с заголовком x-cron-secret: сводка всем включённым телефонам;
//     с телом {"mode":"remind"} (update-16.sql, раз в 5 минут) — напоминания о делах за час;
//     с телом {"mode":"month"} (update-17.sql, 1-го числа) — итоги прошедшего месяца;
//     с телом {"mode":"chat","id":...} (update-21.sql, триггер на новое сообщение) — уведомление о сообщении в чате семьи;
//  Родственникам (members.role = 'relative') уходят только уведомления о сообщениях.
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

// напоминание о деле за час: время дела московское (UTC+3 круглый год)
const taskStart = t => Date.parse(t.due + 'T' + String(t.due_time).slice(0, 5) + ':00+03:00');
// t — дело, now — миллисекунды -> { title, body, tag } или null, если напоминать не нужно
function remindMsg(t, now) {
  if (!t || t.done || !t.due || !t.due_time || t.reminded_at) return null;
  const left = taskStart(t) - now;
  if (!(left > 0 && left <= 3600e3)) return null;
  const mins = Math.round(left / 60000);
  const when = mins >= 55 ? 'Через час' : mins <= 1 ? 'Сейчас' : 'Через ' + mins + ' мин';
  return { title: when + ': ' + t.title, body: 'Дело на ' + String(t.due_time).slice(0, 5), tag: 'task-' + t.id };
}

// итоги месяца (1-го числа): ym — 'YYYY-MM' прошедшего месяца
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const ymShift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
// d: { ym, tx (за этот и прошлый месяц), cats } -> { title, body, tag, url } или null, если трат не было
function buildMonth(d) {
  const ym = d.ym, prev = ymShift(ym, -1), mi = +ym.slice(5) - 1, pi = +prev.slice(5) - 1;
  const tx = (d.tx || []).filter(t => !t.excluded);
  const sum = (k, m) => tx.filter(t => t.kind === k && String(t.date).slice(0, 7) === m).reduce((s, t) => s + +t.amount, 0);
  const exp = sum('expense', ym), inc = sum('income', ym), pexp = sum('expense', prev);
  if (!exp && !inc) return null;
  const lines = [];
  let l1 = 'Расходы ' + rub(exp);
  if (pexp > 0) {
    const pc = Math.round((exp - pexp) / pexp * 100);
    l1 += pc === 0 ? ', как в ' + MONTH_PREP[pi] : pc < 0 ? ' — на ' + (-pc) + '% меньше, чем в ' + MONTH_PREP[pi] : ' — на ' + pc + '% больше, чем в ' + MONTH_PREP[pi];
  }
  lines.push(l1 + '.' + (inc ? ' Доходы ' + rub(inc) + ', ' + (inc >= exp ? 'осталось ' + rub(inc - exp) : 'не хватило ' + rub(exp - inc)) + '.' : ''));
  const byCat = {};
  tx.filter(t => t.kind === 'expense' && String(t.date).slice(0, 7) === ym).forEach(t => { byCat[t.category_id || ''] = (byCat[t.category_id || ''] || 0) + +t.amount; });
  const cname = id => ((d.cats || []).find(c => c.id === id) || {}).name || 'Без категории';
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) lines.push('Больше всего: ' + top.map(([id, v]) => cname(id) + ' ' + rub(v)).join(', ') + '.');
  const over = (d.cats || []).filter(c => c.kind === 'expense' && +c.monthly_limit > 0 && (byCat[c.id] || 0) > +c.monthly_limit);
  if (over.length) lines.push('Превышен лимит: ' + over.map(c => c.name + ' (+' + rub(byCat[c.id] - +c.monthly_limit) + ')').join(', ') + '.');
  else if ((d.cats || []).some(c => c.kind === 'expense' && +c.monthly_limit > 0)) lines.push('Все лимиты соблюдены 👍');
  return { title: 'Итоги ' + MONTH_GEN[mi], body: lines.join('\n'), tag: 'month-' + ym, url: './?itogi=' + ym };
}
// сообщение чата -> уведомление получателю. m: строка family_messages, from: имя автора
function chatMsg(m, from) {
  const words = String(m.body || '').replace(/\s+/g, ' ').trim();
  const text = (m.fwd_from ? '↪ ' : '') + (m.photo_path ? '📷 Фото' + (words ? ': ' + words : '') : words);
  return {
    title: m.to_user ? from + ' · лично' : from + ' · чат семьи',
    body: text.length > 180 ? text.slice(0, 177) + '…' : text,
    tag: 'chat-' + (m.to_user ? m.user_id : 'all'),
    url: './?chat=' + (m.to_user ? m.user_id : 'all')
  };
}
// кому: личное — адресату, общее — всем в семье, кроме автора
const chatTargets = (m, members) => m.to_user ? [m.to_user] : members.filter(x => x.household_id === m.household_id && x.user_id !== m.user_id).map(x => x.user_id);
// --- digest:end ---

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (o: any, status = 200) => {
  if (status >= 400) console.error('push-digest: ' + status + ' ' + (o && o.error));   // причина видна во вкладке Logs функции
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
};

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

  // режим «напоминание о деле за час» (расписание update-16.sql, раз в 5 минут)
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* пустое тело — обычная сводка */ }

  // родственники получают только уведомления о сообщениях: бюджет, дела и итоги — не для них
  const { data: relRows } = await db.from('members').select('user_id').eq('role', 'relative');
  const rel = new Set((relRows || []).map((x: any) => x.user_id));
  const notRel = (list: any[]) => (list || []).filter((s: any) => !rel.has(s.user_id));
  const push = async (s: any, msg: any, ttl: number) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: ttl });
      return 1;
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { await db.from('push_subscriptions').delete().eq('id', s.id); return -1; }
      return 0;
    }
  };

  // режим «сообщение в чате семьи» (триггер update-21.sql)
  if (cron && body && body.mode === 'chat') {
    const { data: m } = await db.from('family_messages').select('*').eq('id', body.id).maybeSingle();
    if (!m) return json({ sent: 0, note: 'нет такого сообщения' });
    const { data: members } = await db.from('members').select('user_id,household_id,name').eq('household_id', m.household_id);
    const from = ((members || []).find((x: any) => x.user_id === m.user_id) || {}).name || 'Семья';
    const to = chatTargets(m, members || []);
    if (!to.length) return json({ sent: 0 });
    const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', to);
    let sent = 0, removed = 0;
    for (const s of subs || []) { const r = await push(s, chatMsg(m, from), 24 * 3600); if (r > 0) sent++; if (r < 0) removed++; }
    return json({ sent, removed });
  }

  // родственник нажал «Прислать проверочное»
  if (onlyUser && rel.has(onlyUser)) {
    const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', onlyUser);
    let sent = 0;
    for (const s of subs || []) if (await push(s, { title: 'Семья', body: 'Проверка: уведомления о сообщениях работают.', tag: 'test', url: './' }, 3600) > 0) sent++;
    return json({ sent });
  }

  // режим «итоги месяца» (расписание update-17.sql, 1-го числа в 10:00 по Москве).
  // ym — какой месяц подвести (по умолчанию прошедший), dry — только показать текст, ничего не отправляя
  if (cron && body && body.mode === 'month') {
    const thisYm = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Moscow' }).slice(0, 7);
    const ym = /^\d{4}-\d{2}$/.test(body.ym || '') ? body.ym : ymShift(thisYm, -1);
    const { data: subs, error: se } = await db.from('push_subscriptions').select('*');
    if (se) return json({ error: se.message }, 500);
    const byHh = new Map<string, any[]>();
    notRel(subs).forEach((s: any) => byHh.set(s.household_id, [...(byHh.get(s.household_id) || []), s]));
    let sent = 0, removed = 0;
    const preview: any[] = [];
    for (const [hh, list] of byHh) {
      const [{ data: tx }, { data: cats }] = await Promise.all([
        db.from('transactions').select('kind,amount,date,category_id,excluded').eq('household_id', hh).gte('date', ymShift(ym, -1) + '-01').lt('date', ymShift(ym, 1) + '-01'),
        db.from('categories').select('*').eq('household_id', hh)]);
      const msg = buildMonth({ ym, tx: tx || [], cats: cats || [] });
      if (!msg) continue;
      if (body.dry) { preview.push(msg); continue; }
      for (const s of list) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 24 * 3600 });
          sent++;
        } catch (e: any) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) { await db.from('push_subscriptions').delete().eq('id', s.id); removed++; }
        }
      }
    }
    return json({ ym, sent, removed, ...(body.dry ? { preview } : {}) });
  }

  if (cron && body && body.mode === 'remind') {
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const { data: cand, error: te } = await db.from('tasks').select('*').eq('done', false).is('reminded_at', null)
      .not('due_time', 'is', null).gte('due', day(now - 864e5)).lte('due', day(now + 864e5));
    if (te) return json({ error: te.message }, 500);
    let sent = 0, reminded = 0, removed = 0;
    for (const t of cand || []) {
      const msg = remindMsg(t, now);
      if (!msg) continue;
      // сначала ставим отметку: если два вызова совпали, напоминание уйдёт только один раз
      const { data: got } = await db.from('tasks').update({ reminded_at: new Date().toISOString() }).eq('id', t.id).is('reminded_at', null).select('id');
      if (!got || !got.length) continue;
      reminded++;
      let sq = db.from('push_subscriptions').select('*').eq('household_id', t.household_id);
      if (t.assignee) sq = sq.eq('user_id', t.assignee);      // своё дело — только себе, общее — всей семье
      const { data: list } = await sq;
      for (const s of notRel(list)) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ ...msg, url: './' }), { TTL: 3600 });
          sent++;
        } catch (e: any) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) { await db.from('push_subscriptions').delete().eq('id', s.id); removed++; }
        }
      }
    }
    return json({ reminded, sent, removed });
  }

  let q = db.from('push_subscriptions').select('*');
  if (onlyUser) q = q.eq('user_id', onlyUser);
  const { data: subs, error: se } = await q;
  if (se) return json({ error: se.message }, 500);
  if (!subs || !subs.length) return json({ sent: 0, note: 'на этом аккаунте нет телефонов с включёнными уведомлениями' });
  const own = notRel(subs);

  const today = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
  const monthStart = today.slice(0, 8) + '01';
  const byHousehold = new Map<string, any[]>();
  own.forEach((s: any) => byHousehold.set(s.household_id, [...(byHousehold.get(s.household_id) || []), s]));

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
