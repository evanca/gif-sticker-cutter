const gifUrl = document.querySelector('#gifUrl');
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

let strokes = [];
let currentStroke = null;
let drawing = false;
let loadingUrl = '';
let savedMaskPath = '';

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
  for (const stroke of strokes) {
    drawStroke(stroke);
  }
  if (currentStroke) drawStroke(currentStroke);
}

function drawStroke(stroke) {
  if (stroke.points.length < 2) return;
  ctx.strokeStyle = '#ff2424';
  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

function startDrawing(event) {
  if (!gifImage.src) return;
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
  savedMaskPath = '';
  cutButton.disabled = true;
  resultLinks.hidden = true;
  resultLinks.replaceChildren();
  redraw();
  updateSummary();
}

function loadGif() {
  const url = gifUrl.value.trim();
  if (!url) return;
  loadingUrl = url;
  gifImage.src = `/proxy?url=${encodeURIComponent(url)}`;
  gifImage.style.display = 'block';
  emptyState.style.display = 'none';
  strokes = [];
  currentStroke = null;
  savedMaskPath = '';
  cutButton.disabled = true;
  resultLinks.hidden = true;
  resultLinks.replaceChildren();
  redraw();
  updateSummary();
}

function showLoadError() {
  if (!loadingUrl) return;
  gifImage.style.display = 'none';
  emptyState.style.display = 'grid';
  emptyState.textContent = 'Could not load that GIF. Try a direct .gif/media URL, or reload after the proxy resolves the page.';
  statusText.textContent = `GIF failed to load for ${loadingUrl}`;
}

function showLoadedGif() {
  emptyState.textContent = 'Load a GIF URL, then draw the desired sticker outline in red.';
  gifImage.style.display = 'block';
  emptyState.style.display = 'none';
  updateSummary();
  resizeCanvas();
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
    {
      edge: 'top',
      distance: Math.abs(point.y - display.top),
      point: { x: Math.min(Math.max(point.x, display.left), right), y: display.top },
    },
    {
      edge: 'right',
      distance: Math.abs(point.x - right),
      point: { x: right, y: Math.min(Math.max(point.y, display.top), bottom) },
    },
    {
      edge: 'bottom',
      distance: Math.abs(point.y - bottom),
      point: { x: Math.min(Math.max(point.x, display.left), right), y: bottom },
    },
    {
      edge: 'left',
      distance: Math.abs(point.x - display.left),
      point: { x: display.left, y: Math.min(Math.max(point.y, display.top), bottom) },
    },
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
  if (wrapped <= display.width + display.height) {
    return { x: right, y: display.top + wrapped - display.width };
  }
  if (wrapped <= display.width * 2 + display.height) {
    return { x: right - (wrapped - display.width - display.height), y: bottom };
  }
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
  if (!gifImage.naturalWidth || !gifImage.naturalHeight) return;
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
  savedMaskPath = '';
  cutButton.disabled = true;
  redraw();
  updateSummary();
}

async function saveImageAlignedMask() {
  if (!gifImage.naturalWidth || !gifImage.naturalHeight) return;
  const display = imageDisplayRect();
  const output = document.createElement('canvas');
  output.width = gifImage.naturalWidth;
  output.height = gifImage.naturalHeight;
  const outputCtx = output.getContext('2d');
  outputCtx.strokeStyle = '#ff2424';
  outputCtx.lineCap = 'round';
  outputCtx.lineJoin = 'round';
  const scaleX = output.width / display.width;
  const scaleY = output.height / display.height;

  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    outputCtx.lineWidth = stroke.size * ((scaleX + scaleY) / 2);
    outputCtx.beginPath();
    outputCtx.moveTo(
      (stroke.points[0].x - display.left) * scaleX,
      (stroke.points[0].y - display.top) * scaleY,
    );
    for (const point of stroke.points.slice(1)) {
      outputCtx.lineTo(
        (point.x - display.left) * scaleX,
        (point.y - display.top) * scaleY,
      );
    }
    outputCtx.stroke();
  }

  const response = await fetch('/save-overlay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      png: output.toDataURL('image/png'),
      prefix: 'gif-sticker-image-aligned',
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  savedMaskPath = result.path;
  cutButton.disabled = false;
  saveAlignedButton.textContent = `Saved: ${result.path}`;
  statusText.textContent = 'Mask saved. Ready to cut.';
}

function updateSummary() {
  const url = gifUrl.value.trim();
  statusText.textContent = url
    ? `${strokes.length} red outline stroke(s) drawn.`
    : 'Load a GIF, draw the red outline, then save the mask.';
}

function resultLink(label, path, options = {}) {
  const link = document.createElement('a');
  link.href = path;
  link.textContent = label;
  if (options.download) {
    link.download = options.download;
    link.className = 'download-link';
  } else {
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
  return link;
}

function filenameFromPath(path) {
  return path.split('/').pop() || 'sticker.gif';
}

async function cutGif() {
  const sourceUrl = gifUrl.value.trim();
  if (!sourceUrl || !savedMaskPath) return;

  cutButton.disabled = true;
  saveAlignedButton.disabled = true;
  statusText.textContent = 'Cutting and verifying...';
  resultLinks.hidden = true;
  resultLinks.replaceChildren();

  try {
    const response = await fetch('/cut', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl, maskPath: savedMaskPath }),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    resultLinks.append(
      resultLink('Download GIF', result.output, { download: filenameFromPath(result.output) }),
      resultLink('Preview', result.preview),
      resultLink('Contact sheet', result.contactSheet),
    );
    resultLinks.hidden = false;
    statusText.textContent = 'Cut complete. Verification passed.';
  } catch (error) {
    cutButton.disabled = false;
    statusText.textContent = `Cut failed: ${error.message || error}`;
  } finally {
    saveAlignedButton.disabled = false;
  }
}

loadButton.addEventListener('click', loadGif);
connectEdgesButton.addEventListener('click', connectEdges);
cutButton.addEventListener('click', cutGif);
clearButton.addEventListener('click', () => {
  strokes = [];
  currentStroke = null;
  savedMaskPath = '';
  cutButton.disabled = true;
  resultLinks.hidden = true;
  resultLinks.replaceChildren();
  redraw();
  updateSummary();
});
undoButton.addEventListener('click', () => {
  strokes.pop();
  savedMaskPath = '';
  cutButton.disabled = true;
  redraw();
  updateSummary();
});
saveAlignedButton.addEventListener('click', saveImageAlignedMask);
gifImage.addEventListener('error', showLoadError);
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
