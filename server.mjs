import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, extname, join, resolve, sep } from 'node:path';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const root = new URL('.', import.meta.url).pathname;
const exportDir = join(root, 'exports');
const port = Number(process.env.PORT || 8140);
const host = process.env.HOST || '127.0.0.1';
const runFile = promisify(execFile);
const python = process.env.PYTHON_BIN || 'python3';
const pythonArch = process.env.PYTHON_ARCH || '';
const trustProxy = process.env.TRUST_PROXY === '1';

const limits = {
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024),
  maxGifBytes: Number(process.env.MAX_GIF_BYTES || 25 * 1024 * 1024),
  maxHtmlBytes: Number(process.env.MAX_HTML_BYTES || 2 * 1024 * 1024),
  maxMaskBytes: Number(process.env.MAX_MASK_BYTES || 4 * 1024 * 1024),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 12000),
  processTimeoutMs: Number(process.env.PROCESS_TIMEOUT_MS || 45000),
  maxRedirects: Number(process.env.MAX_REDIRECTS || 3),
  maxFrames: Number(process.env.MAX_GIF_FRAMES || 160),
  maxDimension: Number(process.env.MAX_GIF_DIMENSION || 1200),
  maxPixels: Number(process.env.MAX_GIF_PIXELS || 1200 * 1200),
  cleanupMaxAgeMs: Number(process.env.EXPORT_MAX_AGE_MS || 60 * 60 * 1000),
  rateWindowMs: Number(process.env.RATE_WINDOW_MS || 60 * 1000),
  rateMax: Number(process.env.RATE_MAX || 30),
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

const fetchHeaders = {
  'user-agent': 'GIF-Sticker-Cutter/1.0',
  accept: 'image/gif,image/*;q=0.9,text/html;q=0.8,*/*;q=0.7',
};

const localOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...localOrigins, ...configuredOrigins]);
const rateBuckets = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isApiRoute(pathname) {
  return pathname === '/proxy' || pathname === '/save-overlay' || pathname === '/cut' || pathname === '/health';
}

function clientIp(request) {
  if (trustProxy) {
    return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
  }
  return request.socket.remoteAddress || 'unknown';
}

function checkRateLimit(request) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter((time) => now - time < limits.rateWindowMs);
  if (recent.length >= limits.rateMax) throw new HttpError(429, 'Rate limit exceeded');
  recent.push(now);
  rateBuckets.set(ip, recent);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (!allowedOrigins.has(origin)) throw new HttpError(403, 'Origin is not allowed');
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function writeResponse(response, status, headers, body = '') {
  response.writeHead(status, headers);
  response.end(body);
}

function publicHeaders(request, extra = {}) {
  return {
    ...corsHeaders(request),
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function errorHeaders(request, extra = {}) {
  const headers = { 'x-content-type-options': 'nosniff', ...extra };
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    return { ...corsHeaders(request), ...headers };
  }
  return headers;
}

function isInsidePath(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`);
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4) return isPrivateIPv4(mappedIpv4[1]);
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') ||
      normalized.startsWith('ff')
    );
  }
  return true;
}

async function assertPublicUrl(source) {
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Only http(s) URLs are allowed');
  if (parsed.username || parsed.password) throw new HttpError(400, 'Credentialed URLs are not allowed');

  const hostIp = net.isIP(parsed.hostname);
  if (hostIp && isBlockedIp(parsed.hostname)) throw new HttpError(400, 'Private network URLs are not allowed');
  if (!hostIp) {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address))) {
      throw new HttpError(400, 'Private network URLs are not allowed');
    }
  }
  return parsed;
}

async function fetchWithGuards(source, maxBytes, redirects = limits.maxRedirects) {
  const parsed = await assertPublicUrl(source);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
  try {
    const upstream = await fetch(parsed, {
      headers: fetchHeaders,
      redirect: 'manual',
      signal: controller.signal,
    });
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      if (redirects <= 0) throw new HttpError(400, 'Too many redirects');
      const location = upstream.headers.get('location');
      if (!location) throw new HttpError(400, 'Redirect missing location');
      return fetchWithGuards(new URL(location, parsed).toString(), maxBytes, redirects - 1);
    }
    if (!upstream.ok) throw new HttpError(502, `GIF fetch failed: ${upstream.status}`);
    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) throw new HttpError(413, 'Remote file is too large');
    return {
      bytes: await readResponseBytes(upstream, maxBytes),
      contentType: upstream.headers.get('content-type') || '',
      finalUrl: parsed.toString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBytes(upstream, maxBytes) {
  if (!upstream.body) return Buffer.from(await upstream.arrayBuffer());
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Remote file is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  const value = match ? match[1] || match[0] : null;
  return value ? value.replace(/\\u002F/g, '/').replace(/&amp;/g, '&') : null;
}

function findGifUrl(html) {
  return (
    firstMatch(html, /https?:\\?\/\\?\/media\d*\.tenor\.com\\?\/[^"'<>\\\s]+?\.gif[^"'<>\\\s]*/i) ||
    firstMatch(html, /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
    firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)
  );
}

async function fetchGif(source) {
  const upstream = await fetchWithGuards(source, limits.maxGifBytes);
  if (upstream.contentType.includes('image/')) {
    return { bytes: upstream.bytes, contentType: upstream.contentType || 'image/gif' };
  }

  const html = upstream.bytes.toString('utf8');
  if (upstream.bytes.length > limits.maxHtmlBytes) throw new HttpError(413, 'Remote page is too large');
  const gifUrl = findGifUrl(html);
  if (!gifUrl) throw new HttpError(400, 'That URL loaded a web page, but no GIF media URL was found. Try a direct .gif URL.');
  const media = await fetchWithGuards(gifUrl, limits.maxGifBytes);
  if (!media.contentType.includes('image/') && !gifUrl.toLowerCase().includes('.gif')) {
    throw new HttpError(400, 'Resolved URL is not an image');
  }
  return { bytes: media.bytes, contentType: media.contentType || 'image/gif' };
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limits.maxBodyBytes) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function safeExportPath(path) {
  const filename = basename(String(path || ''));
  if (!/^[a-z0-9_.-]+\.(png|gif)$/i.test(filename)) throw new HttpError(400, 'Invalid export filename');
  const resolved = resolve(exportDir, filename);
  if (!isInsidePath(exportDir, resolved)) throw new HttpError(400, 'Invalid export path');
  return resolved;
}

async function runPython(script, args) {
  const command = pythonArch ? '/usr/bin/arch' : python;
  const commandArgs = pythonArch ? [`-${pythonArch}`, python, script, ...args] : [script, ...args];
  const result = await runFile(command, commandArgs, {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
    timeout: limits.processTimeoutMs,
  });
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

async function cleanupExports() {
  await mkdir(exportDir, { recursive: true });
  const now = Date.now();
  const entries = await readdir(exportDir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || entry.name === '.gitkeep') return;
    const path = join(exportDir, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs > limits.cleanupMaxAgeMs) await unlink(path);
  }));
}

async function validateGif(path) {
  const output = await runPython(join(root, 'scripts/inspect_gif.py'), [
    path,
    '--max-frames', String(limits.maxFrames),
    '--max-dimension', String(limits.maxDimension),
    '--max-pixels', String(limits.maxPixels),
  ]);
  return output;
}

function json(response, request, status, payload) {
  writeResponse(response, status, publicHeaders(request, { 'content-type': 'application/json' }), JSON.stringify(payload));
}

await mkdir(exportDir, { recursive: true });
setInterval(() => cleanupExports().catch(() => {}), Math.min(limits.cleanupMaxAgeMs, 10 * 60 * 1000));

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'OPTIONS' && isApiRoute(url.pathname)) {
      writeResponse(response, 204, publicHeaders(request));
      return;
    }
    if (isApiRoute(url.pathname)) checkRateLimit(request);

    if (url.pathname === '/health') {
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      json(response, request, 200, { ok: true });
      return;
    }

    if (url.pathname === '/proxy') {
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const source = url.searchParams.get('url');
      if (!source) throw new HttpError(400, 'Missing URL');
      const gif = await fetchGif(source);
      writeResponse(response, 200, publicHeaders(request, {
        'content-type': gif.contentType,
        'cache-control': 'no-store',
      }), gif.bytes);
      return;
    }

    if (url.pathname === '/save-overlay' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const png = String(body.png || '');
      if (!png.startsWith('data:image/png;base64,')) throw new HttpError(400, 'Expected PNG data URL');
      const bytes = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
      if (bytes.length > limits.maxMaskBytes) throw new HttpError(413, 'Mask image is too large');
      await cleanupExports();
      const prefix = String(body.prefix || 'gif-sticker-outline').replace(/[^a-z0-9-_]/gi, '');
      const filename = `${prefix}-${Date.now()}.png`;
      await writeFile(join(exportDir, filename), bytes);
      json(response, request, 200, { path: `exports/${filename}` });
      return;
    }

    if (url.pathname === '/cut' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.sourceUrl) throw new HttpError(400, 'Missing source GIF URL');
      if (!body.maskPath) throw new HttpError(400, 'Save a mask before cutting');

      await cleanupExports();
      const stamp = Date.now();
      const sourcePath = join(exportDir, `source-${stamp}.gif`);
      const previewFramePath = join(exportDir, `source-frame-${stamp}.png`);
      const cutMaskPath = join(exportDir, `cut-mask-${stamp}.png`);
      const previewPath = join(exportDir, `preview-${stamp}.png`);
      const outputPath = join(exportDir, `cutout-${stamp}.gif`);
      const contactSheetPath = join(exportDir, `cutout-${stamp}-contact-sheet.png`);

      const gif = await fetchGif(body.sourceUrl);
      await writeFile(sourcePath, gif.bytes);
      const inspectLog = await validateGif(sourcePath);

      await runPython(join(root, 'scripts/extract_gif_frame.py'), [sourcePath, previewFramePath, '--frame', '0']);
      const normalizeLog = await runPython(join(root, 'scripts/normalize_red_mask.py'), [
        '--overlay', safeExportPath(body.maskPath),
        '--output-cut-mask', cutMaskPath,
        '--output-preview', previewPath,
        '--preview-frame', previewFramePath,
      ]);
      const cutLog = await runPython(join(root, 'scripts/make_gif_cutout.py'), [
        sourcePath,
        outputPath,
        '--cut-mask',
        cutMaskPath,
        '--padding',
        '24',
      ]);
      const verifyLog = await runPython(join(root, 'scripts/verify_gif_cutout.py'), [
        outputPath,
        '--background',
        '#dfff00',
        '--contact-sheet',
        contactSheetPath,
      ]);

      json(response, request, 200, {
        output: `exports/${basename(outputPath)}`,
        preview: `exports/${basename(previewPath)}`,
        contactSheet: `exports/${basename(contactSheetPath)}`,
        cutMask: `exports/${basename(cutMaskPath)}`,
        logs: [inspectLog, normalizeLog, cutLog, verifyLog].filter(Boolean).join('\n'),
      });
      return;
    }

    if (isApiRoute(url.pathname)) throw new HttpError(405, 'Method not allowed');

    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = resolve(root, path);
    if (!isInsidePath(root, filePath)) throw new HttpError(404, 'Not found');
    const file = await readFile(filePath);
    const headers = {
      'content-type': types[extname(filePath)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; script-src 'self'; worker-src 'self' blob:; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    };
    writeResponse(response, 200, headers, file);
  } catch (error) {
    const status = error.status || 500;
    writeResponse(response, status, errorHeaders(request, { 'content-type': 'text/plain; charset=utf-8' }), String(error.message || error));
  }
});

server.listen(port, host, () => {
  console.log(`GIF Sticker Cutter: http://${host}:${port}`);
});
