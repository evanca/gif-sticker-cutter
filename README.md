# GIF Sticker Cutter

Local/web app for turning an animated GIF into a transparent sticker GIF with:

- red marker outline drawing
- edge connection for outlines that use image borders
- smoothed inner-edge mask normalization
- hardcoded 5px white sticker outline
- stable animated GIF export
- automatic silhouette verification

## Architecture

The app has two parts:

- **Static frontend**: `index.html`, `app.js`, `styles.css`, `config.js`
- **API backend**: `server.mjs` plus Python scripts in `scripts/`

This supports a GitHub Pages frontend **only when paired with a hosted backend API**. GitHub Pages cannot run the GIF cutting pipeline by itself.

## Requirements

- Node.js 18+
- Python 3.10+
- Python packages from `requirements.txt`

Install Python dependencies:

```bash
python3 -m pip install -r requirements.txt
```

`rembg` is optional and only needed if you run `scripts/make_gif_cutout.py` manually without `--cut-mask`. The web app always uses a saved mask.

## Local Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8140/
```

If Python package architecture is mismatched on macOS, run with explicit Python settings:

```bash
PYTHON_ARCH=arm64 PYTHON_BIN=/usr/local/bin/python3 npm start
```

## GitHub Pages Frontend

1. Host the static files on GitHub Pages.
2. Deploy the backend API to a server platform such as Render, Fly.io, Railway, or a VPS.
3. Set `config.js` on the GitHub Pages deployment:

```js
window.GIF_CUTTER_API_BASE = 'https://your-backend.example.com';
```

You can also test an API URL with a query parameter:

```text
https://yourname.github.io/gif-sticker-cutter/?api=https://your-backend.example.com
```

For local same-origin mode, leave `window.GIF_CUTTER_API_BASE` empty.

## Backend Environment

Recommended public deployment configuration:

```bash
HOST=0.0.0.0
PORT=8140
ALLOWED_ORIGINS=https://yourname.github.io
PYTHON_BIN=/usr/local/bin/python3
# macOS local only, if needed:
# PYTHON_ARCH=arm64
```

Security and resource limits are configurable:

```bash
MAX_BODY_BYTES=8388608
MAX_GIF_BYTES=26214400
MAX_HTML_BYTES=2097152
MAX_MASK_BYTES=4194304
FETCH_TIMEOUT_MS=12000
PROCESS_TIMEOUT_MS=45000
MAX_REDIRECTS=3
MAX_GIF_FRAMES=160
MAX_GIF_DIMENSION=1200
MAX_GIF_PIXELS=1440000
EXPORT_MAX_AGE_MS=3600000
RATE_WINDOW_MS=60000
RATE_MAX=30
TRUST_PROXY=0
```

## Implemented Security Controls

The backend is designed for a public GitHub Pages frontend plus a hosted API:

- strict CORS allowlist via `ALLOWED_ORIGINS`
- local origins allowed for development
- preflight `OPTIONS` support
- no wildcard CORS
- in-memory per-IP rate limiting (`TRUST_PROXY=1` only when a trusted platform proxy sets `X-Forwarded-For`)
- `http`/`https` URL-only fetches
- credentialed URLs rejected
- localhost/private/link-local/multicast IPs blocked
- DNS resolution checked before fetch and after redirects
- manual redirect following with a redirect limit
- remote download size limits
- request body and mask upload size limits
- fetch and Python processing timeouts
- GIF frame count, dimension, and pixel-area validation before cutting
- export filename/path sanitization
- temporary export cleanup by age
- no shell interpolation for Python commands (`execFile` is used)
- static responses include `nosniff` and a restrictive CSP when served by `server.mjs`

Residual deployment risks to handle at the platform level:

- DNS rebinding is reduced but not fully eliminated by pre-fetch DNS checks. Run the backend in a container/VPC without access to sensitive internal services.
- Python/Pillow/scipy parse untrusted media; keep dependencies updated and run in a constrained container.
- In-memory rate limiting is per-process. Use platform/proxy rate limiting for multi-instance deployments.

## Workflow

1. Paste a GIF URL.
2. Click **Load**.
3. Draw one red outline around the sticker area.
4. Use **Connect edges** if the outline should close along image borders.
5. Click **Save image-aligned mask**.
6. Click **Cut**.
7. Use **Download GIF** when verification passes.

Generated files are written to `exports/` and ignored by git.

## API Endpoints

- `GET /health`
- `GET /proxy?url=<gif-or-page-url>`
- `POST /save-overlay`
- `POST /cut`

The static frontend uses the same endpoints either same-origin or through `window.GIF_CUTTER_API_BASE`.
