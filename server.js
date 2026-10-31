#!/usr/bin/env node
/* vedilm server — zero dependencies (Node >= 18).  node server.js */
'use strict';
const CF = !!globalThis.__VEDILM_CF; // running inside a Cloudflare Durable Object (see vedilm-cf)
const crypto = require('crypto');
const opt = n => { try { return require(n); } catch (e) { return {}; } }; // non-literal require: the Cloudflare bundle leaves these out
const http = CF ? {} : opt('http'), fs = CF ? {} : opt('fs'), path = CF ? { join: (...a) => a.join('/') } : opt('path'), os = CF ? {} : opt('os');
const MAIN = CF || require.main === module;

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(typeof __dirname === 'string' ? __dirname : '.', 'data');
const INDEX = path.join(typeof __dirname === 'string' ? __dirname : '.', 'public', 'index.html');
const SESSION_TTL = 30 * 24 * 3600e3;
const STATUSES = ['todo', 'doing', 'review', 'done'], PRIOS = ['low', 'medium', 'high', 'urgent'], REPEATS = ['', 'daily', 'weekly', 'monthly'];

/* ---------------- persistence ----------------
   SQLite (node:sqlite, Node >= 22.5) when available, else a JSON file.
   The whole model lives in memory; only changed rows are written, inside one transaction. */
if (!CF) fs.mkdirSync(DATA_DIR, { recursive: true });
const SQL_FILE = path.join(DATA_DIR, 'vedilm.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const COLLECTIONS = ['users', 'sessions', 'invites', 'projects', 'tasks', 'events', 'notifs', 'activity', 'messages', 'tokens', 'work', 'invoices', 'leaves', 'reports', 'needs'];
function emptyDB() { const d = { v: 2 }; COLLECTIONS.forEach(k => d[k] = []); return d; }
var sqlite = null, sql = null;
if (CF) { sqlite = { DatabaseSync: function () { return globalThis.__VEDILM_SQL; } }; }
else if (process.env.STORAGE !== 'json') {
  try {
    const orig = process.emitWarning; process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : orig.call(process, w, ...r));
    sqlite = require(['node', 'sqlite'].join(':'));
    process.emitWarning = orig;
  } catch (e) { sqlite = null; }
}
let DB = emptyDB();
const written = new Map(); // "col:id" -> json last written
if (sqlite) {
  sql = new sqlite.DatabaseSync(SQL_FILE);
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS docs(col TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(col,id)); CREATE INDEX IF NOT EXISTS docs_col ON docs(col,seq);');
  for (const row of sql.prepare('SELECT col,id,json FROM docs ORDER BY seq').all()) {
    if (!DB[row.col]) continue; DB[row.col].push(JSON.parse(row.json)); written.set(row.col + ':' + row.id, row.json);
  }
  // one-time import of an older JSON database
  const legacy = path.join(DATA_DIR, 'db.json');
  if (!CF && !DB.users.length && fs.existsSync(legacy)) {
    try { const old = JSON.parse(fs.readFileSync(legacy, 'utf8')); for (const k of COLLECTIONS) if (Array.isArray(old[k])) DB[k] = old[k]; fs.renameSync(legacy, legacy + '.migrated'); console.log('  imported legacy db.json into SQLite'); } catch (e) { console.error('legacy import failed', e.message); }
  }
} else {
  const f = path.join(DATA_DIR, 'db.json');
  try { const old = JSON.parse(fs.readFileSync(f, 'utf8')); for (const k of COLLECTIONS) if (Array.isArray(old[k])) DB[k] = old[k]; } catch (e) {}
}
function newUserCode() { for (let i = 0; i < 200; i++) { const c = String(crypto.randomInt(100000, 1000000)); if (!DB.users.some(u => u.code === c)) return c; } return String(crypto.randomInt(10000000, 100000000)); }
function ensureCodes() { let n = 0; for (const u of DB.users) if (!u.code) { u.code = newUserCode(); n++; } return n; }
let saveTimer = null;
function persist() { if (CF) return persistNow(); if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 150); }
if (ensureCodes()) persist();
function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!sql) { const f = path.join(DATA_DIR, 'db.json'), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, f); return; }
  const up = sql.prepare('INSERT INTO docs(col,id,json,seq) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET json=excluded.json,seq=excluded.seq');
  const del = sql.prepare('DELETE FROM docs WHERE col=? AND id=?');
  sql.exec('BEGIN');
  try {
    const seen = new Set();
    for (const col of COLLECTIONS) {
      DB[col].forEach((o, i) => {
        const key = col + ':' + o.id; seen.add(key);
        const js = JSON.stringify(o);
        if (written.get(key) !== js) { up.run(col, o.id, js, i); written.set(key, js); }
      });
    }
    for (const key of [...written.keys()]) if (!seen.has(key)) { const k = key.indexOf(':'); del.run(key.slice(0, k), key.slice(k + 1)); written.delete(key); }
    sql.exec('COMMIT');
  } catch (e) { try { sql.exec('ROLLBACK'); } catch (x) {} console.error('persist failed', e && e.message); if (CF && globalThis.__VEDILM_SQL && globalThis.__VEDILM_SQL !== sql && !persistNow.retry) { sql = globalThis.__VEDILM_SQL; written.clear(); persistNow.retry = true; try { persistNow(); } finally { persistNow.retry = false; } } }
}
/* Cloudflare: a Durable Object instance can be re-created inside the same isolate while this module stays cached,
   leaving `sql` bound to a dead storage handle (writes then fail silently). rebind() re-attaches and reloads from storage. */
function rebind() {
  if (!CF || !globalThis.__VEDILM_SQL) return;
  sql = globalThis.__VEDILM_SQL; written.clear();
  const fresh = {}; COLLECTIONS.forEach(k => fresh[k] = []);
  for (const row of sql.prepare('SELECT col,id,json FROM docs ORDER BY seq').all()) { if (!fresh[row.col]) continue; fresh[row.col].push(JSON.parse(row.json)); written.set(row.col + ':' + row.id, row.json); }
  COLLECTIONS.forEach(k => { DB[k].length = 0; fresh[k].forEach(o => DB[k].push(o)); });
}
function backup() {
  if (!sql) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    persistNow();
    const name = 'vedilm-' + new Date().toISOString().slice(0, 13).replace('T', '-') + '.sqlite', dest = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(dest)) sql.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort();
    all.slice(0, Math.max(0, all.length - (+process.env.BACKUP_KEEP || 28))).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error('backup failed', e.message); }
}
if (sql && !CF && require.main === module) { setTimeout(backup, 3000).unref(); setInterval(backup, 6 * 3600e3).unref(); }
if (!CF) {
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { persistNow(); } catch (e) {} process.exit(0); });
  process.on('exit', () => { try { if (saveTimer) persistNow(); } catch (e) {} });
}

/* ---------------- helpers ---------------- */
const nowISO = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = (p = '') => p + crypto.randomBytes(8).toString('hex');
const ID_RE = /^[A-Za-z0-9_\-]{1,48}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{2}:\d{2}$/;
const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function checkPw(pw, salt, hash) {
  if (!hash || typeof pw !== 'string') return false;
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function recoveryCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(10); return [...b].map(x => a[x % a.length]).join(''); }
const userById = id => DB.users.find(u => u.id === id);
const projById = id => DB.projects.find(p => p.id === id);
const isMember = (p, uid) => p && (p.ownerId === uid || p.members.some(m => m.userId === uid));
function teamOf(uid) {
  const s = new Set();
  DB.invites.forEach(i => { if (i.status !== 'accepted') return; if (i.fromId === uid) s.add(i.toId); else if (i.toId === uid) s.add(i.fromId); });
  return s;
}

/* ---------- payroll: contracts ---------- */
function g2j(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + ~~((gy2 + 3) / 4) - ~~((gy2 + 99) / 100) + ~~((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * ~~(days / 12053); days %= 12053;
  jy += 4 * ~~(days / 1461); days %= 1461;
  if (days > 365) { jy += ~~((days - 1) / 365); days = (days - 1) % 365; }
  let jm, jd;
  if (days < 186) { jm = 1 + ~~(days / 31); jd = 1 + days % 31; } else { jm = 7 + ~~((days - 186) / 30); jd = 1 + (days - 186) % 30; }
  return [jy, jm, jd];
}
function j2g(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + 365 * jy + ~~(jy / 33) * 8 + ~~((jy % 33 + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * ~~(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * ~~(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * ~~(days / 1461); days %= 1461;
  if (days > 365) { gy += ~~((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0; for (; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}
const p2 = n => String(n).padStart(2, '0');
const gIso = a => a[0] + '-' + p2(a[1]) + '-' + p2(a[2]);
const dayNo = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5);
function todayTehran() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }); }
/* round a join date (gregorian ISO) to the Jalali anchor day used for payroll; mgr never touches this */
const adj = d => d > 0 ? d - 1 : d;
function roundStart(gIsoStr) {
  const [gy, gm, gd] = gIsoStr.split('-').map(Number);
  const [jy, jm, jd] = g2j(gy, gm, gd);
  let ry = jy, rm = jm, rd;
  if (jd <= 4) rd = 1; else if (jd <= 7) rd = 5; else if (jd <= 12) rd = 10; else if (jd <= 17) rd = 15; else if (jd <= 22) rd = 20; else if (jd <= 25) rd = 25;
  else { rd = 1; rm++; if (rm > 12) { rm = 1; ry++; } }
  const rg = gIso(j2g(ry, rm, rd));
  return { actualG: gIsoStr, actualJ: jy + '-' + p2(jm) + '-' + p2(jd), startG: rg, startJ: ry + '-' + p2(rm) + '-' + p2(rd), adjDays: adj(dayNo(rg) - dayNo(gIsoStr)) }; // + = days worked before the start (extra pay, entry day not counted), - = days not worked (deduction)
}
const numIn = (v, min, max, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def; };
function cleanOffer(o) {
  if (!isObj(o)) return null;
  const kind = o.kind === 'hourly' ? 'hourly' : 'agreed';
  const f = isObj(o.fines) ? o.fines : {};
  const r = {
    kind, desc: str(o.desc, 1000) || '',
    hoursMode: o.hoursMode === 'day' ? 'day' : 'month',
    hoursMonth: numIn(o.hoursMonth, 1, 300, 140), dailyHours: numIn(o.dailyHours, 1, 16, 7),
    workdays: Array.isArray(o.workdays) ? [...new Set(o.workdays.map(Number).filter(x => x >= 0 && x <= 6))].sort() : [0, 1, 2, 3, 4, 5],
    workFrom: TIME_RE.test(o.workFrom || '') ? o.workFrom : '', workTo: TIME_RE.test(o.workTo || '') ? o.workTo : '',
    payDay: numIn(o.payDay, 1, 28, 10), lateDay: numIn(o.lateDay, 0, 1e9, 0),
    fines: { lateTask: numIn(f.lateTask, 0, 1e9, 100000), earlyBonus: numIn(f.earlyBonus, 0, 1e9, 100000), meeting: numIn(f.meeting, 0, 1e9, 200000), presence: numIn(f.presence, 0, 1e9, 200000), taskPct: numIn(f.taskPct, 0, 100, 10) }
  };
  if (kind === 'agreed') { r.amount = numIn(o.amount, 0, 1e11, 0); if (r.amount <= 0) return null; }
  else { r.rateN = numIn(o.rateN, 1, 1e9, 200000); r.rateO = numIn(o.rateO, 0, 1e9, 300000); r.overMax = numIn(o.overMax, 0, 8, 3); }
  return r;
}
function chatPeers(uid) { // team + people in an open offer discussion (private chat only)
  const s = teamOf(uid);
  DB.invites.forEach(i => { if (i.status !== 'discussing') return; if (i.fromId === uid) s.add(i.toId); else if (i.toId === uid) s.add(i.fromId); });
  return s;
}

/* ---------- payroll: monthly 100% capacity, backlog, month close ---------- */
function curPeriod() { const [y, m, d] = todayTehran().split('-').map(Number); const j = g2j(y, m, d); return j[0] + '-' + p2(j[1]); }
function periodEndG(period) { const [jy, jm] = period.split('-').map(Number); let ny = jy, nm = jm + 1; if (nm > 12) { nm = 1; ny++; } return addDaysISO(gIso(j2g(ny, nm, 1)), -1); }
const taskActive = t => !t.backlog && !t.extra && !!t.period;
function capUsed(pid, uid, period, exceptId) { return DB.tasks.filter(t => t.projectId === pid && t.id !== exceptId && taskActive(t) && t.period === period && t.assigneeIds.includes(uid)).reduce((a, t) => a + (t.weight || 10), 0); }
function capViolation(tk) { // first assignee whose month would exceed 100%
  if (tk.backlog || tk.extra) return null;
  const p = projById(tk.projectId);
  for (const a of tk.assigneeIds) { if (p && a === p.ownerId) continue; if (capUsed(tk.projectId, a, tk.period, tk.id) + (tk.weight || 10) > 100) return a; }
  return null;
}
const SWAP_MAX = 3;
function swapKey(a, period) { return a + ':' + period; }
function swapsLeft(p, a, period) { return SWAP_MAX - ((p.swaps || {})[swapKey(a, period)] || 0); }
function useSwap(p, a, period) { p.swaps = p.swaps || {}; p.swaps[swapKey(a, period)] = (p.swaps[swapKey(a, period)] || 0) + 1; }
function promoteBacklog(pid, touched) {
  const per = curPeriod();
  const list = DB.tasks.filter(t => t.projectId === pid && t.backlog && !t.extra).sort((a, b) => (b.weight || 10) - (a.weight || 10) || String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const t of list) {
    const saved = t.period; t.period = per; t.backlog = false;
    if (capViolation(t)) { t.backlog = true; t.period = saved || ''; continue; }
    t.assigneeIds.forEach(a => pushNotif(a, { type: 'assigned', text: 'n.taskPromoted', params: { t: t.title }, link: 'task:' + t.id, key: 'prom:' + t.id + ':' + per }));
    touched && touched.add('tasks'); touched && touched.add('notifs');
  }
}
function closePeriods() { // month close: auto-approve reviews after 5 days, carry unfinished work with a warning
  const today = todayTehran(), cur = curPeriod(), touched = new Set();
  for (const p of DB.projects) {
    if (!p.lastPeriod) { p.lastPeriod = cur; touched.add('projects'); continue; }
    if (p.lastPeriod < cur && dayNo(periodEndG(p.lastPeriod)) + 5 <= dayNo(today)) {
      const old = p.lastPeriod, carried = new Set();
      DB.tasks.filter(t => t.projectId === p.id && t.period === old && !t.extra && !t.backlog).forEach(t => {
        if (t.status === 'review') { t.status = 'done'; t.completedAt = nowISO(); t.assigneeIds.forEach(a => pushNotif(a, { type: 'info', text: 'n.reviewAuto', params: { t: t.title }, link: 'task:' + t.id, key: 'rauto:' + t.id })); pushNotif(p.ownerId, { type: 'info', text: 'n.reviewAuto', params: { t: t.title }, link: 'task:' + t.id, key: 'rauto:' + t.id }); }
        else if (t.status !== 'done') { t.period = cur; t.assigneeIds.forEach(a => { if (a !== p.ownerId) carried.add(a); }); }
      });
      carried.forEach(a => {
        const inv = DB.invites.find(i => i.status === 'accepted' && i.fromId === p.ownerId && i.toId === a && (!i.projectId || i.projectId === p.id));
        if (inv) { inv.taskWarn = (inv.taskWarn || 0) + 1; touched.add('invites'); }
        pushNotif(a, { type: 'info', text: 'n.taskCarried', params: { p: p.name }, link: 'project:' + p.id, key: 'carry:' + p.id + ':' + old });
        pushNotif(p.ownerId, { type: 'info', text: 'n.taskWarnMgr', params: { name: (userById(a) || {}).name || '', p: p.name }, link: 'project:' + p.id, key: 'carrym:' + p.id + ':' + old + ':' + a });
      });
      p.lastPeriod = cur; touched.add('projects'); touched.add('tasks'); touched.add('notifs');
      promoteBacklog(p.id, touched);
    }
  }
  if (touched.size) { persist(); broadcast('changed', {}); }
}
function related(a, b) { // may notify / see each other?
  if (a === b) return true;
  if (teamOf(a).has(b)) return true;
  return DB.projects.some(p => isMember(p, a) && isMember(p, b));
}


/* ---------------- mail (zero-dependency SMTP client) ---------------- */
const GOOGLE_CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || '606998726637-cr7qep16t5jh0q3f7o9mc5e4mmkrqcle.apps.googleusercontent.com';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAIL = { enabled: !!process.env.SMTP_URL, from: process.env.MAIL_FROM || 'vedilm <no-reply@localhost>', outbox: [] };
const tls = CF ? {} : opt('tls'), net = CF ? {} : opt('net');
function smtpSend(urlStr, from, to, subject, text) {
  const u = new URL(urlStr), secure = u.protocol === 'smtps:', port = +u.port || (secure ? 465 : 587);
  const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
  return new Promise((ok, no) => {
    let sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    let buf = '', waiter = null, done = false;
    const fail = e => { if (!done) { done = true; try { sock.destroy(); } catch (x) {} no(e); } };
    const attach = sk => { sk.on('data', d => { buf += d.toString('utf8'); pump(); }); sk.on('error', fail); sk.on('close', () => fail(new Error('smtp closed'))); };
    const pump = () => { if (!waiter) return; const lines = buf.split('\r\n'); const last = lines.filter(Boolean).pop(); if (last && /^\d{3} /.test(last) && buf.endsWith('\r\n')) { const w = waiter; waiter = null; const t = buf; buf = ''; w(t); } };
    const reply = () => new Promise((res, rej) => { waiter = res; { const tm = setTimeout(() => rej(new Error('smtp timeout')), 20000); if (tm && tm.unref) tm.unref(); } pump(); });
    const cmd = async (c, expect) => { if (c) sock.write(c + '\r\n'); const t = await reply(); if (!expect.includes(+t.slice(0, 3))) throw new Error('smtp: ' + t.trim()); return t; };
    attach(sock);
    (async () => {
      await cmd('', [220]);
      let ehlo = await cmd('EHLO vedilm', [250]);
      if (!secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
        sock = tls.connect({ socket: sock, servername: u.hostname }); buf = ''; attach(sock);
        await new Promise(res => sock.once('secureConnect', res));
        ehlo = await cmd('EHLO vedilm', [250]);
      }
      if (u.username) await cmd('AUTH PLAIN ' + Buffer.from(`\0${decodeURIComponent(u.username)}\0${decodeURIComponent(u.password)}`).toString('base64'), [235]);
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
      const subj = '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
      const msg = `From: ${from}\r\nTo: <${to}>\r\nSubject: ${subj}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n.\r\n`;
      sock.write(msg); const t = await reply(); if (+t.slice(0, 3) !== 250) throw new Error('smtp: ' + t.trim());
      sock.write('QUIT\r\n'); done = true; sock.end(); ok();
    })().catch(fail);
  });
}
async function sendMail(to, subject, text) {
  MAIL.outbox.push({ to, subject, text, at: nowISO() }); if (MAIL.outbox.length > 30) MAIL.outbox.shift();
  if (!MAIL.enabled) { console.log(`\n  [mail → ${to}] ${subject}\n  ${text.replace(/\n/g, '\n  ')}\n`); return; }
  try { await smtpSend(process.env.SMTP_URL, MAIL.from, to, subject, text); } catch (e) { console.error('mail failed:', e.message); }
}
const MAILTXT = {
  verify: (n, l, lang) => lang === 'en' ? [`Verify your email — vedilm`, `Hi ${n},\nPlease confirm your email address:\n${l}\n`] : [`تأیید ایمیل — vedilm`, `سلام ${n}،\nبرای تأیید ایمیل خود روی این لینک بزنید:\n${l}\n`],
  reset: (n, l, lang) => lang === 'en' ? [`Reset your password — vedilm`, `Hi ${n},\nUse this link within one hour to choose a new password:\n${l}\nIf you did not ask for this, ignore this email.\n`] : [`بازیابی رمز عبور — vedilm`, `سلام ${n}،\nبرای انتخاب رمز جدید تا یک ساعت از این لینک استفاده کنید:\n${l}\nاگر شما درخواست نداده‌اید این ایمیل را نادیده بگیرید.\n`]
};
function makeToken(userId, kind, ttlMs) {
  DB.tokens = DB.tokens.filter(t => !(t.userId === userId && t.kind === kind) && t.exp > Date.now());
  const raw = crypto.randomBytes(24).toString('hex');
  DB.tokens.push({ id: sha(raw), userId, kind, exp: Date.now() + ttlMs }); persist();
  return raw;
}
function useToken(raw, kind) {
  const id = sha(String(raw || '')), t = DB.tokens.find(x => x.id === id && x.kind === kind);
  if (!t || t.exp < Date.now()) return null;
  DB.tokens = DB.tokens.filter(x => x !== t); persist(); return userById(t.userId) || null;
}
function sendVerify(u) { const [s, b] = MAILTXT.verify(u.name, `${BASE_URL}/api/verify?t=${makeToken(u.id, 'verify', 3 * 86400e3)}`, (u.prefs || {}).lang); return sendMail(u.email, s, b); }

/* ---------------- throttling ---------------- */
const fails = new Map();
function throttled(key) { const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.t < 10 * 60e3; }
function failed(key) { const f = fails.get(key); if (!f || Date.now() - f.t > 10 * 60e3) fails.set(key, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
function cleared(key) { fails.delete(key); }
const hits = new Map();
function rateOk(ip) { const m = Math.floor(Date.now() / 60e3), k = ip + ':' + m; const n = (hits.get(k) || 0) + 1; hits.set(k, n); if (hits.size > 5000) for (const x of hits.keys()) if (!x.endsWith(':' + m)) hits.delete(x); return n <= 900; }

/* ---------------- sessions ---------------- */
function newSession(user, req, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  DB.sessions.push({ id: sha(token), userId: user.id, created: nowISO(), last: nowISO(), ua: String(req.headers['user-agent'] || '').slice(0, 160), ip: clientIp(req), remember: !!remember });
  persist(); return token;
}
function authOf(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return null;
  const id = sha(h.slice(7).trim());
  const s = DB.sessions.find(x => x.id === id);
  if (!s) return null;
  if (Date.now() - Date.parse(s.last) > SESSION_TTL) { DB.sessions = DB.sessions.filter(x => x !== s); persist(); return null; }
  const user = userById(s.userId); if (!user) return null;
  if (Date.now() - Date.parse(s.last) > 3600e3) { s.last = nowISO(); persist(); }
  return { user, session: s };
}

/* ---------------- state views ---------------- */
function pubUser(u, full) {
  const o = { id: u.id, code: u.code || '', tier: planState(u).tier, verified: u.verified !== false, name: u.name, email: u.email, role: u.role, title: u.title || '', phone: full ? (u.phone || '') : '', bio: full ? (u.bio || '') : '', avatar: u.avatar || '', createdAt: u.createdAt };
  const p = u.prefs || {};
  o.prefs = full ? p : { nAssigned: p.nAssigned !== false, nDue: p.nDue !== false, nComment: p.nComment !== false };
  return o;
}
function buildState(uid) {
  const me = userById(uid);
  const projects = DB.projects.filter(p => isMember(p, uid));
  const pids = new Set(projects.map(p => p.id));
  const invites = DB.invites.filter(i => i.fromId === uid || i.toId === uid);
  const uids = new Set([uid]);
  invites.forEach(i => { uids.add(i.fromId); uids.add(i.toId); });
  projects.forEach(p => { uids.add(p.ownerId); p.members.forEach(m => uids.add(m.userId)); });
  const tasks = DB.tasks.filter(t => pids.has(t.projectId));
  tasks.forEach(t => t.comments.forEach(c => uids.add(c.userId)));
  const activity = DB.activity.filter(a => pids.has(a.projectId)).slice(-400);
  activity.forEach(a => a.userId && uids.add(a.userId));
  return {
    me: uid,
    users: [...uids].map(userById).filter(Boolean).map(u => pubUser(u, u.id === uid)),
    invites, projects: projects.map(p => isLocked(p) ? Object.assign({}, p, { locked: true }) : p), tasks, activity,
    messages: DB.messages.filter(m => m.scope === 'p' ? pids.has(m.projectId) : (m.fromId === uid || m.toId === uid)).slice(-1500),
    events: DB.events.filter(e => e.ownerId === uid),
    notifs: DB.notifs.filter(n => n.userId === uid).slice(-300),
    online: onlineIds(), plan: planView(userById(uid))
  };
}

/* ---------------- plans ---------------- */
const PLANS = {
  manager: { free: { projects: 3, members: 10, ai: 0 }, pro: { projects: 10, members: 50, ai: 5, price: { '1m': 1000000, '6m': 5000000, '12m': 8000000 } }, org: { projects: 0, members: 0, ai: -1, price: { '1m': 3000000, '6m': 7000000, '12m': 12000000 } } },
  employee: { free: { ai: 0 }, pro: { ai: 6, price: { '1m': 600000, '6m': 2500000, '12m': 4000000 } } }
};
const TOPICS = ['web', 'software', 'tailoring', 'ads', 'graphic', 'content', 'construction', 'restaurant', 'education', 'other'];
const PLAN_DAYS = { '1m': 30, '6m': 180, '12m': 365 };
function planState(u) {
  const pl = u.plan && PLANS[u.role] && PLANS[u.role][u.plan.tier] ? u.plan : null;
  const end = pl ? Date.parse(pl.end) : 0, active = !!pl && end > Date.now();
  return { tier: active ? pl.tier : 'free', paidTier: pl ? pl.tier : 'free', per: pl ? pl.per : '', start: pl ? pl.start : '', end: pl ? pl.end : '', active, daysLeft: active ? Math.ceil((end - Date.now()) / 86400e3) : 0 };
}
const limitsOf = u => PLANS[u.role] ? PLANS[u.role][planState(u).tier] : {};
function lockedIds(ownerId) {
  const o = userById(ownerId); if (!o || o.role !== 'manager') return new Set();
  const lim = limitsOf(o).projects; if (!lim) return new Set();
  const ps = DB.projects.filter(p => p.ownerId === ownerId && !p.sample).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return new Set(ps.slice(lim).map(p => p.id));
}
const isLocked = p => !!p && lockedIds(p.ownerId).has(p.id);
const teamCount = uid => new Set(DB.invites.filter(i => i.fromId === uid && ['pending', 'accepted', 'discussing'].includes(i.status)).map(i => i.toId)).size;
function usageOf(u) { return { projects: DB.projects.filter(p => p.ownerId === u.id && !p.sample).length, members: u.role === 'manager' ? teamCount(u.id) : 0 }; }
function cleanPI(b) {
  if (!isObj(b)) return null;
  const s2 = (v, n) => { v = str(v, n); return v ? v.trim() : ''; };
  const first = s2(b.first, 40), last = s2(b.last, 60), phone = String(b.phone || '').replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[\s-]/g, '');
  if (first.length < 2 || last.length < 2 || !/^09\d{9}$/.test(phone)) return null;
  const bd = isObj(b.birth) ? b.birth : {}, y = +bd.y, m = +bd.m, d = +bd.d, cy = +curPeriod().slice(0, 4);
  if (!(y >= 1300 && y <= cy) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= (m <= 6 ? 31 : 30))) return null;
  const bp = isObj(b.birthPlace) ? b.birthPlace : {}, bpp = s2(bp.province, 40), bpc = s2(bp.city, 60), pv = s2(b.province, 40), ct = s2(b.city, 60);
  if (!bpp || !bpc || !pv || !ct) return null;
  return { first, last, phone, birth: { y, m, d }, birthPlace: { province: bpp, city: bpc }, province: pv, city: ct };
}
function planView(u) { const ps = planState(u); return { plan: ps, limits: limitsOf(u), usage: usageOf(u), pi: u.pi || null, catalog: PLANS[u.role] || {} }; }

/* ---------------- sync (field-level authorised) ---------------- */
const clone = o => JSON.parse(JSON.stringify(o));
function cleanSubtasks(v) { if (!Array.isArray(v)) return; return v.slice(0, 10).map(s => isObj(s) && ID_RE.test(s.id || '') ? { id: s.id, t: str(s.t, 200) || '', done: !!s.done } : null).filter(Boolean); }
function cleanLabels(v) { if (!Array.isArray(v)) return; return v.slice(0, 12).map(x => str(x, 30)).filter(x => x); }
function mergeComments(existing, incoming, uid) {
  if (!Array.isArray(incoming)) return existing;
  const keepIds = new Set(incoming.map(c => c && c.id));
  const out = existing.filter(c => c.userId !== uid || keepIds.has(c.id)); // may delete own only
  const have = new Set(out.map(c => c.id));
  for (const c of incoming.slice(0, 500)) {
    if (!isObj(c) || !ID_RE.test(c.id || '') || have.has(c.id)) continue;
    if (existing.some(e => e.id === c.id)) continue;
    const text = str(c.text, 4000); if (!text || !text.trim()) continue;
    out.push({ id: c.id, userId: uid, text, at: typeof c.at === 'string' && !isNaN(Date.parse(c.at)) ? c.at : nowISO() }); have.add(c.id);
  }
  return out;
}
const TASK_FIELDS = {
  title: v => { v = str(v, 200); return v && v.trim() ? v : undefined; },
  desc: v => str(v, 6000),
  status: v => STATUSES.includes(v) ? v : undefined,
  priority: v => PRIOS.includes(v) ? v : undefined,
  due: v => v === '' || (typeof v === 'string' && DATE_RE.test(v)) ? v : undefined,
  start: v => v === '' || (typeof v === 'string' && DATE_RE.test(v)) ? v : undefined,
  time: v => v === '' || (typeof v === 'string' && TIME_RE.test(v)) ? v : undefined,
  labels: cleanLabels, subtasks: cleanSubtasks,
  order: v => Number.isFinite(v) ? v : undefined,
  completedAt: v => v === '' || (typeof v === 'string' && !isNaN(Date.parse(v))) ? v : undefined,
  repeat: v => REPEATS.includes(v) ? v : undefined,
  spawned: v => typeof v === 'boolean' ? v : undefined,
  weight: v => Number.isFinite(+v) ? Math.min(100, Math.max(10, Math.round(+v))) : undefined,
  extra: v => typeof v === 'boolean' ? v : undefined,
  backlog: v => typeof v === 'boolean' ? v : undefined,
};
const ASSIGNEE_FIELDS = ['status', 'order', 'completedAt', 'subtasks'];

function addDaysISO(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addMonthISO(iso) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); }
function shiftDate(iso, rep) { if (!iso) return ''; return rep === 'daily' ? addDaysISO(iso, 1) : rep === 'weekly' ? addDaysISO(iso, 7) : addMonthISO(iso); }
function maybeSpawn(tk, touched) {
  if (tk.status !== 'done' || !tk.repeat || tk.spawned || !tk.due) return;
  const nxt = clone(tk);
  nxt.id = rid('t_'); nxt.period = curPeriod(); nxt.status = 'todo'; nxt.completedAt = ''; nxt.spawned = false; nxt.comments = [];
  nxt.subtasks = (tk.subtasks || []).map(s => ({ id: rid('s_'), t: s.t, done: false }));
  nxt.due = shiftDate(tk.due, tk.repeat); if (tk.start) nxt.start = shiftDate(tk.start, tk.repeat);
  nxt.createdAt = nowISO(); nxt.order = Math.max(0, ...DB.tasks.filter(x => x.projectId === tk.projectId && x.status === 'todo').map(x => x.order || 0)) + 1;
  DB.tasks.push(nxt); tk.spawned = true; touched.add('tasks');
  const p = projById(tk.projectId);
  [...new Set(nxt.assigneeIds)].forEach(a => pushNotif(a, { type: 'assigned', text: 'n.recurring', params: { t: nxt.title }, link: 'task:' + nxt.id, key: 'rec:' + nxt.id }));
}
function pushNotif(userId, o) {
  const u = userById(userId); if (!u) return;
  if (o.key && DB.notifs.some(n => n.userId === userId && n.key === o.key)) return;
  DB.notifs.push({ id: rid('n_'), userId, type: o.type, text: o.text, link: o.link || '', key: o.key || '', at: nowISO(), read: false, params: o.params || null });
  if (DB.notifs.length > 3000) DB.notifs.splice(0, DB.notifs.length - 3000);
}
function cleanMembers(v, ownerId) {
  if (!Array.isArray(v)) return;
  const team = teamOf(ownerId), seen = new Set(), out = [];
  for (const m of v.slice(0, 100)) {
    if (!isObj(m) || !team.has(m.userId) || seen.has(m.userId) || m.userId === ownerId) continue;
    seen.add(m.userId); out.push({ userId: m.userId, title: str(m.title, 60) || '' });
  }
  return out;
}
function removeLink(a, b) { // cascade when a team link is removed
  for (const p of DB.projects) {
    if (p.ownerId === a || p.ownerId === b) {
      const other = p.ownerId === a ? b : a;
      p.members = p.members.filter(m => m.userId !== other);
      DB.tasks.forEach(t => { if (t.projectId === p.id) t.assigneeIds = t.assigneeIds.filter(x => x !== other); });
    }
  }
}
function deleteProject(id) {
  DB.projects = DB.projects.filter(p => p.id !== id);
  DB.tasks = DB.tasks.filter(t => t.projectId !== id);
  DB.activity = DB.activity.filter(a => a.projectId !== id);
  DB.messages = DB.messages.filter(m => m.projectId !== id);
  DB.reports = DB.reports.filter(r => r.projectId !== id);
  DB.needs = DB.needs.filter(n => n.projectId !== id);
}

function applySync(user, ch) {
  const uid = user.id, touched = new Set(), rejected = [];
  ch = isObj(ch) ? ch : {};
  const list = k => (isObj(ch[k]) ? ch[k] : {});
  const arr = v => Array.isArray(v) ? v.slice(0, 500) : [];

  /* users: self profile only */
  for (const p of arr(list('users').up)) {
    if (!isObj(p) || p.id !== uid) continue;
    const f = isObj(p.patch) ? p.patch : {};
    if (f.name !== undefined) { const v = str(f.name, 80); if (v && v.trim().length >= 2) user.name = v.trim(); }
    for (const k of ['title', 'phone']) if (f[k] !== undefined) { const v = str(f[k], 80); if (v !== undefined) user[k] = v.trim(); }
    if (f.bio !== undefined) { const v = str(f.bio, 600); if (v !== undefined) user.bio = v; }
    if (f.avatar !== undefined) { const v = f.avatar; if (v === '' || (typeof v === 'string' && v.length < 200000 && /^data:image\/(jpeg|png|webp);base64,/.test(v))) user.avatar = v; }
    if (isObj(f.prefs)) {
      const q = f.prefs, o = user.prefs || {};
      if (['fa', 'en', 'ar', 'zh'].includes(q.lang)) o.lang = q.lang;
      if (q.calSys === null || q.calSys === 'j' || q.calSys === 'g') o.calSys = q.calSys;
      if (['auto', '0', '1', '6'].includes(String(q.weekStart))) o.weekStart = String(q.weekStart);
      for (const k of ['nAssigned', 'nDue', 'nComment']) if (typeof q[k] === 'boolean') o[k] = q[k];
      user.prefs = o;
    }
    touched.add('users');
  }

  /* invites = job offers; once accepted the same record is the contract */
  const I = list('invites');
  for (const inv of arr(I.up)) {
    if (!isObj(inv) || !ID_RE.test(inv.id || '')) continue;
    const ex = DB.invites.find(i => i.id === inv.id);
    const f = isObj(inv.full) ? inv.full : isObj(inv.patch) ? inv.patch : {};
    if (!ex) {
      if (user.role !== 'manager' || f.fromId !== uid) { rejected.push(['invites', inv.id]); continue; }
      const to = userById(f.toId);
      if (!to || to.id === uid || DB.invites.some(i => (i.fromId === uid && i.toId === to.id || i.fromId === to.id && i.toId === uid) && (i.status === 'pending' || i.status === 'accepted' || i.status === 'discussing'))) { rejected.push(['invites', inv.id]); continue; }
      { const lim = limitsOf(user).members; if (lim && teamCount(uid) >= lim && !DB.invites.some(i => i.fromId === uid && i.toId === to.id)) { rejected.push(['invites', inv.id, 'limit']); continue; } }
      const offer = cleanOffer(f.offer);
      if (!offer) { rejected.push(['invites', inv.id]); continue; }
      const pr = f.projectId ? projById(f.projectId) : null;
      DB.invites.push({ id: inv.id, fromId: uid, toId: to.id, title: str(f.title, 60) || '', message: offer.desc.slice(0, 240), offer, projectId: pr && pr.ownerId === uid ? pr.id : '', projectName: pr && pr.ownerId === uid ? pr.name : '', status: 'pending', createdAt: nowISO() });
      pushNotif(to.id, { type: 'invite', text: 'n.invite', params: { name: user.name }, link: 'team', key: 'inv:' + inv.id });
      touched.add('invites'); touched.add('notifs');
    } else if (ex.fromId === uid && (ex.status === 'pending' || ex.status === 'discussing') && (f.offer !== undefined || f.title !== undefined || f.projectId !== undefined)) {
      // manager revises the offer; employee sees it again as pending
      if (f.offer !== undefined) { const o = cleanOffer(f.offer); if (o) { ex.offer = o; ex.message = o.desc.slice(0, 240); } }
      if (f.title !== undefined) ex.title = str(f.title, 60) || '';
      if (f.projectId !== undefined) { const pr = f.projectId ? projById(f.projectId) : null; ex.projectId = pr && pr.ownerId === uid ? pr.id : ''; ex.projectName = pr && pr.ownerId === uid ? pr.name : ''; }
      ex.status = 'pending'; ex.reportText = '';
      pushNotif(ex.toId, { type: 'invite', text: 'n.inviteRevised', params: { name: user.name }, link: 'team', key: 'invv:' + ex.id + ':' + Date.now() });
      touched.add('invites'); touched.add('notifs');
    } else if (ex.toId === uid && (ex.status === 'pending' || ex.status === 'discussing') && ['accepted', 'declined', 'discussing'].includes(f.status)) {
      if (f.status === 'discussing') {
        const text = (str(f.reportText, 1000) || '').trim();
        if (!text) { rejected.push(['invites', inv.id]); continue; }
        ex.status = 'discussing'; ex.reportText = text;
        DB.messages.push({ id: rid('m_'), fromId: uid, text: ('\u{1F4DD} ' + text).slice(0, 2000), at: nowISO(), scope: 'd', projectId: '', toId: ex.fromId });
        pushNotif(ex.fromId, { type: 'invite', text: 'n.inviteReport', params: { name: user.name }, link: 'chat:d:' + uid, key: 'invr:' + ex.id + ':' + Date.now() });
        touched.add('messages');
      } else if (f.status === 'accepted') {
        ex.status = 'accepted'; ex.acceptedAt = nowISO();
        const c = roundStart(todayTehran());
        ex.contract = c;
        const amt = ex.offer && ex.offer.kind === 'agreed' ? ex.offer.amount : 0;
        ex.contract.adjAmount = Math.round(c.adjDays * amt / 30);
        const pr = ex.projectId ? projById(ex.projectId) : null;
        if (pr && pr.ownerId === ex.fromId && !pr.members.some(m => m.userId === uid)) { pr.members.push({ userId: uid, title: ex.title || '' }); touched.add('projects'); }
        pushNotif(ex.fromId, { type: 'invite', text: 'n.inviteAccepted', params: { name: user.name }, link: 'team', key: 'invr:' + ex.id });
      } else {
        ex.status = 'declined';
        pushNotif(ex.fromId, { type: 'invite', text: 'n.inviteDeclined', params: { name: user.name }, link: 'team', key: 'invr:' + ex.id });
      }
      touched.add('invites'); touched.add('notifs');
    } else if (ex.fromId === uid && ex.status === 'accepted' && (f.ins !== undefined || f.tax !== undefined)) {
      // insurance and tax are entered by hand by the manager (estimates, not official)
      if (f.ins !== undefined) ex.ins = numIn(f.ins, 0, 1e11, 0);
      if (f.tax !== undefined) ex.tax = numIn(f.tax, 0, 1e11, 0);
      touched.add('invites');
    }
  }
  for (const id of arr(I.del)) {
    const ex = DB.invites.find(i => i.id === id);
    if (!ex || (ex.fromId !== uid && ex.toId !== uid)) continue;
    DB.invites = DB.invites.filter(i => i !== ex);
    if (ex.status === 'accepted') removeLink(ex.fromId, ex.toId);
    touched.add('invites'); touched.add('projects'); touched.add('tasks');
  }

  /* projects */
  const P = list('projects');
  for (const pr of arr(P.up)) {
    if (!isObj(pr) || !ID_RE.test(pr.id || '')) continue;
    let ex = projById(pr.id);
    const f = isObj(pr.patch) ? pr.patch : (isObj(pr.full) ? pr.full : {});
    if (!ex) {
      if (user.role !== 'manager') { rejected.push(['projects', pr.id]); continue; }
      const name = str(f.name, 120); if (!name || !name.trim()) { rejected.push(['projects', pr.id]); continue; }
      { const lim = limitsOf(user).projects; if (lim && f.sample !== true && usageOf(user).projects >= lim) { rejected.push(['projects', pr.id, 'limit']); continue; } }
      ex = { id: pr.id, ownerId: uid, name: name.trim(), desc: '', color: '#6c4cf1', due: '', members: [], createdAt: nowISO() };
      if (f.sample === true) ex.sample = true;
      DB.projects.push(ex);
    } else if (ex.ownerId !== uid || isLocked(ex)) { rejected.push(['projects', pr.id]); continue; }
    if (f.name !== undefined) { const v = str(f.name, 120); if (v && v.trim()) ex.name = v.trim(); }
    if (f.desc !== undefined) { const v = str(f.desc, 2000); if (v !== undefined) ex.desc = v; }
    if (f.color !== undefined && typeof f.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.color)) ex.color = f.color;
    if (f.due !== undefined && (f.due === '' || (typeof f.due === 'string' && DATE_RE.test(f.due)))) ex.due = f.due;
    if (f.topic !== undefined) ex.topic = TOPICS.includes(f.topic) ? f.topic : '';
    if (f.siteUrl !== undefined) { const v = str(f.siteUrl, 300); ex.siteUrl = v && /^https?:\/\/[^\s<>"']{3,290}$/i.test(v.trim()) ? v.trim() : ''; }
    if (f.members !== undefined) {
      const m = cleanMembers(f.members, uid);
      if (m) { ex.members = m; const ok = new Set([uid, ...m.map(x => x.userId)]); DB.tasks.forEach(t => { if (t.projectId === ex.id) t.assigneeIds = t.assigneeIds.filter(a => ok.has(a)); }); touched.add('tasks'); }
    }
    touched.add('projects');
  }
  const pdel = arr(P.del); const massP = pdel.length > 1; // safety net: a single sync never deletes several projects (guards against a corrupted/empty client state)
  for (const id of pdel) { if (massP) { rejected.push(['projects', id]); continue; } const ex = projById(id); if (ex && ex.ownerId === uid) { deleteProject(id); touched.add('projects'); touched.add('tasks'); touched.add('activity'); } }

  /* tasks */
  const T = list('tasks');
  for (const tk of arr(T.up)) {
    if (!isObj(tk) || !ID_RE.test(tk.id || '')) continue;
    let ex = DB.tasks.find(x => x.id === tk.id), isNew = false;
    const f = isObj(tk.patch) ? tk.patch : (isObj(tk.full) ? tk.full : {});
    if (isLocked(projById(ex ? ex.projectId : str(f.projectId, 60)))) { rejected.push(['tasks', tk.id, 'locked']); continue; }
    if (!ex) {
      const p = projById(str(f.projectId, 60));
      if (!p || p.ownerId !== uid) { rejected.push(['tasks', tk.id]); continue; }
      const title = TASK_FIELDS.title(f.title); if (!title) { rejected.push(['tasks', tk.id]); continue; }
      ex = { id: tk.id, projectId: p.id, title, desc: '', status: 'todo', priority: 'medium', assigneeIds: [], due: '', start: '', time: '', labels: [], subtasks: [], comments: [], order: 0, createdAt: nowISO(), completedAt: '', repeat: '', spawned: false, weight: 10, extra: false, backlog: false, period: curPeriod() };
      DB.tasks.push(ex); isNew = true;
    }
    const p = projById(ex.projectId); if (!p || !isMember(p, uid)) { rejected.push(['tasks', tk.id]); continue; }
    const owner = p.ownerId === uid, assignee = ex.assigneeIds.includes(uid);
    const wasDone = ex.status === 'done';
    const snap = isNew ? null : clone(ex);
    for (const [k, fn] of Object.entries(TASK_FIELDS)) {
      if (f[k] === undefined) continue;
      if (!owner && !(assignee && ASSIGNEE_FIELDS.includes(k))) continue;
      const v = fn(f[k]); if (v !== undefined) ex[k] = v;
    }
    if (owner && Array.isArray(f.assigneeIds)) {
      const ok = new Set([p.ownerId, ...p.members.map(m => m.userId)]);
      ex.assigneeIds = [...new Set(f.assigneeIds.filter(a => typeof a === 'string' && ok.has(a)))].slice(0, 50);
    }
    if (f.comments !== undefined) ex.comments = mergeComments(ex.comments, f.comments, uid);
    if (!ex.period && owner && f.weight !== undefined) ex.period = curPeriod();
    if (f.subtasks !== undefined && ex.subtasks.length && ex.subtasks.every(x => x.done) && (ex.status === 'todo' || ex.status === 'doing')) ex.status = 'review'; // all sub-tasks ticked -> next stage
    if (owner) {
      const bad = capViolation(ex);
      let blocked = !!bad;
      if (!blocked && snap && taskActive(snap) && !taskActive(ex) && ex.backlog) { // moved to backlog = one swap per assignee
        const need = snap.assigneeIds.filter(a => a !== p.ownerId);
        if (need.some(a => swapsLeft(p, a, snap.period) <= 0)) blocked = true; else need.forEach(a => useSwap(p, a, snap.period));
      }
      if (blocked) { if (isNew) DB.tasks = DB.tasks.filter(x => x !== ex); else { Object.keys(ex).forEach(k => delete ex[k]); Object.assign(ex, snap); } rejected.push(['tasks', tk.id]); continue; }
      if (snap && ex.backlog !== snap.backlog) promoteBacklog(p.id, touched);
    }
    if (ex.status === 'done' && !ex.completedAt) ex.completedAt = nowISO();
    if (ex.status !== 'done') ex.completedAt = '';
    if (!wasDone) maybeSpawn(ex, touched);
    touched.add('tasks');
  }
  for (const id of arr(T.del)) {
    const ex = DB.tasks.find(x => x.id === id), p = ex && projById(ex.projectId);
    if (ex && p && p.ownerId === uid) {
      if (taskActive(ex) && ex.status !== 'done') { // replacing an open task costs one swap per assignee (max 3 per month)
        const need = ex.assigneeIds.filter(a => a !== p.ownerId);
        if (need.some(a => swapsLeft(p, a, ex.period) <= 0)) { rejected.push(['tasks', id]); continue; }
        need.forEach(a => useSwap(p, a, ex.period));
        touched.add('projects');
      }
      DB.tasks = DB.tasks.filter(x => x !== ex); touched.add('tasks');
      promoteBacklog(p.id, touched);
    }
  }

  /* events (own) */
  const E = list('events');
  for (const ev of arr(E.up)) {
    if (!isObj(ev) || !ID_RE.test(ev.id || '')) continue;
    const f = isObj(ev.patch) ? ev.patch : (isObj(ev.full) ? ev.full : {});
    let ex = DB.events.find(x => x.id === ev.id);
    if (ex && ex.ownerId !== uid) continue;
    if (!ex) { if (!(typeof f.date === 'string' && DATE_RE.test(f.date)) || !str(f.title, 1)) continue; ex = { id: ev.id, ownerId: uid, title: '', date: f.date, time: '', note: '' }; DB.events.push(ex); }
    if (f.title !== undefined) { const v = str(f.title, 160); if (v && v.trim()) ex.title = v; }
    if (f.date !== undefined && typeof f.date === 'string' && DATE_RE.test(f.date)) ex.date = f.date;
    if (f.time !== undefined && (f.time === '' || (typeof f.time === 'string' && TIME_RE.test(f.time)))) ex.time = f.time;
    if (f.note !== undefined) { const v = str(f.note, 1000); if (v !== undefined) ex.note = v; }
    touched.add('events');
  }
  for (const id of arr(E.del)) { const ex = DB.events.find(x => x.id === id); if (ex && ex.ownerId === uid) { DB.events = DB.events.filter(x => x !== ex); touched.add('events'); } }

  /* notifications: create for related users, mutate/delete only own */
  const N = list('notifs');
  for (const n of arr(N.up)) {
    if (!isObj(n) || !ID_RE.test(n.id || '')) continue;
    const f = isObj(n.patch) ? n.patch : (isObj(n.full) ? n.full : {});
    const ex = DB.notifs.find(x => x.id === n.id);
    if (ex) { if (ex.userId === uid && f.read === true) { ex.read = true; touched.add('notifs'); } continue; }
    const target = f.userId; if (!userById(target) || !related(uid, target)) continue;
    const tu = userById(target), pf = tu.prefs || {};
    const type = str(f.type, 20) || 'info';
    if ((type === 'assigned' && pf.nAssigned === false) || ((type === 'comment' || type === 'mention' || type === 'message') && pf.nComment === false) || (type === 'due' && pf.nDue === false)) continue;
    const key = str(f.key, 120) || '';
    if (key && DB.notifs.some(x => x.userId === target && x.key === key)) continue;
    const params = isObj(f.params) ? Object.fromEntries(Object.entries(f.params).slice(0, 8).map(([k, v]) => [k, str(String(v), 200)])) : null;
    DB.notifs.push({ id: n.id, userId: target, type, text: str(f.text, 80) || '', link: str(f.link, 80) || '', key, at: nowISO(), read: false, params });
    touched.add('notifs');
  }
  for (const id of arr(N.del)) { const ex = DB.notifs.find(x => x.id === id); if (ex && ex.userId === uid) { DB.notifs = DB.notifs.filter(x => x !== ex); touched.add('notifs'); } }

  /* chat messages: create own, delete own */
  const MS = list('messages');
  for (const m of arr(MS.up)) {
    if (!isObj(m) || !ID_RE.test(m.id || '') || DB.messages.some(x => x.id === m.id)) continue;
    const f = isObj(m.full) ? m.full : {};
    const text = str(f.text, 2000); if (!text || !text.trim()) continue;
    let rec;
    if (f.scope === 'p') { const p = projById(f.projectId); if (!p || !isMember(p, uid) || isLocked(p)) { rejected.push(['messages', m.id]); continue; } rec = { scope: 'p', projectId: p.id, toId: '' }; }
    else if (f.scope === 'd') { if (!chatPeers(uid).has(f.toId) || !userById(f.toId)) { rejected.push(['messages', m.id]); continue; } rec = { scope: 'd', projectId: '', toId: f.toId }; }
    else continue;
    DB.messages.push(Object.assign({ id: m.id, fromId: uid, text: text.trim(), at: nowISO() }, rec));
    touched.add('messages');
  }
  for (const id of arr(MS.del)) { const ex = DB.messages.find(x => x.id === id); if (ex && ex.fromId === uid) { DB.messages = DB.messages.filter(x => x !== ex); touched.add('messages'); } }
  if (DB.messages.length > 20000) DB.messages.splice(0, DB.messages.length - 20000);

  /* activity: append only */
  for (const a of arr(list('activity').up)) {
    if (!isObj(a) || !ID_RE.test(a.id || '') || DB.activity.some(x => x.id === a.id)) continue;
    const f = isObj(a.full) ? a.full : {};
    const p = projById(f.projectId); if (!p || !isMember(p, uid)) continue;
    DB.activity.push({ id: a.id, projectId: p.id, userId: uid, text: str(f.text, 600) || '', at: nowISO() });
    touched.add('activity');
  }
  if (DB.activity.length > 6000) DB.activity.splice(0, DB.activity.length - 6000);
  persist();
  return { touched, rejected };
}

/* ---------------- live updates (SSE) + presence ---------------- */
const streams = new Set(); // {res, uid, cid}
function onlineIds() { return [...new Set([...streams].map(s => s.uid))]; }
function broadcast(event, data, exceptCid) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const s of streams) if (!exceptCid || s.cid !== exceptCid) { try { s.res.write(msg); } catch (e) {} }
}
if (MAIN) { setTimeout(closePeriods, 2500); setInterval(closePeriods, 3600e3); }
setInterval(() => { for (const s of streams) { try { s.res.write(': ping\n\n'); } catch (e) {} } }, 20000);


/* ---------------- payroll: hourly timer + random presence checks ---------------- */
const NORMAL_H = 8, CHECK_WIN = 15 * 60e3;
function sendTo(uid, event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`; for (const s of streams) if (s.uid === uid) { try { s.res.write(msg); } catch (e) {} } }
function hourlyContract(uid, id) { return DB.invites.find(i => i.id === id && i.toId === uid && i.status === 'accepted' && i.offer && i.offer.kind === 'hourly'); }
const activeSession = uid => DB.work.find(w => w.type === 'session' && w.userId === uid && !w.end);
function sessionMs(w, nowMs) { // time that counts: minus the delay of late presence answers
  let ms = (w.end ? Date.parse(w.end) : nowMs) - Date.parse(w.start);
  for (const c of w.checks || []) if (c.answeredAt) ms -= Math.max(0, Date.parse(c.answeredAt) - Date.parse(c.at));
  return Math.max(0, ms);
}
function dayMs(uid, inviteId, day, nowMs) { return DB.work.filter(w => w.type === 'session' && w.userId === uid && w.inviteId === inviteId && w.day === day).reduce((a, w) => a + sessionMs(w, nowMs), 0); }
function capMs(offer) { return (NORMAL_H + (offer.overMax || 0)) * 3600e3; }
function splitPay(offer, ms) { const n = Math.min(ms, NORMAL_H * 3600e3), o = Math.min(Math.max(ms - NORMAL_H * 3600e3, 0), (offer.overMax || 0) * 3600e3); return { normalMs: n, overMs: o, amount: Math.round(n / 3600e3 * offer.rateN + o / 3600e3 * offer.rateO) }; }
function periodOfDay(day) { const [y, m, d] = day.split('-').map(Number); const j = g2j(y, m, d); return j[0] + '-' + p2(j[1]); }
function timerSummary(inv, nowMs) {
  const o = inv.offer, uid = inv.toId, today = todayTehran(), per = curPeriod();
  const days = {};
  DB.work.filter(w => w.type === 'session' && w.inviteId === inv.id).forEach(w => { days[w.day] = (days[w.day] || 0) + sessionMs(w, nowMs); });
  const t = splitPay(o, days[today] || 0);
  const mon = { normalMs: 0, overMs: 0, amount: 0 };
  Object.entries(days).forEach(([d, ms]) => { if (periodOfDay(d) !== per) return; const x = splitPay(o, ms); mon.normalMs += x.normalMs; mon.overMs += x.overMs; mon.amount += x.amount; });
  const warns = DB.work.filter(w => w.type === 'warn' && w.inviteId === inv.id && w.period === per).length;
  const fines = DB.work.filter(w => w.type === 'fine' && w.inviteId === inv.id && w.period === per);
  const a = activeSession(uid);
  return { inviteId: inv.id, offer: { rateN: o.rateN, rateO: o.rateO, overMax: o.overMax, hoursMonth: o.hoursMode === 'day' ? Math.round(o.dailyHours * o.workdays.length * 52 / 12) : o.hoursMonth },
    now: nowMs, today: Object.assign({ day: today, totalMs: days[today] || 0, capMs: capMs(o) }, t), period: Object.assign({ period: per }, mon), warns, fines: fines.map(f => ({ id: f.id, amount: f.amount, at: f.at })),
    active: a && a.inviteId === inv.id ? { id: a.id, start: a.start, countedMs: sessionMs(a, nowMs), check: (a.checks || []).filter(c => !c.answeredAt && Date.parse(c.deadline) > nowMs).map(c => ({ id: c.id, at: c.at, deadline: c.deadline, code: c.code }))[0] || null } : null };
}
function stopSession(w, endMs, reason) {
  w.end = new Date(endMs).toISOString(); w.endReason = reason || 'user';
  const inv = DB.invites.find(i => i.id === w.inviteId);
  if (inv && inv.offer) { const cap = capMs(inv.offer), tot = dayMs(w.userId, w.inviteId, w.day, endMs); if (tot > cap) { w.end = new Date(endMs - (tot - cap)).toISOString(); } }
}
function applyRates() {
  const cur = curPeriod(); let any = false;
  for (const inv of DB.invites) {
    const sc = inv.scheduled; if (!sc || sc.from > cur || inv.status !== 'accepted') continue;
    if (!inv.rateHist) inv.rateHist = [{ from: '0000-00', offer: JSON.parse(JSON.stringify(inv.offer)) }];
    const no = Object.assign({}, inv.offer, sc.patch); inv.rateHist.push({ from: sc.from, offer: no }); inv.offer = no; delete inv.scheduled; any = true;
    pushNotif(inv.toId, { type: 'info', text: 'n.rateApplied', link: 'requests', key: 'ra:' + inv.id + sc.from });
    pushNotif(inv.fromId, { type: 'info', text: 'n.rateApplied', link: 'requests', key: 'ra:' + inv.id + sc.from });
  }
  return any;
}
function timerTick() {
  const now = Date.now(); let changed = applyRates();
  for (const w of DB.work) {
    if (w.type !== 'session' || w.end) continue;
    const inv = DB.invites.find(i => i.id === w.inviteId); if (!inv || !inv.offer) { stopSession(w, now, 'contract'); changed = true; continue; }
    const pend = (w.checks || []).find(c => !c.answeredAt);
    if (pend && Date.parse(pend.deadline) <= now) { // missed: stop at the moment of the check, one warning
      stopSession(w, Date.parse(pend.at), 'presence'); changed = true;
      const per = curPeriod();
      DB.work.push({ id: rid('w_'), type: 'warn', userId: w.userId, inviteId: inv.id, at: nowISO(), period: per, kind: 'presence' });
      const n = DB.work.filter(x => x.type === 'warn' && x.inviteId === inv.id && x.period === per).length;
      pushNotif(w.userId, { type: 'info', text: 'n.presenceMissed', params: { n }, link: 'timer', key: 'pm:' + w.id });
      if (n % 5 === 0) {
        const amount = inv.offer.fines && inv.offer.fines.presence || 0;
        DB.work.push({ id: rid('w_'), type: 'fine', userId: w.userId, inviteId: inv.id, at: nowISO(), period: per, kind: 'presence', amount });
        pushNotif(w.userId, { type: 'info', text: 'n.presenceFine', params: { amt: amount.toLocaleString('en-US') }, link: 'timer', key: 'pf:' + w.id });
        pushNotif(inv.fromId, { type: 'info', text: 'n.presenceFineMgr', params: { name: (userById(w.userId) || {}).name || '' }, link: 'team', key: 'pfm:' + w.id });
      }
      sendTo(w.userId, 'timer', {}); continue;
    }
    if (!pend && now >= Date.parse(w.nextCheckAt)) {
      const at = new Date(now).toISOString(), c = { id: rid('c_'), at, deadline: new Date(now + CHECK_WIN).toISOString(), code: String(100 + crypto.randomInt(900)), answeredAt: '' };
      (w.checks = w.checks || []).push(c); w.slot = (w.slot || 0) + 1;
      w.nextCheckAt = new Date(Math.max(now + 120e3, Date.parse(w.start) + w.slot * 3600e3 + (60 + crypto.randomInt(3300)) * 1000)).toISOString();
      pushNotif(w.userId, { type: 'info', text: 'n.presenceCheck', link: 'timer', key: 'pc:' + c.id });
      sendTo(w.userId, 'check', { id: c.id, deadline: c.deadline }); changed = true; continue;
    }
    if (dayMs(w.userId, w.inviteId, w.day, now) >= capMs(inv.offer)) { stopSession(w, now, 'cap'); changed = true; sendTo(w.userId, 'timer', {}); }
  }
  if (changed) { persist(); broadcast('changed', {}); }
}
if (MAIN) setInterval(timerTick, 10000);


/* ---------------- payroll: monthly invoices ---------------- */
const INV_AUTO_DAYS = 5;
const nextPeriod = p => { let [y, m] = p.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return y + '-' + p2(m); };
const offerFor = (inv, period) => { let o = inv.offer; for (const h of inv.rateHist || []) if (h.from <= period) o = h.offer; return o; };
function invoiceLines(inv, period) {
  const o = offerFor(inv, period), L = [];
  const startP = inv.contract && inv.contract.startJ ? inv.contract.startJ.slice(0, 7) : period;
  let base = 0;
  if (o.kind === 'hourly') {
    const days = {};
    DB.work.filter(w => w.type === 'session' && w.inviteId === inv.id && periodOfDay(w.day) === period).forEach(w => { days[w.day] = (days[w.day] || 0) + sessionMs(w, Date.now()); });
    let ms = 0; Object.entries(days).forEach(([d, v]) => { const x = splitPay(o, v); base += x.amount; ms += v; });
    L.push({ k: 'base', label: 'hours', amount: base, meta: { ms } });
  } else {
    base = o.amount || 0; L.push({ k: 'base', label: 'monthly', amount: base });
    if (period === startP && inv.contract && inv.contract.adjAmount) L.push({ k: 'adj', label: 'adj', amount: inv.contract.adjAmount });
  }
  DB.work.filter(w => w.type === 'fine' && w.inviteId === inv.id && w.period === period).forEach(f => L.push({ k: 'fine', label: 'presenceFine', amount: -f.amount }));
  if (o.kind === 'agreed' && o.fines) { // late / early task delivery (done tasks of this month, this employee)
    let late = 0, early = 0;
    DB.tasks.filter(t => t.period === period && t.status === 'done' && t.due && t.completedAt && t.assigneeIds.includes(inv.toId) && (!inv.projectId || t.projectId === inv.projectId)).forEach(t => {
      const done = new Date(t.completedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
      if (done > t.due) late++; else if (done < t.due) early++;
    });
    if (late && o.fines.lateTask) L.push({ k: 'fine', label: 'lateTasks', amount: -late * o.fines.lateTask, meta: { n: late } });
    if (early && o.fines.earlyBonus) L.push({ k: 'bonus', label: 'earlyTasks', amount: early * o.fines.earlyBonus, meta: { n: early } });
  }
  ((inv.manual || {})[period] || []).forEach(x => L.push({ k: 'manual', label: x.label, amount: x.amount, mid: x.id }));
  const newTaskFines = Math.floor((inv.taskWarn || 0) / 5) - (inv.taskFined || 0);
  if (newTaskFines > 0) { const pct = (o.fines && o.fines.taskPct) || 0; L.push({ k: 'fine', label: 'taskFine', amount: -Math.round(newTaskFines * pct / 100 * base), meta: { n: newTaskFines, pct } }); }
  if (inv.ins) L.push({ k: 'ins', label: 'ins', amount: -inv.ins });
  if (inv.tax) L.push({ k: 'tax', label: 'tax', amount: -inv.tax });
  return { L, newTaskFines: Math.max(0, newTaskFines) };
}
const invTotal = lines => lines.reduce((a, l) => a + l.amount, 0);
const dueOf = (o, period) => { const [y, m] = nextPeriod(period).split('-').map(Number); return gIso(j2g(y, m, (o && o.payDay) || 10)); };
function makeInvoice(inv, period) {
  if (DB.invoices.some(x => x.inviteId === inv.id && x.period === period)) return null;
  const { L, newTaskFines } = invoiceLines(inv, period);
  inv.taskFined = (inv.taskFined || 0) + newTaskFines;
  const x = { id: rid('v_'), inviteId: inv.id, managerId: inv.fromId, userId: inv.toId, period, status: 'draft', lines: L, total: invTotal(L), due: dueOf(offerFor(inv, period), period), createdAt: nowISO(), history: [{ at: nowISO(), s: 'draft' }] };
  DB.invoices.push(x);
  pushNotif(inv.fromId, { type: 'info', text: 'n.invDraft', params: { name: (userById(inv.toId) || {}).name || '', p: period }, link: 'invoices', key: 'ivd:' + x.id });
  return x;
}
function setInv(x, status, extra) {
  x.status = status; x.statusAt = nowISO(); x.history.push(Object.assign({ at: nowISO(), s: status }, extra || {}));
}
function makeInvoices() {
  const today = todayTehran(), cur = curPeriod(); let any = false;
  for (const inv of DB.invites) {
    if (inv.status !== 'accepted' || !inv.offer || !inv.contract || !inv.contract.startJ) continue;
    let p = inv.contract.startJ.slice(0, 7);
    for (let n = 0; n < 60 && p < cur; n++, p = nextPeriod(p)) {
      if (dayNo(periodEndG(p)) + 5 > dayNo(today)) break;
      if (makeInvoice(inv, p)) any = true;
    }
  }
  // 5 days without an answer → advance
  for (const x of DB.invoices) {
    if (!x.statusAt || (x.status !== 'sent' && x.status !== 'paid')) continue;
    if (Date.now() - Date.parse(x.statusAt) < INV_AUTO_DAYS * 86400e3) continue;
    if (x.status === 'sent') { setInv(x, 'confirmed', { auto: 1 }); pushNotif(x.managerId, { type: 'info', text: 'n.invAutoConfirm', params: { p: x.period }, link: 'invoices', key: 'iva:' + x.id }); }
    else { setInv(x, 'settled', { auto: 1 }); pushNotif(x.managerId, { type: 'info', text: 'n.invAutoSettle', params: { p: x.period }, link: 'invoices', key: 'ivs:' + x.id }); }
    any = true;
  }
  if (any) { persist(); broadcast('changed', {}); }
}
if (MAIN) { setInterval(makeInvoices, 3600e3); setTimeout(makeInvoices, 3000); }
if (MAIN) setInterval(() => { if (applyRates()) { persist(); broadcast('changed', {}); } }, 3600e3);

/* ---------------- HTTP ---------------- */
const SEC = Object.assign(BASE_URL.startsWith('https') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}, {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src https:; connect-src 'self' https://accounts.google.com/gsi/; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
});
function send(res, code, body, extra) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, Object.assign({ 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC, extra));
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req, limit = 3e6) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { no(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { no(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', no);
  });
}
const clientIp = req => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '';
const sessionsOf = (uid, cur) => DB.sessions.filter(s => s.userId === uid).sort((a, b) => b.last.localeCompare(a.last)).map(s => ({ id: s.id.slice(0, 12), ua: s.ua, ip: s.ip, created: s.created, last: s.last, current: s.id === cur }));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  if (!rateOk(clientIp(req))) return send(res, 429, { error: 'rate' });
  if (m === 'GET' && (p === '/' || p === '/index.html')) { try { return send(res, 200, globalThis.__VEDILM_INDEX ? Buffer.from(globalThis.__VEDILM_INDEX) : fs.readFileSync(INDEX)); } catch (e) { return send(res, 500, { error: 'index missing' }); } }
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (m === 'GET' && p === '/api/health') return send(res, 200, { app: 'vedilm', v: 2, mail: MAIL.enabled, invite: !!process.env.SIGNUP_CODE, gid: GOOGLE_CLIENT_ID() });

  /* ----- public auth endpoints ----- */
  if (m === 'POST' && p === '/api/register') {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    const role = b.role === 'employee' ? 'employee' : 'manager';
    if (process.env.SIGNUP_CODE && String(b.invite || '').trim() !== process.env.SIGNUP_CODE) return send(res, 403, { error: 'invite' });
    if (name.length < 2) return send(res, 400, { error: 'name' });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'email' });
    if (DB.users.some(u => u.email === email)) return send(res, 409, { error: 'emailTaken' });
    if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'pwShort' });
    const salt = crypto.randomBytes(16).toString('hex'), code = recoveryCode();
    const user = { id: rid('u_'), code: newUserCode(), name, email, role, salt, hash: hashPw(pw, salt), recovery: hashPw(code, salt + ':rec'), verified: !MAIL.enabled, title: '', phone: '', bio: '', avatar: '', createdAt: nowISO(), prefs: { lang: ['fa', 'en', 'ar', 'zh'].includes(b.lang) ? b.lang : 'fa' } };
    DB.users.push(user);
    const token = newSession(user, req, b.remember); persist();
    if (MAIL.enabled) sendVerify(user);
    return send(res, 200, { token, uid: user.id, recovery: code });
  }
  if (m === 'POST' && p === '/api/google') {
    const b = await readBody(req), key = 'g:' + clientIp(req);
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    const cred = String(b.credential || '');
    let info = null;
    if (process.env.VEDILM_TEST && cred.startsWith('test:')) { try { info = JSON.parse(cred.slice(5)); } catch (e) {} }
    else if (cred.length > 20 && cred.length < 4000) {
      try {
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
        if (r.ok) info = await r.json();
      } catch (e) {}
    }
    const email = info ? String(info.email || '').trim().toLowerCase() : '';
    const ok = info && info.aud === GOOGLE_CLIENT_ID() && (info.email_verified === true || info.email_verified === 'true') && EMAIL_RE.test(email) && (!info.exp || +info.exp * 1000 > Date.now());
    if (!ok) { failed(key); return send(res, 401, { error: 'badGoogle' }); }
    let u = DB.users.find(x => x.email === email);
    if (u) return send(res, 200, { token: newSession(u, req, b.remember), uid: u.id });
    if (!b.role) return send(res, 200, { need: 'role', invite: !!process.env.SIGNUP_CODE });
    if (process.env.SIGNUP_CODE && String(b.invite || '').trim() !== process.env.SIGNUP_CODE) return send(res, 403, { error: 'invite' });
    const salt = crypto.randomBytes(16).toString('hex'), name = String(info.name || email.split('@')[0]).trim().slice(0, 80) || 'user';
    u = { id: rid('u_'), code: newUserCode(), name: name.length < 2 ? name + ' ' : name, email, role: b.role === 'employee' ? 'employee' : 'manager', salt, hash: hashPw(crypto.randomBytes(24).toString('hex'), salt), recovery: hashPw(recoveryCode(), salt + ':rec'), verified: true, google: true, title: '', phone: '', bio: '', avatar: '', createdAt: nowISO(), prefs: { lang: ['fa', 'en', 'ar', 'zh'].includes(b.lang) ? b.lang : 'fa' } };
    DB.users.push(u);
    return send(res, 200, { token: newSession(u, req, b.remember), uid: u.id, created: true });
  }
  if (m === 'POST' && p === '/api/login') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase(), key = 'l:' + email + ':' + clientIp(req);
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    const u = DB.users.find(x => x.email === email);
    if (!u || !checkPw(String(b.password || ''), u.salt, u.hash)) { failed(key); if (!u) hashPw('x', 'dummy-salt'); return send(res, 401, { error: 'badLogin' }); }
    cleared(key);
    return send(res, 200, { token: newSession(u, req, b.remember), uid: u.id });
  }
  if (m === 'GET' && p === '/api/verify') {
    const u = useToken(url.searchParams.get('t'), 'verify');
    if (u) { u.verified = true; persist(); }
    return send(res, u ? 200 : 400, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">${u ? `<meta http-equiv=refresh content="2;url=${BASE_URL}/">` : ''}<body style="font-family:system-ui;text-align:center;padding:60px"><h2>${u ? '✓ ایمیل تأیید شد / Email verified' : 'لینک نامعتبر یا منقضی است / Invalid or expired link'}</h2><p><a href="${BASE_URL}/">vedilm</a></p>`);
  }
  if (m === 'POST' && p === '/api/forgot-email') {
    const b = await readBody(req), email = String(b.email || '').trim().toLowerCase(), key = 'r:' + clientIp(req);
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    failed(key);
    const u = DB.users.find(x => x.email === email);
    if (u && MAIL.enabled !== undefined) { const [s, t] = MAILTXT.reset(u.name, `${BASE_URL}/#/reset/${makeToken(u.id, 'reset', 3600e3)}`, (u.prefs || {}).lang); sendMail(u.email, s, t); }
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/reset') {
    const b = await readBody(req), key = 'rs:' + clientIp(req);
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'pwShort' });
    const u = useToken(b.token, 'reset');
    if (!u) { failed(key); return send(res, 400, { error: 'badToken' }); }
    u.hash = hashPw(pw, u.salt); if (MAIL.enabled) u.verified = true; DB.sessions = DB.sessions.filter(x => x.userId !== u.id); persist();
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/forgot') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase(), key = 'f:' + email + ':' + clientIp(req);
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    const code = String(b.code || '').trim().toUpperCase().replace(/\s|-/g, ''), pw = String(b.password || '');
    if (pw.length < 8) return send(res, 400, { error: 'pwShort' });
    const u = DB.users.find(x => x.email === email);
    if (!u || !u.recovery || !checkPw(code, u.salt + ':rec', u.recovery)) { failed(key); return send(res, 401, { error: 'badRecovery' }); }
    cleared(key);
    u.hash = hashPw(pw, u.salt); DB.sessions = DB.sessions.filter(s => s.userId !== u.id); persist();
    return send(res, 200, { ok: true });
  }

  /* ----- authenticated ----- */
  const au = authOf(req);
  if (!au) return send(res, 401, { error: 'auth' });
  const { user, session } = au;

  if (process.env.VEDILM_TEST && p === '/api/_test/timer' && m === 'POST') { // test-only time travel
    const b = await readBody(req), w = activeSession(user.id); if (!w) return send(res, 409, { error: 'idle' });
    if (b.action === 'check') w.nextCheckAt = new Date(Date.now() - 1000).toISOString();
    if (b.action === 'expire') { const c = (w.checks || []).find(x => !x.answeredAt); if (c) c.deadline = new Date(Date.now() - 1000).toISOString(); }
    if (b.action === 'shift') { const ms = +b.ms || 0; w.start = new Date(Date.parse(w.start) - ms).toISOString(); }
    timerTick(); return send(res, 200, { ok: 1 });
  }
  /* leave + rate-change requests */
  if (p === '/api/requests' && m === 'GET') {
    const mine = i => i.toId === user.id || i.fromId === user.id;
    return send(res, 200, {
      leaves: DB.leaves.filter(l => l.userId === user.id || l.managerId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(l => Object.assign({}, l, { userName: (userById(l.userId) || {}).name || '' })),
      contracts: DB.invites.filter(i => i.status === 'accepted' && i.offer && mine(i)).map(i => ({ id: i.id, title: i.title, kind: i.offer.kind, offer: i.offer, change: i.change || null, scheduled: i.scheduled || null, toId: i.toId, fromId: i.fromId, userName: (userById(i.toId) || {}).name || '' })),
      nextPeriod: nextPeriod(curPeriod())
    });
  }
  if (p === '/api/leave' && m === 'POST') {
    const b = await readBody(req), act = String(b.act || '');
    if (act === 'create') {
      const inv = DB.invites.find(i => i.id === String(b.inviteId || '') && i.toId === user.id && i.status === 'accepted');
      const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d), from = String(b.from || ''), to = String(b.to || b.from || '');
      if (!inv || !ok(from) || !ok(to) || to < from || dayNo(to) - dayNo(from) > 60) return send(res, 400, { error: 'bad' });
      const l = { id: rid('l_'), inviteId: inv.id, userId: user.id, managerId: inv.fromId, from, to, reason: (str(b.reason, 300) || '').trim(), status: 'pending', createdAt: nowISO() };
      DB.leaves.push(l); pushNotif(inv.fromId, { type: 'info', text: 'n.leaveReq', params: { name: user.name, a: from, b: to }, link: 'requests', key: 'lv:' + l.id });
    } else if (act === 'decide') {
      const l = DB.leaves.find(x => x.id === String(b.id || '') && x.managerId === user.id && x.status === 'pending'); if (!l) return send(res, 409, { error: 'state' });
      l.status = b.ok ? 'approved' : 'rejected'; l.decidedAt = nowISO();
      pushNotif(l.userId, { type: 'info', text: b.ok ? 'n.leaveOk' : 'n.leaveNo', params: { a: l.from, b: l.to }, link: 'requests', key: 'lvd:' + l.id });
    } else if (act === 'cancel') {
      const l = DB.leaves.find(x => x.id === String(b.id || '') && x.userId === user.id && x.status === 'pending'); if (!l) return send(res, 409, { error: 'state' });
      DB.leaves.splice(DB.leaves.indexOf(l), 1);
    } else return send(res, 400, { error: 'act' });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  /* ---------- daily work reports ---------- */
  const tehranHM = () => new Date(Date.now() + 3.5 * 3600e3).toISOString().slice(11, 16);
  const empInvite = (mgrId, empId) => DB.invites.find(i => i.fromId === mgrId && i.toId === empId && i.status === 'accepted' && i.offer);
  const reportGate = (uid, pr) => {
    if (isLocked(pr)) return { ok: false, reason: 'locked' };
    const day = todayTehran();
    if (DB.reports.some(r => r.projectId === pr.id && r.userId === uid && r.day === day && r.status !== 'rejected')) return { ok: false, reason: 'done' };
    const inv = empInvite(pr.ownerId, uid); if (!inv) return { ok: true };
    const o = inv.offer;
    if (o.kind === 'hourly') {
      const need = Math.round(0.7 * NORMAL_H * 3600e3), worked = dayMs(uid, inv.id, day, Date.now());
      return worked >= need ? { ok: true } : { ok: false, reason: 'hours', needMin: Math.ceil(need / 60e3), workedMin: Math.floor(worked / 60e3) };
    }
    if (o.workTo && tehranHM() < o.workTo) return { ok: false, reason: 'window', at: o.workTo };
    return { ok: true };
  };
  if (p === '/api/reports' && m === 'GET') {
    const mine = DB.projects.filter(x => x.ownerId === user.id).map(x => x.id), member = DB.projects.filter(x => isMember(x, user.id)).map(x => x.id);
    const out = DB.reports.filter(r => user.role === 'manager' ? mine.includes(r.projectId) : (r.userId === user.id || (member.includes(r.projectId) && r.status === 'approved')));
    const gates = {}; if (user.role !== 'manager') for (const pid of member) { const pr = projById(pid); if (pr && pr.ownerId !== user.id) gates[pid] = reportGate(user.id, pr); }
    return send(res, 200, { reports: out.slice(-600), gates });
  }
  if (p === '/api/report' && m === 'POST') {
    const b = await readBody(req), pr = projById(String(b.projectId || ''));
    if (!pr || !isMember(pr, user.id) || pr.ownerId === user.id) return send(res, 400, { error: 'project' });
    const subject = (str(b.subject, 120) || '').trim(), text = (str(b.text, 3000) || '').trim();
    if (!subject || !text) return send(res, 400, { error: 'empty' });
    const re = b.id ? DB.reports.find(r => r.id === String(b.id) && r.userId === user.id && r.status === 'rejected') : null;
    if (!re) { const g = reportGate(user.id, pr); if (!g.ok) return send(res, 403, { error: g.reason, gate: g }); }
    if (re) { re.subject = subject; re.text = text; re.status = 'pending'; re.note = ''; re.at = nowISO(); }
    else DB.reports.push({ id: rid('r_'), projectId: pr.id, userId: user.id, subject, text, day: todayTehran(), at: nowISO(), status: 'pending', note: '' });
    pushNotif(pr.ownerId, { type: 'info', text: 'n.reportNew', params: { name: user.name, p: pr.name }, link: 'dayreport', key: 'rp:' + Date.now() });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  if (p === '/api/report/decide' && m === 'POST') {
    const b = await readBody(req), r = DB.reports.find(x => x.id === String(b.id || '')), pr = r && projById(r.projectId);
    if (!r || !pr || pr.ownerId !== user.id || r.status !== 'pending') return send(res, 409, { error: 'state' });
    r.status = b.ok ? 'approved' : 'rejected'; r.note = b.ok ? '' : (str(b.note, 400) || '').trim(); r.decidedAt = nowISO();
    pushNotif(r.userId, { type: 'info', text: b.ok ? 'n.reportOk' : 'n.reportNo', params: { p: pr.name }, link: 'dayreport', key: 'rpd:' + r.id + Date.now() });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  /* ---------- need requests (supplies etc.) ---------- */
  if (p === '/api/needs' && m === 'GET') {
    const mine = new Set(DB.projects.filter(x => x.ownerId === user.id).map(x => x.id));
    return send(res, 200, { needs: DB.needs.filter(n => n.userId === user.id || n.managerId === user.id).slice(-400) });
  }
  if (p === '/api/need' && m === 'POST') {
    const b = await readBody(req), act = String(b.act || 'create');
    if (act === 'create') {
      const mgrId = String(b.managerId || ''), inv = DB.invites.find(i => i.fromId === mgrId && i.toId === user.id && i.status === 'accepted');
      const title = (str(b.title, 120) || '').trim();
      if (!inv || !title) return send(res, 400, { error: 'bad' });
      const pr = b.projectId ? projById(String(b.projectId)) : null;
      DB.needs.push({ id: rid('n_'), userId: user.id, managerId: mgrId, projectId: pr && pr.ownerId === mgrId && isMember(pr, user.id) ? pr.id : '', title, text: (str(b.text, 1500) || '').trim(), qty: (str(b.qty, 60) || '').trim(), urgent: b.urgent === true, status: 'open', note: '', at: nowISO() });
      pushNotif(mgrId, { type: 'info', text: b.urgent === true ? 'n.needUrgent' : 'n.needNew', params: { name: user.name, t: title }, link: 'needs', key: 'nd:' + Date.now() });
    } else if (act === 'decide') {
      const n = DB.needs.find(x => x.id === String(b.id || '') && x.managerId === user.id);
      const st = String(b.status || ''); if (!n || !['approved', 'rejected', 'delivered'].includes(st)) return send(res, 409, { error: 'state' });
      n.status = st; n.note = (str(b.note, 400) || '').trim(); n.decidedAt = nowISO();
      pushNotif(n.userId, { type: 'info', text: 'n.need.' + st, params: { t: n.title }, link: 'needs', key: 'ndd:' + n.id + st });
    } else if (act === 'cancel') {
      const n = DB.needs.find(x => x.id === String(b.id || '') && x.userId === user.id && x.status === 'open'); if (!n) return send(res, 409, { error: 'state' });
      DB.needs.splice(DB.needs.indexOf(n), 1);
    } else return send(res, 400, { error: 'act' });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  if (p === '/api/contract/end' && m === 'POST') {
    const b = await readBody(req), inv = DB.invites.find(i => i.id === String(b.inviteId || '') && i.status === 'accepted' && (i.fromId === user.id || i.toId === user.id));
    if (!inv) return send(res, 404, { error: 'none' });
    inv.status = 'ended'; inv.endedAt = nowISO(); inv.endedBy = user.id; delete inv.change; delete inv.scheduled;
    pushNotif(inv.fromId === user.id ? inv.toId : inv.fromId, { type: 'info', text: 'n.contractEnded', params: { name: user.name }, link: 'team', key: 'ce:' + inv.id });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  if (p === '/api/rate' && m === 'POST') {
    const b = await readBody(req), act = String(b.act || ''), inv = DB.invites.find(i => i.id === String(b.inviteId || '') && i.status === 'accepted' && i.offer && (i.fromId === user.id || i.toId === user.id));
    if (!inv) return send(res, 404, { error: 'none' });
    if (act === 'propose' && inv.fromId === user.id) {
      const o = inv.offer, patch = {};
      if (o.kind === 'agreed') patch.amount = numIn(b.amount, 1, 1e11, 0); else { patch.rateN = numIn(b.rateN, 1, 1e9, 0); patch.rateO = numIn(b.rateO, 0, 1e9, 0); patch.overMax = numIn(b.overMax, 0, 8, o.overMax); }
      if (Object.values(patch).some(v => !(v >= 0)) || (o.kind === 'agreed' ? !patch.amount : !patch.rateN)) return send(res, 400, { error: 'bad' });
      inv.change = { patch, from: nextPeriod(curPeriod()), at: nowISO() };
      pushNotif(inv.toId, { type: 'info', text: 'n.rateProp', params: { name: user.name }, link: 'requests', key: 'rp:' + inv.id + ':' + inv.change.at });
    } else if (act === 'withdraw' && inv.fromId === user.id && inv.change) { delete inv.change; }
    else if (act === 'answer' && inv.toId === user.id && inv.change) {
      const ch = inv.change; delete inv.change;
      if (b.ok) { inv.scheduled = { patch: ch.patch, from: ch.from > curPeriod() ? ch.from : nextPeriod(curPeriod()) }; }
      pushNotif(inv.fromId, { type: 'info', text: b.ok ? 'n.rateYes' : 'n.rateNo', params: { name: user.name }, link: 'requests', key: 'ra2:' + inv.id + ':' + ch.at });
    } else return send(res, 409, { error: 'state' });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  /* live payroll statement (current month) */
  if (p === '/api/payroll' && m === 'GET') {
    const per = curPeriod();
    const list = DB.invites.filter(i => i.status === 'accepted' && i.offer && i.contract && (i.toId === user.id || i.fromId === user.id)).map(i => {
      const { L } = invoiceLines(i, per);
      return { inviteId: i.id, title: i.title, kind: i.offer.kind, period: per, userId: i.toId, userName: (userById(i.toId) || {}).name || '', lines: L, total: invTotal(L), ins: i.ins || 0, tax: i.tax || 0, due: dueOf(offerFor(i, per), per), meeting: (i.offer.fines && i.offer.fines.meeting) || 0 };
    });
    return send(res, 200, { statements: list });
  }
  if (p === '/api/payroll' && m === 'POST') {
    const b = await readBody(req), inv = DB.invites.find(i => i.id === String(b.inviteId || '') && i.fromId === user.id && i.status === 'accepted' && i.offer), per = curPeriod();
    if (!inv) return send(res, 404, { error: 'none' });
    inv.manual = inv.manual || {}; const arr = inv.manual[per] = inv.manual[per] || [];
    if (b.act === 'add') {
      const label = (str(b.label, 80) || '').trim(), amt = Math.round(+b.amount);
      if (!label || !Number.isFinite(amt) || !amt || Math.abs(amt) > 1e11 || arr.length >= 40) return send(res, 400, { error: 'line' });
      arr.push({ id: rid('m_'), label, amount: amt, at: nowISO() });
      pushNotif(inv.toId, { type: 'info', text: amt > 0 ? 'n.payAdd' : 'n.payCut', params: { l: label }, link: 'invoices', key: 'pm:' + arr[arr.length - 1].id });
    } else if (b.act === 'del') { const i = arr.findIndex(x => x.id === b.id); if (i < 0) return send(res, 400, { error: 'line' }); arr.splice(i, 1); }
    else if (b.act === 'set') { if (b.ins !== undefined) inv.ins = numIn(b.ins, 0, 1e11, 0); if (b.tax !== undefined) inv.tax = numIn(b.tax, 0, 1e11, 0); }
    else return send(res, 400, { error: 'act' });
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  /* invoices */
  if (p === '/api/invoices' && m === 'GET') {
    const list = DB.invoices.filter(x => x.userId === user.id || x.managerId === user.id)
      .filter(x => x.userId === user.id ? x.status !== 'draft' : true).sort((a, b) => b.period.localeCompare(a.period) || b.createdAt.localeCompare(a.createdAt))
      .map(x => Object.assign({}, x, { userName: (userById(x.userId) || {}).name || '', managerName: (userById(x.managerId) || {}).name || '', title: (DB.invites.find(i => i.id === x.inviteId) || {}).title || '' }));
    return send(res, 200, { invoices: list });
  }
  if (p === '/api/invoice' && m === 'POST') {
    const b = await readBody(req), x = DB.invoices.find(v => v.id === String(b.id || ''));
    if (!x || (x.userId !== user.id && x.managerId !== user.id)) return send(res, 404, { error: 'none' });
    const mgr = x.managerId === user.id, emp = x.userId === user.id, act = String(b.act || ''), st = x.status;
    const bad = () => send(res, 409, { error: 'state' });
    if (act === 'line-add' && mgr && st === 'draft') {
      const label = (str(b.label, 80) || '').trim(), amt = Math.round(+b.amount);
      if (!label || !Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1e11) return send(res, 400, { error: 'line' });
      if (x.lines.filter(l => l.k === 'manual').length >= 20) return send(res, 400, { error: 'line' });
      x.lines.push({ k: 'manual', label, amount: amt });
    } else if (act === 'line-del' && mgr && st === 'draft') {
      const i = +b.idx; if (!x.lines[i] || x.lines[i].k !== 'manual') return send(res, 400, { error: 'line' }); x.lines.splice(i, 1);
    } else if (act === 'send' && mgr && st === 'draft') {
      setInv(x, 'sent'); pushNotif(x.userId, { type: 'info', text: 'n.invSent', params: { p: x.period }, link: 'invoices', key: 'ivt:' + x.id + ':' + x.history.length });
    } else if (act === 'confirm' && emp && st === 'sent') {
      setInv(x, 'confirmed'); pushNotif(x.managerId, { type: 'info', text: 'n.invConfirmed', params: { name: user.name, p: x.period }, link: 'invoices', key: 'ivc:' + x.id });
    } else if (act === 'dispute' && emp && st === 'sent') {
      const text = (str(b.text, 500) || '').trim(); if (!text) return send(res, 400, { error: 'text' });
      setInv(x, 'disputed', { text }); x.disputeText = text; pushNotif(x.managerId, { type: 'info', text: 'n.invDisputed', params: { name: user.name, p: x.period }, link: 'invoices', key: 'ivx:' + x.id + ':' + x.history.length });
    } else if (act === 'revise' && mgr && st === 'disputed') {
      setInv(x, 'draft', { revised: 1 });
    } else if (act === 'paid' && mgr && st === 'confirmed') {
      const o = offerFor(DB.invites.find(i => i.id === x.inviteId) || {}, x.period) || {}, today = todayTehran();
      if (x.due && today > x.due && o.lateDay > 0) { const days = dayNo(today) - dayNo(x.due); x.lines.push({ k: 'late', label: 'lateDmg', amount: days * o.lateDay, meta: { days } }); x.lateDays = days; }
      setInv(x, 'paid'); pushNotif(x.userId, { type: 'info', text: 'n.invPaid', params: { p: x.period }, link: 'invoices', key: 'ivp:' + x.id });
    } else if (act === 'received' && emp && st === 'paid') {
      setInv(x, 'settled'); pushNotif(x.managerId, { type: 'info', text: 'n.invReceived', params: { name: user.name, p: x.period }, link: 'invoices', key: 'ivr:' + x.id });
    } else return bad();
    x.total = invTotal(x.lines); persist(); broadcast('changed', {});
    return send(res, 200, { ok: true });
  }
  if (process.env.VEDILM_TEST && p === '/api/_test/invoice' && m === 'POST') {
    const b = await readBody(req), inv = DB.invites.find(i => i.id === b.inviteId); if (!inv) return send(res, 404, {});
    if (b.action === 'make') { const x = makeInvoice(inv, b.period); persist(); return send(res, 200, { id: x && x.id }); }
    if (b.action === 'apply') { const i = DB.invites.find(x => x.id === b.inviteId); if (i && i.scheduled) i.scheduled.from = curPeriod(); const r = applyRates(); persist(); return send(res, 200, { ok: r }); }
    if (b.action === 'age') { const x = DB.invoices.find(v => v.id === b.id); x.statusAt = new Date(Date.now() - 6 * 86400e3).toISOString(); makeInvoices(); return send(res, 200, { ok: 1 }); }
  }
  /* hourly timer */
  if (p === '/api/timer' && m === 'GET') {
    const now = Date.now(), id = url.searchParams.get('inviteId');
    if (id) {
      const inv = DB.invites.find(i => i.id === id && i.status === 'accepted' && i.offer && i.offer.kind === 'hourly' && (i.toId === user.id || i.fromId === user.id));
      if (!inv) return send(res, 404, { error: 'none' });
      return send(res, 200, timerSummary(inv, now));
    }
    return send(res, 200, { contracts: DB.invites.filter(i => i.status === 'accepted' && i.offer && i.offer.kind === 'hourly' && i.toId === user.id).map(i => ({ id: i.id, title: i.title, projectName: i.projectName || '', fromId: i.fromId })), now });
  }
  if (p === '/api/timer/start' && m === 'POST') {
    const b = await readBody(req), inv = hourlyContract(user.id, String(b.inviteId || ''));
    if (!inv) return send(res, 404, { error: 'contract' });
    if (activeSession(user.id)) return send(res, 409, { error: 'running' });
    const now = Date.now(), day = todayTehran();
    if (dayMs(user.id, inv.id, day, now) >= capMs(inv.offer)) return send(res, 409, { error: 'day-full' });
    const w = { id: rid('w_'), type: 'session', userId: user.id, inviteId: inv.id, day, start: new Date(now).toISOString(), end: '', checks: [], slot: 0, nextCheckAt: new Date(now + (60 + crypto.randomInt(3300)) * 1000).toISOString() };
    DB.work.push(w); persist(); broadcast('changed', {});
    return send(res, 200, timerSummary(inv, now));
  }
  if (p === '/api/timer/stop' && m === 'POST') {
    const w = activeSession(user.id); if (!w) return send(res, 409, { error: 'idle' });
    const now = Date.now(), pend = (w.checks || []).find(c => !c.answeredAt);
    stopSession(w, pend ? Math.min(now, Date.parse(pend.at)) : now, 'user'); persist(); broadcast('changed', {});
    const inv = DB.invites.find(i => i.id === w.inviteId);
    return send(res, 200, timerSummary(inv, now));
  }
  if (p === '/api/timer/ping' && m === 'POST') {
    const b = await readBody(req), w = activeSession(user.id); if (!w) return send(res, 409, { error: 'idle' });
    const now = Date.now(), c = (w.checks || []).find(x => !x.answeredAt && Date.parse(x.deadline) > now);
    if (!c) return send(res, 409, { error: 'nocheck' });
    if (String(b.code || '').trim() !== c.code) return send(res, 400, { error: 'code' });
    c.answeredAt = new Date(now).toISOString(); persist();
    return send(res, 200, timerSummary(DB.invites.find(i => i.id === w.inviteId), now));
  }
  if (m === 'GET' && p === '/api/state') return send(res, 200, buildState(user.id));
  if (m === 'POST' && p === '/api/sync') {
    const b = await readBody(req);
    const { touched, rejected } = applySync(user, b.changes);
    if (touched.size) broadcast('changed', { by: user.id }, String(b.cid || ''));
    return send(res, 200, { rejected, state: buildState(user.id) });
  }
  if (m === 'GET' && p === '/api/plan') return send(res, 200, planView(user));
  if (process.env.VEDILM_TEST && p === '/api/_test/plan' && m === 'POST') {
    const b = await readBody(req);
    if (user.plan && b.expire) user.plan.end = new Date(Date.now() - 1000).toISOString();
    if (user.plan && b.daysLeft !== undefined) user.plan.end = new Date(Date.now() + b.daysLeft * 86400e3).toISOString();
    persist(); broadcast('changed', {}); return send(res, 200, planView(user));
  }
  if (m === 'POST' && p === '/api/personal') {
    const b = await readBody(req), pi = cleanPI(b);
    if (!pi) return send(res, 400, { error: 'invalid' });
    user.pi = pi; persist(); return send(res, 200, planView(user));
  }
  if (m === 'POST' && p === '/api/plan/buy') {
    const b = await readBody(req), tier = String(b.tier || ''), per = String(b.per || '');
    const def = PLANS[user.role] && PLANS[user.role][tier];
    if (!def || !def.price || !PLAN_DAYS[per]) return send(res, 400, { error: 'plan' });
    if (!user.pi) return send(res, 400, { error: 'personal' });
    if (b.agree !== true) return send(res, 400, { error: 'agree' });
    const now = Date.now(), cur = planState(user);
    const base = cur.active && cur.paidTier === tier ? Date.parse(user.plan.end) : now;
    const start = cur.active && cur.paidTier === tier ? user.plan.start : new Date(now).toISOString();
    user.plan = { tier, per, start, end: new Date(base + PLAN_DAYS[per] * 86400e3).toISOString(), price: def.price[per], boughtAt: new Date(now).toISOString() };
    user.planHist = (user.planHist || []).concat([{ tier, per, price: def.price[per], at: new Date(now).toISOString(), trial: true }]).slice(-30);
    pushNotif(user.id, { type: 'info', text: 'n.planOn.' + tier, params: {}, link: 'profile', key: 'plan:' + now });
    persist(); broadcast('changed', {});
    return send(res, 200, planView(user));
  }
  if (m === 'GET' && p === '/api/users/search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const rel = new Set(); DB.invites.forEach(i => { if ((i.status === 'pending' || i.status === 'accepted') && (i.fromId === user.id || i.toId === user.id)) { rel.add(i.fromId); rel.add(i.toId); } });
    const digits = q.replace(/[^0-9۰-۹٠-٩]/g, '').replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632));
    const out = digits.length >= 6 ? DB.users.filter(u => u.id !== user.id && !rel.has(u.id) && u.code === digits).slice(0, 3).map(u => pubUser(u, false)) : [];
    return send(res, 200, { users: out });
  }
  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, SEC));
    const cid = String(url.searchParams.get('cid') || ''), s = { res, uid: user.id, cid };
    const wasOnline = onlineIds().includes(user.id);
    streams.add(s); res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
    if (!wasOnline) broadcast('presence', { online: onlineIds() });
    else res.write(`event: presence\ndata: ${JSON.stringify({ online: onlineIds() })}\n\n`);
    req.on('close', () => { streams.delete(s); if (!onlineIds().includes(user.id)) broadcast('presence', { online: onlineIds() }); });
    return;
  }
  if (m === 'POST' && p === '/api/resend-verify') {
    const key = 'rv:' + user.id; if (throttled(key)) return send(res, 429, { error: 'throttle' });
    failed(key); if (user.verified === false) sendVerify(user); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/logout') { DB.sessions = DB.sessions.filter(s => s !== session); persist(); return send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/api/password') {
    const b = await readBody(req), key = 'p:' + user.id;
    if (throttled(key)) return send(res, 429, { error: 'throttle' });
    if (!checkPw(String(b.cur || ''), user.salt, user.hash)) { failed(key); return send(res, 400, { error: 'curPw' }); }
    const nw = String(b.neu || ''); if (nw.length < 8 || nw.length > 200) return send(res, 400, { error: 'pwShort' });
    cleared(key); user.hash = hashPw(nw, user.salt);
    DB.sessions = DB.sessions.filter(s => s.userId !== user.id || s === session); persist();
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/recovery') {
    const code = recoveryCode(); user.recovery = hashPw(code, user.salt + ':rec'); persist();
    return send(res, 200, { code });
  }
  if (m === 'GET' && p === '/api/sessions') return send(res, 200, { sessions: sessionsOf(user.id, session.id) });
  if (m === 'DELETE' && p.startsWith('/api/sessions/')) {
    const id = p.slice(14);
    if (id === 'others') DB.sessions = DB.sessions.filter(s => s.userId !== user.id || s === session);
    else DB.sessions = DB.sessions.filter(s => !(s.userId === user.id && s.id.slice(0, 12) === id && s !== session));
    persist(); return send(res, 200, { sessions: sessionsOf(user.id, session.id) });
  }
  if (m === 'DELETE' && p === '/api/account') {
    const uid = user.id;
    DB.projects.filter(x => x.ownerId === uid).forEach(x => deleteProject(x.id));
    DB.projects.forEach(x => x.members = x.members.filter(y => y.userId !== uid));
    DB.tasks.forEach(x => { x.assigneeIds = x.assigneeIds.filter(a => a !== uid); x.comments = x.comments.filter(c => c.userId !== uid); });
    DB.invites = DB.invites.filter(i => i.fromId !== uid && i.toId !== uid);
    DB.messages = DB.messages.filter(m => m.fromId !== uid && m.toId !== uid);
    DB.notifs = DB.notifs.filter(n => n.userId !== uid); DB.events = DB.events.filter(e => e.ownerId !== uid);
    DB.tokens = DB.tokens.filter(t => t.userId !== uid); DB.sessions = DB.sessions.filter(s => s.userId !== uid); DB.users = DB.users.filter(x => x.id !== uid);
    persist(); broadcast('changed', {}); return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

const onRequest = (req, res) => {
  handle(req, res).catch(err => {
    if (res.headersSent) return res.end();
    send(res, err && err.code === 413 ? 413 : err && err.code === 400 ? 400 : 500, { error: err && err.code ? err.message : 'server' });
    if (!(err && err.code)) console.error(err);
  });
};
const server = CF ? { listen() {} } : http.createServer(onRequest);
server.keepAliveTimeout = 65000;
if (!CF && require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  vedilm is running →  http://localhost:${PORT}\n  storage: ${sql ? 'SQLite (' + SQL_FILE + ')' : 'JSON file'}   mail: ${MAIL.enabled ? 'SMTP' : 'console (dev)'}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
      for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  on your network:  http://${n.address}:${PORT}`);
    }
    console.log('');
  });
}
module.exports = { server, onRequest, rebind, DB, MAIL, smtpSend, closePeriods, curPeriod, roundStart, timerTick, applyRates, makeInvoices, streams, onlineIds: () => onlineIds() };
