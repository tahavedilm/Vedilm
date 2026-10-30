/* vedilm on Cloudflare: one Durable Object holds the whole app (in-memory model + SQLite storage + live streams). */
import { DurableObject } from 'cloudflare:workers';
import indexHtml from './index.html';
import { makeSqlShim, handleFetch } from './adapter.js';

const ENV_KEYS = ['SIGNUP_CODE', 'BASE_URL', 'SMTP_URL', 'MAIL_FROM', 'BACKUP_KEEP'];

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      globalThis.__VEDILM_CF = true;
      globalThis.__VEDILM_INDEX = indexHtml;
      globalThis.__VEDILM_SQL = makeSqlShim(ctx.storage.sql);
      for (const k of ENV_KEYS) if (env[k] !== undefined && env[k] !== null) process.env[k] = String(env[k]);
      process.env.TRUST_PROXY = '1';
      const mod = await import('./server.js');
      this.core = mod.default || mod;
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 30000);
    });
  }
  async fetch(request) {
    await this.ready;
    return handleFetch(request, this.core.onRequest);
  }
  async alarm() {
    await this.ready;
    const c = this.core;
    try { c.timerTick(); c.makeInvoices(); c.closePeriods(); if (c.applyRates()) { /* persisted by tick loop */ } } catch (e) { console.error('alarm', e && e.message); }
    const busy = c.streams.size > 0 || c.DB.work.some(w => w.type === 'session' && !w.end);
    await this.ctx.storage.setAlarm(Date.now() + (busy ? 30000 : 15 * 60000));
  }
}

export default {
  async fetch(request, env) {
    const stub = env.APP.get(env.APP.idFromName('main'));
    return stub.fetch(request);
  },
};
