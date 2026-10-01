/* PrintLens — label layout, TSPL command builder, bitmap packing, roll profiles, status decoding.
   Pure functions, no DOM. Works in the browser (window.TSPL) and in node (module.exports). */
(function (root) {
  'use strict';

  // Built-in TSC bitmap fonts: [char width, char height] in dots
  const FONTS = { '1': [8, 12], '2': [12, 20], '3': [16, 24], '4': [24, 32], '5': [32, 48] };
  const SIZE_TO_FONT = { S: '2', M: '3', L: '4' };
  const FONT_ORDER = ['5', '4', '3', '2', '1'];

  const DEFAULT_SETTINGS = {
    widthMm: 50, heightMm: 25, gapMm: 2, dpi: 203,
    speed: 4, density: 8, flip: false, shiftX: 0, shiftY: 0, textSize: 'M'
  };

  // One profile per roll type. Fields are the per-roll printer settings.
  const PROFILE_FIELDS = ['widthMm', 'heightMm', 'gapMm', 'speed', 'density', 'flip', 'shiftX', 'shiftY'];
  const DEFAULT_PROFILES = [
    { id: 'barcode-50x25', name: '50×25 barcode', widthMm: 50, heightMm: 25, gapMm: 2, speed: 4, density: 8, flip: false, shiftX: 0, shiftY: 0 },
    { id: 'ship-4x6', name: '4×6 shipping', widthMm: 101.6, heightMm: 152.4, gapMm: 3, speed: 4, density: 10, flip: false, shiftX: 0, shiftY: 0 }
  ];

  function mmToDots(mm, dpi) { return Math.round((Number(mm) || 0) * (dpi || 203) / 25.4); }

  // Printer fonts are ASCII only — drop anything else
  function clean(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').trim(); }
  function esc(s) { return clean(s).replace(/"/g, '\\["]'); }

  // Code 128 width estimate in modules (used when JsBarcode isn't available, e.g. node tests).
  function code128Modules(v) {
    v = clean(v);
    if (!v) return 0;
    let syms = 1; // start symbol
    let set = null;
    let i = 0;
    while (i < v.length) {
      let run = 0;
      while (i + run < v.length && v[i + run] >= '0' && v[i + run] <= '9') run++;
      const useC = run >= 4 || (run >= 2 && run === v.length);
      if (useC) {
        const pairs = Math.floor(run / 2);
        if (set !== 'C') { if (set !== null) syms++; set = 'C'; }
        syms += pairs; i += pairs * 2;
      } else {
        if (set !== 'B') { if (set !== null) syms++; set = 'B'; }
        syms++; i++;
      }
    }
    syms += 1; // checksum
    return syms * 11 + 13; // + stop pattern
  }

  // QR version estimate (byte mode, ECC M) → module count
  const QR_CAP_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412];
  function qrModules(v) {
    const n = clean(v).length;
    for (let i = 0; i < QR_CAP_M.length; i++) if (n <= QR_CAP_M[i]) return 17 + 4 * (i + 1);
    return 17 + 4 * 15;
  }

  function ean13Check(d12) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 ? 3 : 1);
    return String((10 - (s % 10)) % 10);
  }

  // Returns { ok, value (what to send), full (human readable), error }
  function validateValue(type, raw) {
    const v = clean(raw);
    if (!v) return { ok: false, error: 'Enter a barcode value.' };
    if (type === 'EAN13') {
      if (!/^\d{12,13}$/.test(v)) return { ok: false, error: 'EAN-13 needs 12 or 13 digits.' };
      if (v.length === 13 && ean13Check(v.slice(0, 12)) !== v[12]) {
        return { ok: false, error: 'EAN-13 check digit is wrong (should end in ' + ean13Check(v.slice(0, 12)) + ').' };
      }
      return { ok: true, value: v.slice(0, 12), full: v.slice(0, 12) + ean13Check(v.slice(0, 12)) };
    }
    return { ok: true, value: v, full: v };
  }

  // Pick the largest font (≤ preferred) that fits maxW; truncate if even font 1 doesn't fit
  function fitText(text, preferredFont, maxW) {
    const t = clean(text);
    const start = FONT_ORDER.indexOf(preferredFont);
    for (let i = Math.max(start, 0); i < FONT_ORDER.length; i++) {
      const f = FONT_ORDER[i];
      if (t.length * FONTS[f][0] <= maxW) return { text: t, font: f, truncated: false };
    }
    const maxChars = Math.max(1, Math.floor(maxW / FONTS['1'][0]));
    return { text: t.slice(0, maxChars), font: '1', truncated: true };
  }

  /* label: { type: 'CODE128'|'EAN13'|'QR', value, top, bottom }
     measure: optional { code128Modules(v), qrModules(v) } for exact widths */
  function layoutLabel(label, settings, measure) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const m = Object.assign({ code128Modules: code128Modules, qrModules: qrModules }, measure || {});
    const W = mmToDots(s.widthMm, s.dpi);
    const H = mmToDots(s.heightMm, s.dpi);
    const pad = mmToDots(1.5, s.dpi);
    const gap = 6;
    const maxTextW = W - pad * 2;
    const items = [];
    const warnings = [];
    const type = label.type || 'CODE128';

    const val = validateValue(type, label.value);
    if (!val.ok) return { W, H, items, warnings, error: val.error };

    const pref = SIZE_TO_FONT[s.textSize] || '3';
    const top = clean(label.top) ? fitText(label.top, pref, maxTextW) : null;
    const bottom = clean(label.bottom) ? fitText(label.bottom, pref, maxTextW) : null;
    if (top && top.truncated) warnings.push('Top text was cut to fit.');
    if (bottom && bottom.truncated) warnings.push('Bottom text was cut to fit.');

    const topH = top ? FONTS[top.font][1] : 0;
    const botH = bottom ? FONTS[bottom.font][1] : 0;
    const codeY = pad + topH + (top ? gap : 0);
    const codeH = H - pad * 2 - topH - botH - (top ? gap : 0) - (bottom ? gap : 0);

    if (top) {
      const w = top.text.length * FONTS[top.font][0];
      items.push({ kind: 'text', x: Math.round((W - w) / 2), y: pad, font: top.font, text: top.text, w: w, h: topH });
    }

    if (codeH < 24) warnings.push('Not enough height for the code — use smaller text or a taller label.');

    if (type === 'QR') {
      const mods = m.qrModules(val.value);
      const size = Math.min(Math.max(codeH, 0), W - pad * 2);
      const cell = Math.max(1, Math.min(10, Math.floor(size / mods)));
      const real = cell * mods;
      if (real > Math.max(codeH, 0)) warnings.push('QR code is taller than the space available.');
      items.push({ kind: 'qr', x: Math.round((W - real) / 2), y: codeY + Math.max(0, Math.round((codeH - real) / 2)), cell: cell, modules: mods, value: val.value, size: real });
    } else {
      const mods = type === 'EAN13' ? 95 : m.code128Modules(val.value);
      let narrow = 0, forced = false;
      for (let n = 4; n >= 1; n--) {
        const quiet = Math.max(pad, 10 * n);
        if (mods * n + quiet * 2 <= W) { narrow = n; break; }
      }
      if (!narrow) {
        narrow = 1; forced = true;
        warnings.push('Barcode is wider than the label and may not scan — shorten the value or use a wider label.');
      }
      const bw = mods * narrow;
      items.push({
        kind: 'barcode', type: type, x: Math.max(0, Math.round((W - bw) / 2)), y: codeY,
        height: Math.max(codeH, 16), narrow: narrow, modules: mods, value: val.value, w: bw
      });
      if (narrow === 1 && !forced && mods > 0) warnings.push('Bars are 1 dot wide — scan-test the first label.');
    }

    if (bottom) {
      const w = bottom.text.length * FONTS[bottom.font][0];
      items.push({ kind: 'text', x: Math.round((W - w) / 2), y: H - pad - botH, font: bottom.font, text: bottom.text, w: w, h: botH });
    }

    return { W, H, items, warnings, error: null, full: val.full };
  }

  function header(settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const lines = [
      'SIZE ' + Number(s.widthMm) + ' mm,' + Number(s.heightMm) + ' mm',
      'GAP ' + Number(s.gapMm) + ' mm,0 mm',
      'SPEED ' + Number(s.speed),
      'DENSITY ' + Number(s.density),
      'DIRECTION ' + (s.flip ? 0 : 1) + ',0',
      'REFERENCE 0,0',
      'SET TEAR ON'
    ];
    if (Number(s.shiftY)) lines.push('SHIFT ' + Math.round(Number(s.shiftY)));
    return lines;
  }

  function clampCopies(c) { return Math.max(1, Math.min(999, Math.floor(Number(c) || 1))); }

  function labelCommands(layout, copies, settings) {
    const sx = Math.round(Number((settings || {}).shiftX) || 0);
    const out = ['CLS'];
    layout.items.forEach(function (it) {
      const x = Math.max(0, it.x + sx);
      if (it.kind === 'text') {
        out.push('TEXT ' + x + ',' + it.y + ',"' + it.font + '",0,1,1,"' + esc(it.text) + '"');
      } else if (it.kind === 'barcode') {
        const code = it.type === 'EAN13' ? 'EAN13' : '128';
        out.push('BARCODE ' + x + ',' + it.y + ',"' + code + '",' + it.height + ',0,0,' + it.narrow + ',' + it.narrow + ',"' + esc(it.value) + '"');
      } else if (it.kind === 'qr') {
        out.push('QRCODE ' + x + ',' + it.y + ',M,' + it.cell + ',A,0,"' + esc(it.value) + '"');
      }
    });
    out.push('PRINT ' + clampCopies(copies));
    return out;
  }

  /* jobs: [{ label, copies }] → { tspl, total, errors:[{index, error}] } */
  function buildJob(jobs, settings, measure) {
    const lines = header(settings);
    const errors = [];
    let total = 0;
    jobs.forEach(function (j, i) {
      const lay = layoutLabel(j.label, settings, measure);
      if (lay.error) { errors.push({ index: i, error: lay.error }); return; }
      const n = clampCopies(j.copies);
      total += n;
      Array.prototype.push.apply(lines, labelCommands(lay, n, settings));
    });
    return { tspl: lines.join('\r\n') + '\r\n', total: total, errors: errors };
  }

  function utilityCommand(kind, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    if (kind === 'feed') return header(s).concat(['FORMFEED']).join('\r\n') + '\r\n';
    if (kind === 'calibrate') return ['SIZE ' + s.widthMm + ' mm,' + s.heightMm + ' mm', 'GAP ' + s.gapMm + ' mm,0 mm', 'GAPDETECT'].join('\r\n') + '\r\n';
    return '';
  }

  /* ---------- Bitmaps (PDF labels) ---------- */

  /* lum: grey values 0 (black) … 255 (white), length w*h.
     Pixels darker than threshold print black. TSPL BITMAP: bit 0 = black dot, 1 = blank
     (invert=true flips that, for printers that read it the other way). */
  function packBitmap(lum, w, h, threshold, invert) {
    const wb = Math.ceil(w / 8);
    const data = new Uint8Array(wb * h);
    data.fill(invert ? 0x00 : 0xFF);
    const t = Number(threshold) || 128;
    let black = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w, out = y * wb;
      for (let x = 0; x < w; x++) {
        if (lum[row + x] < t) {
          black++;
          const bit = 0x80 >> (x & 7);
          if (invert) data[out + (x >> 3)] |= bit; else data[out + (x >> 3)] &= ~bit;
        }
      }
    }
    return { w: w, h: h, wb: wb, data: data, black: black / (w * h) };
  }

  // Read a packed bitmap back as "is pixel black?" (for previews)
  function bitmapIsBlack(bm, x, y, invert) {
    const bit = (bm.data[y * bm.wb + (x >> 3)] >> (7 - (x & 7))) & 1;
    return invert ? bit === 1 : bit === 0;
  }

  function asciiBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }
  function concatBytes(parts) {
    let n = 0; parts.forEach(function (p) { n += p.length; });
    const out = new Uint8Array(n); let o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  /* pages: [{ bm, copies }] → { bytes: Uint8Array, total } */
  function bitmapJob(pages, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const sx = Math.max(0, Math.round(Number(s.shiftX) || 0));
    const parts = [asciiBytes(header(s).join('\r\n') + '\r\n')];
    let total = 0;
    pages.forEach(function (p) {
      const n = clampCopies(p.copies);
      total += n;
      parts.push(asciiBytes('CLS\r\nBITMAP ' + sx + ',0,' + p.bm.wb + ',' + p.bm.h + ',0,'));
      parts.push(p.bm.data);
      parts.push(asciiBytes('\r\nPRINT ' + n + '\r\n'));
    });
    return { bytes: concatBytes(parts), total: total };
  }

  /* How to fit a page (pw × ph, any units) onto a label (W × H dots).
     Rotates 90° when the page and label orientations differ.
     fit: 'fit' keeps the whole page; 'fill' covers the label and crops edges. */
  function placePage(pw, ph, W, H, fit) {
    const rotate = (pw > ph) !== (W > H) && Math.abs(pw - ph) > 1;
    const vw = rotate ? ph : pw, vh = rotate ? pw : ph;
    const scale = fit === 'fill' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
    const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
    return { rotate: rotate, scale: scale, dw: dw, dh: dh, x: Math.round((W - dw) / 2), y: Math.round((H - dh) / 2), percent: Math.round(scale * 100) };
  }

  /* ---------- Printer status (reply to ESC ! ?) ---------- */
  const STATUS_BITS = [
    [0x01, 'The print head is open. Close it firmly.'],
    [0x02, 'Paper jam, or the printer can\'t find the gap between labels. Check the roll size matches the selected roll, then calibrate.'],
    [0x04, 'Out of labels, or the sensor can\'t see them. Reload the roll under the guides, then calibrate.'],
    [0x08, 'Out of ribbon.'],
    [0x10, 'The printer is paused. Press FEED once.'],
    [0x40, 'The cover is open.'],
    [0x80, 'The printer reports an error. Switch it off and on again.']
  ];
  function decodeStatus(b) {
    if (b == null || isNaN(b)) return { ok: false, known: false, problems: ['The printer didn\'t answer the status check.'] };
    const problems = [];
    STATUS_BITS.forEach(function (p) { if (b & p[0]) problems.push(p[1]); });
    const printing = !!(b & 0x20);
    return { ok: problems.length === 0, known: true, printing: printing, code: b, problems: problems };
  }

  /* ---------- Roll profiles ---------- */
  // Returns { profiles, active }. Builds defaults on first run, folding in v1 single-roll settings.
  function migrateProfiles(storedProfiles, storedActive, oldSettings) {
    if (Array.isArray(storedProfiles) && storedProfiles.length) {
      const ok = storedProfiles.some(function (p) { return p.id === storedActive; });
      return { profiles: storedProfiles, active: ok ? storedActive : storedProfiles[0].id };
    }
    const profiles = DEFAULT_PROFILES.map(function (p) { return Object.assign({}, p); });
    let active = profiles[0].id;
    if (oldSettings && oldSettings.widthMm) {
      const target = Number(oldSettings.heightMm) >= 100 ? profiles[1] : profiles[0];
      PROFILE_FIELDS.forEach(function (k) { if (oldSettings[k] != null) target[k] = oldSettings[k]; });
      active = target.id;
    }
    return { profiles: profiles, active: active };
  }

  /* ---------- Bulk import helpers ---------- */
  function parseDelimited(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const firstLine = src.split('\n').find(function (l) { return l.trim(); }) || '';
    const delim = firstLine.indexOf('\t') >= 0 ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }

  const HEADER_MAP = [
    ['value', /^(barcode|bar code|sku|code|value|ean|asin|fsn|item code)$/i],
    ['copies', /^(copies|qty|quantity|count|labels|no\.? of labels|units)$/i],
    ['top', /^(top|name|title|product|product name|label|description)$/i],
    ['bottom', /^(bottom|note|mrp|price|text|line 2)$/i]
  ];

  function rowsToItems(rows) {
    if (!rows || !rows.length) return { items: [], headerFound: false };
    const head = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    const idx = {};
    head.forEach(function (h, i) {
      HEADER_MAP.forEach(function (pair) { if (idx[pair[0]] == null && pair[1].test(h)) idx[pair[0]] = i; });
    });
    const headerFound = idx.value != null;
    const body = headerFound ? rows.slice(1) : rows;
    if (!headerFound) { idx.value = 0; idx.copies = 1; }
    const items = [];
    body.forEach(function (r) {
      const value = clean(r[idx.value]);
      if (!value) return;
      const c = idx.copies != null ? parseInt(String(r[idx.copies]).replace(/[^\d]/g, ''), 10) : 1;
      items.push({
        value: value,
        copies: c > 0 ? Math.min(c, 999) : 1,
        top: idx.top != null ? clean(r[idx.top]) : '',
        bottom: idx.bottom != null ? clean(r[idx.bottom]) : ''
      });
    });
    return { items: items, headerFound: headerFound };
  }

  const api = {
    FONTS, DEFAULT_SETTINGS, DEFAULT_PROFILES, PROFILE_FIELDS, mmToDots, clean, esc, code128Modules, qrModules,
    ean13Check, validateValue, fitText, layoutLabel, header, labelCommands, buildJob, utilityCommand,
    packBitmap, bitmapIsBlack, asciiBytes, concatBytes, bitmapJob, placePage, decodeStatus, migrateProfiles,
    parseDelimited, rowsToItems
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TSPL = api;
})(typeof window !== 'undefined' ? window : this);
