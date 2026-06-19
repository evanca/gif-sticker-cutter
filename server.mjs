import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, extname, join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const port = 8140;
const runFile = promisify(execFile);
const python = process.env.PYTHON_BIN || 'python3';
const pythonArch = process.env.PYTHON_ARCH || '';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

const fetchHeaders = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  accept: 'image/gif,image/*;q=0.9,text/html;q=0.8,*/*;q=0.7',
};

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
  const upstream = await fetch(source, { headers: fetchHeaders });
  if (!upstream.ok) throw new Error(`GIF fetch failed: ${upstream.status}`);

  const contentType = upstream.headers.get('content-type') || '';
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (contentType.includes('image/')) {
    return { bytes, contentType: contentType || 'image/gif' };
  }

  const html = bytes.toString('utf8');
  const gifUrl = findGifUrl(html);
  if (!gifUrl) {
    throw new Error('That URL loaded a web page, but no GIF media URL was found. Try a direct .gif URL.');
  }

  const media = await fetch(gifUrl, { headers: fetchHeaders });
  if (!media.ok) throw new Error(`Resolved GIF fetch failed: ${media.status}`);
  return {
    bytes: Buffer.from(await media.arrayBuffer()),
    contentType: media.headers.get('content-type') || 'image/gif',
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function exportPath(path) {
  const filename = basename(String(path || ''));
  if (!filename) throw new Error('Missing export filename');
  return join(root, 'exports', filename);
}

async function runPython(script, args) {
  const command = pythonArch ? '/usr/bin/arch' : python;
  const commandArgs = pythonArch ? [`-${pythonArch}`, python, script, ...args] : [script, ...args];
  const result = await runFile(command, commandArgs, {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
  });
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/proxy') {
      const source = url.searchParams.get('url');
      if (!source) throw new Error('Missing URL');
      const gif = await fetchGif(source);
      response.writeHead(200, {
        'content-type': gif.contentType,
        'cache-control': 'no-store',
      });
      response.end(gif.bytes);
      return;
    }

    if (url.pathname === '/save-overlay' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const bytes = Buffer.from(body.png.replace(/^data:image\/png;base64,/, ''), 'base64');
      const exportDir = join(root, 'exports');
      await mkdir(exportDir, { recursive: true });
      const prefix = String(body.prefix || 'gif-sticker-outline').replace(/[^a-z0-9-_]/gi, '');
      const filename = `${prefix}-${Date.now()}.png`;
      await writeFile(join(exportDir, filename), bytes);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: `exports/${filename}` }));
      return;
    }

    if (url.pathname === '/cut' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.sourceUrl) throw new Error('Missing source GIF URL');
      if (!body.maskPath) throw new Error('Save a mask before cutting');

      const exportDir = join(root, 'exports');
      await mkdir(exportDir, { recursive: true });
      const stamp = Date.now();
      const sourcePath = join(exportDir, `source-${stamp}.gif`);
      const previewFramePath = join(exportDir, `source-frame-${stamp}.png`);
      const cutMaskPath = join(exportDir, `cut-mask-${stamp}.png`);
      const previewPath = join(exportDir, `preview-${stamp}.png`);
      const outputPath = join(exportDir, `cutout-${stamp}.gif`);
      const contactSheetPath = join(exportDir, `cutout-${stamp}-contact-sheet.png`);

      const gif = await fetchGif(body.sourceUrl);
      await writeFile(sourcePath, gif.bytes);

      await runPython(join(root, 'scripts/extract_gif_frame.py'), [
        sourcePath,
        previewFramePath,
        '--frame',
        '0',
      ]);
      const normalizeLog = await runPython(join(root, 'scripts/normalize_red_mask.py'), [
        '--overlay',
        exportPath(body.maskPath),
        '--output-cut-mask',
        cutMaskPath,
        '--output-preview',
        previewPath,
        '--preview-frame',
        previewFramePath,
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

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        output: `exports/${basename(outputPath)}`,
        preview: `exports/${basename(previewPath)}`,
        contactSheet: `exports/${basename(contactSheetPath)}`,
        cutMask: `exports/${basename(cutMaskPath)}`,
        logs: [normalizeLog, cutLog, verifyLog].filter(Boolean).join('\n'),
      }));
      return;
    }

    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = await readFile(join(root, path));
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    response.end(file);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error.message || error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`GIF Sticker Cutter: http://127.0.0.1:${port}`);
});
