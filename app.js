const gifUrl = document.querySelector('#gifUrl');
const gifFile = document.querySelector('#gifFile');
const loadButton = document.querySelector('#loadButton');
const connectEdgesButton = document.querySelector('#connectEdgesButton');
const clearButton = document.querySelector('#clearButton');
const undoButton = document.querySelector('#undoButton');
const markerButton = document.querySelector('#markerButton');
const eraserButton = document.querySelector('#eraserButton');
const roundedRectButton = document.querySelector('#roundedRectButton');
const ovalButton = document.querySelector('#ovalButton');
const saveAlignedButton = document.querySelector('#saveAlignedButton');
const cutButton = document.querySelector('#cutButton');
const sizeRange = document.querySelector('#sizeRange');
const stage = document.querySelector('#stage');
const gifImage = document.querySelector('#gifImage');
const canvas = document.querySelector('#drawCanvas');
const emptyState = document.querySelector('#emptyState');
const statusText = document.querySelector('#statusText');
const resultLinks = document.querySelector('#resultLinks');
const ctx = canvas.getContext('2d');

const MAX_GIF_BYTES = 25 * 1024 * 1024;
const MAX_FRAMES = 400;
const MAX_DIMENSION = 1200;
const MAX_PIXELS = 1200 * 1200;
const OUTLINE_PX = 5;
const RED_GROW_PX = 5;
const CLOSE_RADIUS_PX = 10;
const OPEN_RADIUS_PX = 5;
const SMOOTH_SIGMA = 7;
const SMOOTH_THRESHOLD = 0.5;
const PADDING = 24;
const TRANSPARENT_KEY = '#ff00ff';
const TRANSPARENT_HEX = 0xff00ff;
const GIF_WORKER = new URL('./vendor/gif.worker.js', document.baseURI).href;
const DRAW_TOOLS = new Map([
  ['marker', markerButton],
  ['eraser', eraserButton],
  ['rounded-rect', roundedRectButton],
  ['oval', ovalButton],
]);

let strokes = [];
let currentItem = null;
let drawing = false;
let loadingUrl = '';
let savedMaskCanvas = null;
let loadedGif = null;
let activeTool = 'marker';

function setStatus(message) {
  statusText.textContent = message;
}

function resetResult() {
  resultLinks.hidden = true;
  resultLinks.replaceChildren();
}

function resizeCanvas() {
  const rect = stage.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  redraw();
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function redraw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const item of strokes) drawItem(ctx, item);
  if (currentItem) drawItem(ctx, currentItem);
  ctx.globalCompositeOperation = 'source-over';
}

function selectTool(tool) {
  activeTool = tool;
  for (const [name, button] of DRAW_TOOLS) {
    button.classList.toggle('active', name === tool);
  }
  canvas.classList.toggle('eraser-active', tool === 'eraser');
}

function drawItem(targetCtx, item, options = {}) {
  if (item.type === 'stroke') {
    drawStroke(targetCtx, item, options);
  } else if (item.type === 'rounded-rect') {
    drawRoundedRect(targetCtx, item, options);
  } else if (item.type === 'oval') {
    drawOval(targetCtx, item, options);
  }
}

function applyDrawStyle(targetCtx, item, options = {}) {
  const scale = options.scale || 1;
  targetCtx.globalCompositeOperation = item.tool === 'eraser' ? 'destination-out' : 'source-over';
  targetCtx.strokeStyle = options.color || '#ff2424';
  targetCtx.lineWidth = Math.max(options.minLineWidth || 1, item.size * scale);
  targetCtx.lineCap = 'round';
  targetCtx.lineJoin = 'round';
}

function mappedPoint(point, options = {}) {
  if (!options.mapPoint) return point;
  return options.mapPoint(point);
}

function drawStroke(targetCtx, stroke, options = {}) {
  if (stroke.points.length < 2) return;
  applyDrawStyle(targetCtx, stroke, options);
  const first = mappedPoint(stroke.points[0], options);
  targetCtx.beginPath();
  targetCtx.moveTo(first.x, first.y);
  for (const point of stroke.points.slice(1)) {
    const mapped = mappedPoint(point, options);
    targetCtx.lineTo(mapped.x, mapped.y);
  }
  targetCtx.stroke();
  targetCtx.globalCompositeOperation = 'source-over';
}

function normalizedRect(item, options = {}) {
  const start = mappedPoint(item.start, options);
  const end = mappedPoint(item.end, options);
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function drawRoundedRect(targetCtx, item, options = {}) {
  const rect = normalizedRect(item, options);
  if (rect.width < 2 || rect.height < 2) return;
  applyDrawStyle(targetCtx, item, options);
  const minSide = Math.min(rect.width, rect.height);
  const radius = Math.min(minSide / 2, Math.max(minSide * 0.28, item.size * (options.scale || 1) * 2.5));
  targetCtx.beginPath();
  roundedRectPath(targetCtx, rect.left, rect.top, rect.width, rect.height, radius);
  targetCtx.stroke();
  targetCtx.globalCompositeOperation = 'source-over';
}

function roundedRectPath(targetCtx, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  targetCtx.moveTo(left + radius, top);
  targetCtx.lineTo(right - radius, top);
  targetCtx.quadraticCurveTo(right, top, right, top + radius);
  targetCtx.lineTo(right, bottom - radius);
  targetCtx.quadraticCurveTo(right, bottom, right - radius, bottom);
  targetCtx.lineTo(left + radius, bottom);
  targetCtx.quadraticCurveTo(left, bottom, left, bottom - radius);
  targetCtx.lineTo(left, top + radius);
  targetCtx.quadraticCurveTo(left, top, left + radius, top);
}

function drawOval(targetCtx, item, options = {}) {
  const rect = normalizedRect(item, options);
  if (rect.width < 2 || rect.height < 2) return;
  applyDrawStyle(targetCtx, item, options);
  targetCtx.beginPath();
  targetCtx.ellipse(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    rect.width / 2,
    rect.height / 2,
    0,
    0,
    Math.PI * 2,
  );
  targetCtx.stroke();
  targetCtx.globalCompositeOperation = 'source-over';
}

function startDrawing(event) {
  if (!loadedGif) return;
  drawing = true;
  const point = pointFromEvent(event);
  currentItem = {
    type: activeTool === 'rounded-rect' || activeTool === 'oval' ? activeTool : 'stroke',
    tool: activeTool === 'eraser' ? 'eraser' : 'marker',
    size: Number(sizeRange.value),
    points: [point],
    start: point,
    end: point,
  };
  redraw();
  event.preventDefault();
}

function continueDrawing(event) {
  if (!drawing || !currentItem) return;
  const point = pointFromEvent(event);
  if (currentItem.type === 'stroke') {
    currentItem.points.push(point);
  } else {
    currentItem.end = point;
  }
  redraw();
  event.preventDefault();
}

function stopDrawing() {
  if (!drawing || !currentItem) return;
  drawing = false;
  if (isDrawableItem(currentItem)) strokes.push(currentItem);
  currentItem = null;
  savedMaskCanvas = null;
  cutButton.disabled = true;
  resetResult();
  redraw();
  updateSummary();
}

function imageDisplayRect() {
  const stageRect = stage.getBoundingClientRect();
  const imageRect = gifImage.getBoundingClientRect();
  return {
    left: imageRect.left - stageRect.left,
    top: imageRect.top - stageRect.top,
    width: imageRect.width,
    height: imageRect.height,
  };
}

function firstDrawnPoint() {
  const stroke = strokes.find((item) => item.tool !== 'eraser' && item.points?.length > 0);
  return stroke ? stroke.points[0] : null;
}

function lastDrawnPoint() {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (stroke.tool !== 'eraser' && stroke.points?.length > 0) return stroke.points[stroke.points.length - 1];
  }
  return null;
}

function isDrawableItem(item) {
  if (item.type === 'stroke') return item.points.length > 1;
  if (item.type === 'rounded-rect' || item.type === 'oval') {
    return Math.abs(item.end.x - item.start.x) > 2 && Math.abs(item.end.y - item.start.y) > 2;
  }
  return false;
}

function nearestImageEdge(point, display) {
  const right = display.left + display.width;
  const bottom = display.top + display.height;
  const candidates = [
    { edge: 'top', distance: Math.abs(point.y - display.top), point: { x: Math.min(Math.max(point.x, display.left), right), y: display.top } },
    { edge: 'right', distance: Math.abs(point.x - right), point: { x: right, y: Math.min(Math.max(point.y, display.top), bottom) } },
    { edge: 'bottom', distance: Math.abs(point.y - bottom), point: { x: Math.min(Math.max(point.x, display.left), right), y: bottom } },
    { edge: 'left', distance: Math.abs(point.x - display.left), point: { x: display.left, y: Math.min(Math.max(point.y, display.top), bottom) } },
  ];
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0];
}

function edgePosition(edgePoint, display) {
  const right = display.left + display.width;
  const bottom = display.top + display.height;
  if (edgePoint.edge === 'top') return edgePoint.point.x - display.left;
  if (edgePoint.edge === 'right') return display.width + edgePoint.point.y - display.top;
  if (edgePoint.edge === 'bottom') return display.width + display.height + right - edgePoint.point.x;
  return display.width * 2 + display.height + bottom - edgePoint.point.y;
}

function pointAtEdgePosition(position, display) {
  const perimeter = 2 * (display.width + display.height);
  const wrapped = ((position % perimeter) + perimeter) % perimeter;
  const right = display.left + display.width;
  const bottom = display.top + display.height;
  if (wrapped <= display.width) return { x: display.left + wrapped, y: display.top };
  if (wrapped <= display.width + display.height) return { x: right, y: display.top + wrapped - display.width };
  if (wrapped <= display.width * 2 + display.height) return { x: right - (wrapped - display.width - display.height), y: bottom };
  return { x: display.left, y: bottom - (wrapped - display.width * 2 - display.height) };
}

function edgePathBetween(startEdge, endEdge, display) {
  const perimeter = 2 * (display.width + display.height);
  const start = edgePosition(startEdge, display);
  const end = edgePosition(endEdge, display);
  const clockwise = (end - start + perimeter) % perimeter;
  const counterClockwise = clockwise - perimeter;
  const step = Math.max(8, Number(sizeRange.value) / 2);
  const distance = clockwise <= perimeter - clockwise ? clockwise : counterClockwise;
  const pointCount = Math.max(1, Math.ceil(Math.abs(distance) / step));
  const points = [];
  for (let index = 0; index <= pointCount; index += 1) {
    points.push(pointAtEdgePosition(start + (distance * index) / pointCount, display));
  }
  return points;
}

function connectEdges() {
  if (!loadedGif) return;
  const first = firstDrawnPoint();
  const last = lastDrawnPoint();
  if (!first || !last) return;

  const display = imageDisplayRect();
  const firstEdge = nearestImageEdge(first, display);
  const lastEdge = nearestImageEdge(last, display);
  const edgePoints = edgePathBetween(lastEdge, firstEdge, display);
  strokes.push({
    type: 'stroke',
    tool: 'marker',
    size: Number(sizeRange.value),
    points: [last, lastEdge.point, ...edgePoints, firstEdge.point, first],
  });
  savedMaskCanvas = null;
  cutButton.disabled = true;
  redraw();
  updateSummary();
}

function openGifDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gif-sticker-cutter', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('gifs')) db.createObjectStore('gifs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('masks')) db.createObjectStore('masks', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeGifBlob(id, blob, source) {
  try {
    const db = await openGifDb();
    const tx = db.transaction('gifs', 'readwrite');
    tx.objectStore('gifs').put({ id, blob, source, savedAt: Date.now() });
    localStorage.setItem('gifStickerLastGifId', id);
    const recent = JSON.parse(localStorage.getItem('gifStickerRecentUrls') || '[]');
    if (source && source.url) {
      localStorage.setItem('gifStickerRecentUrls', JSON.stringify([source.url, ...recent.filter((url) => url !== source.url)].slice(0, 10)));
    }
  } catch {
    // IndexedDB is a cache convenience. The current in-memory GIF can still be processed.
  }
}

async function storeMaskCanvas(maskCanvas) {
  if (!loadedGif) return;
  try {
    const blob = await canvasBlob(maskCanvas, 'image/png');
    const id = `mask-${loadedGif.id}`;
    const db = await openGifDb();
    const tx = db.transaction('masks', 'readwrite');
    tx.objectStore('masks').put({
      id,
      gifId: loadedGif.id,
      blob,
      source: loadedGif.source,
      width: maskCanvas.width,
      height: maskCanvas.height,
      savedAt: Date.now(),
    });
    localStorage.setItem('gifStickerLastMaskId', id);
  } catch {
    // Mask persistence is best-effort; the in-memory mask remains usable.
  }
}

function giphyIdFromUrl(url) {
  const parsed = new URL(url);
  if (!/(^|\.)giphy\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] === 'media' && parts[1]) return parts[1];
  const last = parts[parts.length - 1] || '';
  const slugMatch = last.match(/([a-zA-Z0-9]+)$/);
  return slugMatch ? slugMatch[1] : null;
}

function mediaCandidatesForUrl(url) {
  const candidates = [url];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return candidates;
  }

  const giphyId = giphyIdFromUrl(url);
  if (giphyId) {
    candidates.push(`https://media.giphy.com/media/${giphyId}/giphy.gif`);
    candidates.push(`https://i.giphy.com/media/${giphyId}/giphy.gif`);
  }

  if (/^media\d*\.tenor\.com$/i.test(parsed.hostname)) {
    const canonicalGifPath = parsed.pathname
      .replace(/^\/m\//, '/')
      .replace(/\.(png|jpg|jpeg|webp)$/i, '.gif');
    candidates.push(`https://media.tenor.com${canonicalGifPath}`);
    if (canonicalGifPath.includes('AAAAd/')) {
      candidates.push(`https://media.tenor.com${canonicalGifPath.replace('AAAAd/', 'AAAAC/')}`);
    }
    if (canonicalGifPath.includes('AAAAC/')) {
      candidates.push(`https://media.tenor.com${canonicalGifPath.replace('AAAAC/', 'AAAAd/')}`);
    }
  } else if (/(^|\.)tenor\.com$/i.test(parsed.hostname)) {
    candidates.push(`https://tenor.com/oembed?url=${encodeURIComponent(url)}`);
  }

  if (/(^|\.)giphy\.com$/i.test(parsed.hostname)) {
    candidates.push(`https://giphy.com/services/oembed?url=${encodeURIComponent(url)}`);
  }

  return [...new Set(candidates)];
}

function extractGifUrlsFromText(text) {
  return [...new Set([
    ...text.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+?\.gif(?:\?[^"'<>\\\s]*)?/gi),
  ].map((match) => match[0].replace(/\\\//g, '/').replace(/&amp;/g, '&')))];
}

async function fetchGifBytes(candidate, visited = new Set()) {
  if (visited.has(candidate)) throw new Error('Repeated URL resolution');
  visited.add(candidate);

  const response = await fetch(candidate, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_GIF_BYTES) throw new Error('GIF is too large');

  const signature = new TextDecoder('ascii').decode(buffer.slice(0, 6));
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return { buffer, resolvedUrl: response.url, contentType: contentType || 'image/gif' };
  }

  const text = new TextDecoder().decode(buffer);
  const urls = contentType.includes('json')
    ? extractGifUrlsFromText(JSON.stringify(JSON.parse(text)))
    : extractGifUrlsFromText(text);
  for (const url of urls) {
    try {
      return await fetchGifBytes(url, visited);
    } catch {
      // Try the next media candidate from provider metadata.
    }
  }
  throw new Error('No CORS-readable GIF media URL was found');
}

async function fetchGifFromUrl(url) {
  const errors = [];
  for (const candidate of mediaCandidatesForUrl(url)) {
    try {
      return await fetchGifBytes(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message || error}`);
    }
  }
  throw new Error(`Could not import that URL in the browser. Giphy page/media URLs and direct Tenor media URLs usually work; for Tenor pages use "copy GIF address" or Upload. ${errors[0] || ''}`);
}

function validateGif(frames, width, height) {
  if (!frames.length) throw new Error('GIF has no frames');
  if (frames.length > MAX_FRAMES) throw new Error(`GIF has too many frames (${frames.length}/${MAX_FRAMES})`);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error(`GIF is too large (${width}x${height})`);
  if (width * height > MAX_PIXELS) throw new Error(`GIF pixel area is too large (${width * height})`);
}

function decodeGif(buffer) {
  if (!window.GifReader) {
    throw new Error('GIF decoder did not load. Check the network connection and reload.');
  }
  const reader = new window.GifReader(new Uint8Array(buffer));
  const width = reader.width;
  const height = reader.height;
  const frameCount = reader.numFrames();
  validateGif(new Array(frameCount), width, height);
  const frames = [];
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < frameCount; index += 1) {
    const info = reader.frameInfo(index);
    const restorePixels = info.disposal === 3 ? new Uint8ClampedArray(pixels) : null;
    reader.decodeAndBlitFrameRGBA(index, pixels);
    frames.push({
      pixels: new Uint8ClampedArray(pixels),
      delay: Math.max(20, (info.delay || 10) * 10),
    });
    if (info.disposal === 2) {
      clearFrameRect(pixels, width, info);
    } else if (restorePixels) {
      pixels.set(restorePixels);
    }
  }
  return {
    width,
    height,
    frames,
  };
}

function clearFrameRect(pixels, width, frameInfo) {
  const left = frameInfo.x;
  const top = frameInfo.y;
  const right = left + frameInfo.width;
  const bottom = top + frameInfo.height;
  for (let y = top; y < bottom; y += 1) {
    pixels.fill(0, (y * width + left) * 4, (y * width + right) * 4);
  }
}

function imageDataUrlFromPixels(width, height, pixels) {
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  output.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return output.toDataURL('image/png');
}

async function loadDecodedGif(buffer, source) {
  const decoded = decodeGif(buffer);
  const blob = new Blob([buffer], { type: 'image/gif' });
  const id = `gif-${Date.now()}`;
  await storeGifBlob(id, blob, source);
  if (loadedGif?.objectUrl) URL.revokeObjectURL(loadedGif.objectUrl);

  loadedGif = {
    ...decoded,
    id,
    source,
    buffer,
    objectUrl: URL.createObjectURL(blob),
  };

  gifImage.src = loadedGif.objectUrl;
  gifImage.style.display = 'block';
  emptyState.style.display = 'none';
  strokes = [];
  currentItem = null;
  savedMaskCanvas = null;
  cutButton.disabled = true;
  saveAlignedButton.textContent = 'Save image-aligned mask';
  resetResult();
  setStatus(`Loaded ${decoded.width}x${decoded.height}, ${decoded.frames.length} frame(s). Draw the outline.`);
}

async function loadGif() {
  const url = gifUrl.value.trim();
  if (!url) return;
  loadingUrl = url;
  setStatus('Importing GIF in the browser...');
  try {
    const result = await fetchGifFromUrl(url);
    await loadDecodedGif(result.buffer, { type: 'url', url, resolvedUrl: result.resolvedUrl });
  } catch (error) {
    gifImage.style.display = 'none';
    emptyState.style.display = 'grid';
    emptyState.textContent = 'URL import failed. Giphy URLs and direct Tenor media URLs are supported when CORS allows it; upload a GIF file as fallback.';
    setStatus(`URL import failed for ${loadingUrl}: ${error.message || error}`);
  }
}

async function loadLocalFile(file) {
  if (!file) return;
  if (file.size > MAX_GIF_BYTES) {
    setStatus(`GIF is too large (${Math.round(file.size / 1024 / 1024)} MB).`);
    return;
  }
  setStatus('Reading local GIF...');
  try {
    await loadDecodedGif(await file.arrayBuffer(), { type: 'file', name: file.name });
    gifUrl.value = '';
  } catch (error) {
    setStatus(`Upload failed: ${error.message || error}`);
  }
}

function showLoadedGif() {
  if (!loadedGif) return;
  emptyState.textContent = 'Load a GIF URL or upload a GIF, then draw the desired sticker outline in red.';
  gifImage.style.display = 'block';
  emptyState.style.display = 'none';
  resizeCanvas();
}

const diskCache = new Map();

function diskOffsets(radius) {
  if (diskCache.has(radius)) return diskCache.get(radius);
  const offsets = [];
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= radius * radius) offsets.push([x, y]);
    }
  }
  diskCache.set(radius, offsets);
  return offsets;
}

function dilateBinary(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  const offsets = diskOffsets(radius);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = y * width + x;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (mask[ny * width + nx]) {
          output[target] = 1;
          break;
        }
      }
    }
  }
  return output;
}

function erodeBinary(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  const offsets = diskOffsets(radius);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = y * width + x;
      let keep = 1;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
          keep = 0;
          break;
        }
      }
      output[target] = keep;
    }
  }
  return output;
}

function closeBinary(mask, width, height, radius) {
  return erodeBinary(dilateBinary(mask, width, height, radius), width, height, radius);
}

function openBinary(mask, width, height, radius) {
  return dilateBinary(erodeBinary(mask, width, height, radius), width, height, radius);
}

function gaussianKernel(sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let total = 0;
  for (let x = -radius; x <= radius; x += 1) {
    const value = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel.push(value);
    total += value;
  }
  return kernel.map((value) => value / total);
}

function gaussianBlur(mask, width, height, sigma) {
  const kernel = gaussianKernel(sigma);
  const radius = Math.floor(kernel.length / 2);
  const horizontal = new Float32Array(mask.length);
  const output = new Float32Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const nx = Math.min(width - 1, Math.max(0, x + k));
        value += mask[y * width + nx] * kernel[k + radius];
      }
      horizontal[y * width + x] = value;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const ny = Math.min(height - 1, Math.max(0, y + k));
        value += horizontal[ny * width + x] * kernel[k + radius];
      }
      output[y * width + x] = value;
    }
  }

  return output;
}

function fillHoles(mask, width, height) {
  const outside = floodOutside(mask, width, height);
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    output[index] = mask[index] || !outside[index] ? 1 : 0;
  }
  return output;
}

function floodOutside(blocked, width, height) {
  const outside = new Uint8Array(width * height);
  const queue = [];
  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (outside[index] || blocked[index]) return;
    outside[index] = 1;
    queue.push(index);
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
  return outside;
}

function buildMaskCanvas() {
  if (!loadedGif) throw new Error('Load a GIF first');
  if (!strokes.some((item) => item.tool !== 'eraser' && isDrawableItem(item))) throw new Error('Draw a closed outline first');

  const display = imageDisplayRect();
  const boundary = document.createElement('canvas');
  boundary.width = loadedGif.width;
  boundary.height = loadedGif.height;
  const boundaryCtx = boundary.getContext('2d');
  const scaleX = boundary.width / display.width;
  const scaleY = boundary.height / display.height;

  const drawOptions = {
    color: '#fff',
    scale: (scaleX + scaleY) / 2,
    minLineWidth: 3,
    mapPoint: (point) => ({
      x: (point.x - display.left) * scaleX,
      y: (point.y - display.top) * scaleY,
    }),
  };
  for (const item of strokes) {
    if (!isDrawableItem(item)) continue;
    drawItem(boundaryCtx, item, drawOptions);
  }
  boundaryCtx.globalCompositeOperation = 'source-over';

  const width = boundary.width;
  const height = boundary.height;
  const boundaryData = boundaryCtx.getImageData(0, 0, width, height).data;
  const blocked = new Uint8Array(width * height);
  for (let index = 0; index < blocked.length; index += 1) {
    blocked[index] = boundaryData[index * 4 + 3] > 0 ? 1 : 0;
  }

  const outside = floodOutside(dilateBinary(blocked, width, height, 1), width, height);
  const filled = new Uint8Array(width * height);
  for (let index = 0; index < filled.length; index += 1) {
    filled[index] = outside[index] ? 0 : 1;
  }

  const redExclusion = dilateBinary(blocked, width, height, RED_GROW_PX);
  const inner = new Uint8Array(width * height);
  for (let index = 0; index < inner.length; index += 1) {
    inner[index] = filled[index] && !redExclusion[index] ? 1 : 0;
  }

  const smoothed = openBinary(closeBinary(inner, width, height, CLOSE_RADIUS_PX), width, height, OPEN_RADIUS_PX);
  const soft = gaussianBlur(smoothed, width, height, SMOOTH_SIGMA);
  const innerLimit = dilateBinary(inner, width, height, 3);
  const allowed = new Uint8Array(width * height);
  for (let index = 0; index < allowed.length; index += 1) {
    allowed[index] = soft[index] >= SMOOTH_THRESHOLD && innerLimit[index] ? 1 : 0;
  }
  const cutMask = erodeBinary(fillHoles(allowed, width, height), width, height, OUTLINE_PX);

  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outputCtx = output.getContext('2d');
  const maskImage = outputCtx.createImageData(width, height);
  for (let index = 0; index < cutMask.length; index += 1) {
    const alpha = cutMask[index] ? 255 : 0;
    const target = index * 4;
    maskImage.data[target] = 255;
    maskImage.data[target + 1] = 255;
    maskImage.data[target + 2] = 255;
    maskImage.data[target + 3] = alpha;
  }
  outputCtx.putImageData(maskImage, 0, 0);

  return output;
}

async function saveImageAlignedMask() {
  try {
    savedMaskCanvas = buildMaskCanvas();
    await storeMaskCanvas(savedMaskCanvas);
    cutButton.disabled = false;
    saveAlignedButton.textContent = 'Mask saved locally';
    setStatus('Mask saved in the browser. Ready to cut.');
  } catch (error) {
    setStatus(`Mask save failed: ${error.message || error}`);
  }
}

function dilateMask(mask, width, height, radius) {
  const output = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let dy = -radius; dy <= radius && !value; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (mask[ny * width + nx]) {
            value = 255;
            break;
          }
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function alphaMaskFromCanvas(maskCanvas) {
  const data = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  const mask = new Uint8ClampedArray(maskCanvas.width * maskCanvas.height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = data[index * 4 + 3] > 0 ? 255 : 0;
  }
  return mask;
}

function frameCanvas(frame, mask, outline, width, height) {
  const canvasFrame = document.createElement('canvas');
  canvasFrame.width = width + PADDING * 2;
  canvasFrame.height = height + PADDING * 2;
  const frameCtx = canvasFrame.getContext('2d');

  const imageData = frameCtx.createImageData(canvasFrame.width, canvasFrame.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255;
    data[index + 1] = 0;
    data[index + 2] = 255;
    data[index + 3] = 255;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = y * width + x;
      const source = sourceIndex * 4;
      const target = ((y + PADDING) * canvasFrame.width + x + PADDING) * 4;
      if (outline[sourceIndex]) {
        data[target] = 255;
        data[target + 1] = 255;
        data[target + 2] = 255;
        data[target + 3] = 255;
      } else {
        data[target] = 255;
        data[target + 1] = 0;
        data[target + 2] = 255;
        data[target + 3] = 255;
      }
      if (mask[sourceIndex] && frame.pixels[source + 3] > 16) {
        data[target] = frame.pixels[source];
        data[target + 1] = frame.pixels[source + 1];
        data[target + 2] = frame.pixels[source + 2];
        data[target + 3] = frame.pixels[source + 3];
      }
    }
  }
  frameCtx.putImageData(imageData, 0, 0);
  return canvasFrame;
}

function makeContactSheet(canvases) {
  const columns = Math.min(4, canvases.length);
  const thumb = 180;
  const rows = Math.ceil(canvases.length / columns);
  const sheet = document.createElement('canvas');
  sheet.width = columns * (thumb + 20);
  sheet.height = rows * (thumb + 42);
  const sheetCtx = sheet.getContext('2d');
  sheetCtx.fillStyle = '#fff';
  sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
  sheetCtx.fillStyle = '#111';
  sheetCtx.font = '14px monospace';
  canvases.forEach((frame, index) => {
    const scale = Math.min(thumb / frame.width, thumb / frame.height);
    const width = Math.round(frame.width * scale);
    const height = Math.round(frame.height * scale);
    const x = (index % columns) * (thumb + 20) + 10;
    const y = Math.floor(index / columns) * (thumb + 42) + 10;
    sheetCtx.drawImage(frame, x, y, width, height);
    sheetCtx.fillText(`frame ${index}`, x, y + thumb + 22);
  });
  return sheet;
}

function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

function encodeGif(canvases, delays) {
  if (!window.GIF) throw new Error('GIF encoder did not load. Check the network connection and reload.');
  return new Promise((resolve, reject) => {
    const gif = new window.GIF({
      workers: 2,
      quality: 10,
      repeat: 0,
      transparent: TRANSPARENT_HEX,
      workerScript: GIF_WORKER,
      width: canvases[0].width,
      height: canvases[0].height,
    });
    canvases.forEach((frame, index) => gif.addFrame(frame, { copy: true, delay: delays[index] || 100 }));
    gif.on('finished', resolve);
    gif.on('abort', () => reject(new Error('GIF encoding aborted')));
    gif.render();
  });
}

function downloadLink(label, url, download) {
  const link = document.createElement('a');
  link.href = url;
  link.textContent = label;
  if (download) {
    link.download = download;
    link.className = 'download-link';
  } else {
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
  return link;
}

async function cutGif() {
  if (!loadedGif || !savedMaskCanvas) return;
  cutButton.disabled = true;
  saveAlignedButton.disabled = true;
  resetResult();
  setStatus('Cutting and encoding in the browser...');

  try {
    const mask = alphaMaskFromCanvas(savedMaskCanvas);
    const outline = dilateMask(mask, loadedGif.width, loadedGif.height, OUTLINE_PX);
    const outputFrames = loadedGif.frames.map((frame) => frameCanvas(frame, mask, outline, loadedGif.width, loadedGif.height));
    const delays = loadedGif.frames.map((frame) => frame.delay);
    const gifBlob = await encodeGif(outputFrames, delays);
    const previewBlob = await canvasBlob(outputFrames[0], 'image/png');
    const contactBlob = await canvasBlob(makeContactSheet(outputFrames), 'image/png');

    const stamp = Date.now();
    resultLinks.append(
      downloadLink('Download GIF', URL.createObjectURL(gifBlob), `sticker-${stamp}.gif`),
      downloadLink('Preview', URL.createObjectURL(previewBlob)),
      downloadLink('Contact sheet', URL.createObjectURL(contactBlob)),
    );
    resultLinks.hidden = false;
    setStatus('Cut complete. Exported fully in the browser.');
  } catch (error) {
    cutButton.disabled = false;
    setStatus(`Cut failed: ${error.message || error}`);
  } finally {
    saveAlignedButton.disabled = false;
  }
}

function updateSummary() {
  const source = loadedGif ? `${loadedGif.frames.length} frame(s)` : 'No GIF loaded';
  const drawn = strokes.filter((item) => item.tool !== 'eraser').length;
  const erased = strokes.filter((item) => item.tool === 'eraser').length;
  setStatus(`${source}. ${drawn} outline item(s), ${erased} eraser stroke(s).`);
}

loadButton.addEventListener('click', loadGif);
gifFile.addEventListener('change', () => loadLocalFile(gifFile.files[0]));
markerButton.addEventListener('click', () => selectTool('marker'));
eraserButton.addEventListener('click', () => selectTool('eraser'));
roundedRectButton.addEventListener('click', () => selectTool('rounded-rect'));
ovalButton.addEventListener('click', () => selectTool('oval'));
connectEdgesButton.addEventListener('click', connectEdges);
cutButton.addEventListener('click', cutGif);
saveAlignedButton.addEventListener('click', saveImageAlignedMask);
clearButton.addEventListener('click', () => {
  strokes = [];
  currentItem = null;
  savedMaskCanvas = null;
  cutButton.disabled = true;
  resetResult();
  redraw();
  updateSummary();
});
undoButton.addEventListener('click', () => {
  strokes.pop();
  savedMaskCanvas = null;
  cutButton.disabled = true;
  redraw();
  updateSummary();
});
gifImage.addEventListener('load', showLoadedGif);
canvas.addEventListener('pointerdown', startDrawing);
canvas.addEventListener('pointermove', continueDrawing);
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointerleave', stopDrawing);
window.addEventListener('resize', resizeCanvas);
selectTool('marker');

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get('url');
if (initialUrl) {
  gifUrl.value = initialUrl;
  loadGif();
}

resizeCanvas();
