# GIF Sticker Cutter

Local web app for turning an animated GIF into a transparent sticker GIF with:

- red marker outline drawing
- edge connection for outlines that use image borders
- smoothed inner-edge mask normalization
- hardcoded 5px white sticker outline
- stable animated GIF export
- automatic silhouette verification

## Requirements

- Node.js 18+
- Python 3.10+
- Python packages from `requirements.txt`

Install Python dependencies:

```bash
python3 -m pip install -r requirements.txt
```

`rembg` is optional and only needed if you run `scripts/make_gif_cutout.py`
manually without `--cut-mask`. The web app always uses a saved mask.

## Run

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

## Workflow

1. Paste a GIF URL.
2. Click **Load**.
3. Draw one red outline around the sticker area.
4. Use **Connect edges** if the outline should close along image borders.
5. Click **Save image-aligned mask**.
6. Click **Cut**.
7. Use **Download GIF** when verification passes.

Generated files are written to `exports/` and ignored by git.

## GitHub Pages

This app cannot be fully deployed on GitHub Pages as-is.

GitHub Pages only serves static files. This app needs a Node server for URL proxying and saving files, plus Python scripts for mask smoothing, GIF generation, and verification.

Good deployment targets for the full app:

- Render
- Fly.io
- Railway
- a VPS
- a local machine

A static GitHub Pages version could show the drawing UI, but **Cut** would not work unless the server/Python pipeline moved to a separate hosted API.
