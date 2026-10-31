/* Glue between Cloudflare's fetch(Request)->Response world and the Node-style (req,res) handler in server.js. */
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

/* DatabaseSync-compatible facade over a Durable Object's synchronous SQL storage */
export function makeSqlShim(sqlStorage) {
  const run = (q, args) => sqlStorage.exec(q, ...args);
  return {
    exec(text) {
      for (const stmt of String(text).split(';')) {
        const q = stmt.trim();
        if (!q || /^(PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i.test(q)) continue; // DO storage handles durability/transactions itself
        run(q, []).toArray();
      }
    },
    prepare(q) {
      return {
        all: (...a) => run(q, a).toArray(),
        get: (...a) => run(q, a).toArray()[0],
        run: (...a) => { run(q, a).toArray(); return {}; },
      };
    },
  };
}

export async function handleFetch(request, onRequest) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const ip = headers['cf-connecting-ip'] || headers['x-real-ip'] || '';
  if (ip && !headers['x-forwarded-for']) headers['x-forwarded-for'] = ip;

  const body = request.method === 'GET' || request.method === 'HEAD' ? null : Buffer.from(await request.arrayBuffer());
  const req = Readable.from(body && body.length ? [body] : []);
  Object.assign(req, { method: request.method, url: url.pathname + url.search, headers, socket: { remoteAddress: ip }, connection: { remoteAddress: ip } });

  let ctl, settled = false, resolveResp;
  const respP = new Promise(r => { resolveResp = r; });
  const stream = new ReadableStream({
    start(c) { ctl = c; },
    cancel() { res.emit('close'); req.emit('close'); },
  });
  const res = new EventEmitter();
  let status = 200, hdrs = {};
  res.headersSent = false;
  res.statusCode = 200;
  res.setHeader = (k, v) => { hdrs[String(k).toLowerCase()] = v; };
  res.getHeader = k => hdrs[String(k).toLowerCase()];
  const flushHead = () => {
    if (res.headersSent) return;
    res.headersSent = true;
    const h = new Headers();
    for (const [k, v] of Object.entries(hdrs)) if (!HOP.has(k.toLowerCase())) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const nullBody = status === 204 || status === 304 || request.method === 'HEAD';
    settled = true;
    resolveResp(new Response(nullBody ? null : stream, { status, headers: h }));
  };
  res.writeHead = (code, h) => { status = code; res.statusCode = code; if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v); flushHead(); return res; };
  const toBytes = c => (typeof c === 'string' ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c));
  res.write = c => { if (!res.headersSent) { status = res.statusCode; flushHead(); } try { ctl.enqueue(toBytes(c)); } catch (e) {} return true; };
  res.end = c => {
    if (c !== undefined && c !== null && c !== '') res.write(c); else if (!res.headersSent) { status = res.statusCode; flushHead(); }
    try { ctl.close(); } catch (e) {}
    res.emit('finish');
  };
  res.destroy = () => { try { ctl.close(); } catch (e) {} };

  try { onRequest(req, res); } catch (e) { if (!settled) resolveResp(new Response('server error', { status: 500 })); }
  return respP;
}
