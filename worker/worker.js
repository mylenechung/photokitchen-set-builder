/**
 * Photokitchen Set Builder — Cloudflare Worker
 *
 * Routes:
 *   PUT  /asset?key=<r2-key>      Upload binary asset to R2
 *   GET  /asset?key=<r2-key>      Serve asset from R2
 *   DELETE /asset?key=<r2-key>   Delete asset from R2
 *   GET  /assets/list             List all objects under assets/ prefix
 *   GET  /kv?key=<name>           Read JSON blob from R2 (returns { value: string })
 *   PUT  /kv?key=<name>           Write JSON blob to R2 (body = raw string)
 *   GET  /proxy?url=<asset-url>   Proxy an R2 asset with fresh CORS headers (for PPTX backup)
 *
 * Auth: X-API-Key header must match API_KEY secret (set via: wrangler secret put API_KEY)
 * CORS: restricted to https://mylenechung.github.io and localhost for dev
 */

const ALLOWED_ORIGINS = [
  'https://mylenechung.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function respond(body, status, extra = {}, origin = '') {
  return new Response(body, {
    status,
    headers: { ...corsHeaders(origin), ...extra },
  });
}

function unauthorized(origin) {
  return respond('Unauthorized', 401, {}, origin);
}

function notFound(origin) {
  return respond('Not found', 404, {}, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return respond(null, 204, {}, origin);
    }

    // Auth — skip for public read routes (asset serving and proxy)
    const isPublicRead = request.method === 'GET' &&
      (url.pathname === '/asset' || url.pathname === '/proxy');
    if (!isPublicRead) {
      const key = request.headers.get('X-API-Key');
      if (!key || key !== env.API_KEY) {
        return unauthorized(origin);
      }
    }

    const r2Key = url.searchParams.get('key');

    // ── PUT /asset ────────────────────────────────────────────────
    if (request.method === 'PUT' && url.pathname === '/asset') {
      if (!r2Key) return respond('Missing key', 400, {}, origin);
      const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
      await env.BUCKET.put(r2Key, request.body, {
        httpMetadata: { contentType },
      });
      const assetUrl = `${url.origin}/asset?key=${encodeURIComponent(r2Key)}`;
      return respond(JSON.stringify({ url: assetUrl }), 200,
        { 'Content-Type': 'application/json' }, origin);
    }

    // ── GET /asset ────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/asset') {
      if (!r2Key) return respond('Missing key', 400, {}, origin);
      const obj = await env.BUCKET.get(r2Key);
      if (!obj) return notFound(origin);
      const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
      return new Response(obj.body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...corsHeaders(origin),
        },
      });
    }

    // ── DELETE /asset ─────────────────────────────────────────────
    if (request.method === 'DELETE' && url.pathname === '/asset') {
      if (!r2Key) return respond('Missing key', 400, {}, origin);
      await env.BUCKET.delete(r2Key);
      return respond('OK', 200, {}, origin);
    }

    // ── GET /assets/list ──────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/assets/list') {
      const listed = await env.BUCKET.list({ prefix: 'assets/' });
      const items = listed.objects.map(o => ({
        key: o.key,
        size: o.size,
        url: `${url.origin}/asset?key=${encodeURIComponent(o.key)}`,
      }));
      return respond(JSON.stringify(items), 200,
        { 'Content-Type': 'application/json' }, origin);
    }

    // ── GET /kv ───────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/kv') {
      if (!r2Key) return respond('Missing key', 400, {}, origin);
      const obj = await env.BUCKET.get(`kv/${r2Key}`);
      if (!obj) return respond(JSON.stringify(null), 200,
        { 'Content-Type': 'application/json' }, origin);
      const value = await obj.text();
      return respond(JSON.stringify({ value }), 200,
        { 'Content-Type': 'application/json' }, origin);
    }

    // ── PUT /kv ───────────────────────────────────────────────────
    if (request.method === 'PUT' && url.pathname === '/kv') {
      if (!r2Key) return respond('Missing key', 400, {}, origin);
      const body = await request.text();
      await env.BUCKET.put(`kv/${r2Key}`, body, {
        httpMetadata: { contentType: 'application/json' },
      });
      return respond('OK', 200, {}, origin);
    }

    // ── GET /proxy ────────────────────────────────────────────────
    // Fetches an R2 asset by key (extracted from the asset URL) and returns it
    // with fresh CORS headers + Cache-Control: no-store.
    // This bypasses browser CORS-cache poisoning that occurs when the same URL
    // is first loaded via <img> (no-CORS) and then re-fetched by JS (needs CORS).
    // Content-Type is derived from the file extension (R2 metadata is unreliable).
    if (request.method === 'GET' && url.pathname === '/proxy') {
      const assetUrl = url.searchParams.get('url');
      if (!assetUrl) return respond('Missing url', 400, {}, origin);
      try {
        const parsed = new URL(assetUrl);
        const key = parsed.searchParams.get('key');
        if (!key) return respond('Missing key in url', 400, {}, origin);
        const obj = await env.BUCKET.get(key);
        if (!obj) return notFound(origin);
        // Derive content type from file extension — more reliable than R2 metadata
        const ext = key.split('.').pop().toLowerCase();
        const mimeByExt = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
        const contentType = mimeByExt[ext] || obj.httpMetadata?.contentType || 'application/octet-stream';
        return new Response(obj.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return respond('Proxy error: ' + e.message, 500, {}, origin);
      }
    }

    return notFound(origin);
  },
};
