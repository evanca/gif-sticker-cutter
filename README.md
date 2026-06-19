# GIF Sticker Cutter

Static browser app for turning an animated GIF into a transparent sticker GIF with:

- URL import for CORS-readable GIFs
- Giphy page/media URL support
- direct Tenor media URL support
- local GIF upload fallback
- red marker outline drawing
- edge connection for outlines that use image borders
- hardcoded 5px white sticker outline
- client-side animated GIF export

## GitHub Pages Architecture

The app now runs fully on GitHub Pages. The main workflow is static files only:

- `index.html`
- `styles.css`
- `app.js`
- `vendor/omggif.js`
- `vendor/gif.js`
- `vendor/gif.worker.js`

No hosted API is required for the browser workflow. Imported GIFs and saved masks are cached in IndexedDB, recent URL metadata is stored in `localStorage`, and the final sticker GIF is encoded in the browser for download.

## URL Support

Browser-only URL import depends on CORS. This app supports the URL shapes that usually allow browser reads:

- direct `.gif` URLs with permissive CORS
- Giphy page URLs, for example `https://giphy.com/gifs/...-JIX9t2j0ZTN9S`
- Giphy media URLs, for example `https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif`
- direct Tenor media URLs, for example `https://media.tenor.com/.../name.gif`

Tenor public page URLs such as `https://tenor.com/view/...-gif-12345` do not expose enough media information to browser JavaScript without a readable metadata endpoint. For those, use Tenor's "copy GIF address" / direct media URL, or upload the GIF file.

For any provider that blocks CORS, use **Upload**. That path is fully local and works without network access after the page loads.

## Local Run

You can open `index.html` directly, or run the small local server:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8140/
```

## Workflow

1. Paste a supported GIF URL or click **Upload**.
2. Click **Load** for URL imports.
3. Draw one red outline around the sticker area.
4. Use **Connect edges** if the outline should close along image borders.
5. Click **Save image-aligned mask**.
6. Click **Cut**.
7. Use **Download GIF**.

The browser workflow does not write generated files to the repo. Download links are `blob:` URLs created locally in the page.

## Limits

The browser app limits work to keep GitHub Pages usage practical:

- max GIF size: 25 MB
- max frames: 160
- max dimension: 1200 px
- max pixel area: 1,440,000

Large GIFs may still be slow because all decoding, masking, and encoding happens in the user's browser.

## Legacy Local Backend

`server.mjs` and the Python scripts in `scripts/` are retained as local/legacy tooling from the earlier backend implementation. They are not required for GitHub Pages deployment.
