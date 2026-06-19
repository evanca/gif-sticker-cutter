const gifUrl = document.querySelector('#gifUrl');
const gifFile = document.querySelector('#gifFile');
const loadButton = document.querySelector('#loadButton');
const connectEdgesButton = document.querySelector('#connectEdgesButton');
const clearButton = document.querySelector('#clearButton');
const undoButton = document.querySelector('#undoButton');
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
const MAX_FRAMES = 160;
const MAX_DIMENSION = 1200;
const MAX_PIXELS = 1200 * 1200;
const OUTLINE_PX = 5;
const PADDING = 24;
const TRANSPARENT_KEY = '#ff00ff';
const TRANSPARENT_HEX = 0xff00ff;
const GIF_WORKER = './vendor/gif.worker.js';

let strokes = [];
let currentStroke = null;
let drawing = false;
let loadingUrl = '';
let savedMaskCanvas = null;
let loadedGif = null;

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
  for (const stroke of strokes) drawStroke(stroke);
  if (currentStroke) drawStroke(currentStroke);
}

function drawStroke(stroke) {
  if (stroke.points.length < 2) return;
  ctx.strokeStyle = '#ff2424';
  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}

function startDrawing(event) {
  if (!loadedGif) return;
  drawing = true;
  currentStroke = {
    size: Number(sizeRange.value),
    points: [pointFromEvent(event)],
  };
  event.preventDefault();
}

function continueDrawing(event) {
  if (!drawing || !currentStroke) return;
  currentStroke.points.push(pointFromEvent(event));
  redraw();
  event.preventDefault();
}

function stopDrawing() {
  if (!drawing || !currentStroke) return;
  drawing = false;
  strokes.push(currentStroke);
  currentStroke = null;
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
  const stroke = strokes.find((item) => item.points.length > 0);
  return stroke ? stroke.points[0] : null;
}

function lastDrawnPoint() {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (stroke.points.length > 0) return stroke.points[stroke.points.length - 1];
  }
  return null;
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

  if (/(^|\.)tenor\.com$/i.test(parsed.hostname)) {
    candidates.push(`https://tenor.com/oembed?url=${encodeURIComponent(url)}`);
  }

  if (/^media\d*\.tenor\.com$/i.test(parsed.hostname) && !parsed.pathname.toLowerCase().endsWith('.gif')) {
    const gifPath = parsed.pathname
      .replace(/AAAA(?:AN|AM|AP|Ad|AS|AC)\//, 'AAAAAC/')
      .replace(/\.(png|jpg|jpeg|webp)$/i, '.gif');
    candidates.push(`${parsed.origin}${gifPath}`);
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
  for (let index = 0; index < frameCount; index += 1) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    const info = reader.frameInfo(index);
    reader.decodeAndBlitFrameRGBA(index, pixels);
    frames.push({
      pixels,
      delay: Math.max(20, (info.delay || 10) * 10),
    });
  }
  return {
    width,
    height,
    frames,
  };
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
  currentStroke = null;
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

function buildMaskCanvas() {
  if (!loadedGif) throw new Error('Load a GIF first');
  if (!strokes.some((stroke) => stroke.points.length > 1)) throw new Error('Draw a closed outline first');

  const display = imageDisplayRect();
  const boundary = document.createElement('canvas');
  boundary.width = loadedGif.width;
  boundary.height = loadedGif.height;
  const boundaryCtx = boundary.getContext('2d');
  const scaleX = boundary.width / display.width;
  const scaleY = boundary.height / display.height;

  boundaryCtx.strokeStyle = '#fff';
  boundaryCtx.lineCap = 'round';
  boundaryCtx.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    boundaryCtx.lineWidth = Math.max(3, stroke.size * ((scaleX + scaleY) / 2));
    boundaryCtx.beginPath();
    boundaryCtx.moveTo(
      (stroke.points[0].x - display.left) * scaleX,
      (stroke.points[0].y - display.top) * scaleY,
    );
    for (const point of stroke.points.slice(1)) {
      boundaryCtx.lineTo(
        (point.x - display.left) * scaleX,
        (point.y - display.top) * scaleY,
      );
    }
    boundaryCtx.stroke();
  }

  const width = boundary.width;
  const height = boundary.height;
  const boundaryData = boundaryCtx.getImageData(0, 0, width, height).data;
  const blocked = new Uint8Array(width * height);
  for (let index = 0; index < blocked.length; index += 1) {
    blocked[index] = boundaryData[index * 4 + 3] > 0 ? 1 : 0;
  }

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

  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outputCtx = output.getContext('2d');
  const maskImage = outputCtx.createImageData(width, height);
  for (let index = 0; index < blocked.length; index += 1) {
    const alpha = outside[index] ? 0 : 255;
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
  frameCtx.fillStyle = TRANSPARENT_KEY;
  frameCtx.fillRect(0, 0, canvasFrame.width, canvasFrame.height);

  const imageData = frameCtx.createImageData(canvasFrame.width, canvasFrame.height);
  const data = imageData.data;
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
      if (mask[sourceIndex]) {
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
  setStatus(`${source}. ${strokes.length} red outline stroke(s) drawn.`);
}

loadButton.addEventListener('click', loadGif);
gifFile.addEventListener('change', () => loadLocalFile(gifFile.files[0]));
connectEdgesButton.addEventListener('click', connectEdges);
cutButton.addEventListener('click', cutGif);
saveAlignedButton.addEventListener('click', saveImageAlignedMask);
clearButton.addEventListener('click', () => {
  strokes = [];
  currentStroke = null;
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

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get('url');
if (initialUrl) {
  gifUrl.value = initialUrl;
  loadGif();
}

resizeCanvas();
