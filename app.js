/* ביקור שמאי — field app for uniform photo documentation of apartments
   in an urban-renewal (pinui-binui) project. All data stays on the device
   (IndexedDB). Export: printable report, CSV, and a ZIP with uniformly named
   photos + a standalone HTML report + a JSON backup that can be imported back. */
'use strict';
(() => {

/* ---------------- utilities ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtDate = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = (t) => `${fmtDate(t)} ${fmtTime(t)}`;
const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'he', { numeric: true });
const safe = (s) => String(s).replace(/["'״׳]/g, '').replace(/[\\/:*?<>|\n\r\t]+/g, '-').replace(/\s+/g, ' ').trim();
const isoDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/* download names stay Latin: some browsers drop non-Latin download names */
const outName = (...parts) => ['bikur-shamai', ...parts.map((x) => String(x || '').replace(/[^A-Za-z0-9]+/g, '')).filter(Boolean), isoDay()].join('_');
const padNum = (n) => (/^\d+$/.test(String(n)) ? pad(n) : String(n || '').trim());

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

function debounce(fn, ms) {
  let t, pending = null;
  const d = (...args) => {
    clearTimeout(t);
    pending = args;
    t = setTimeout(() => { const a = pending; pending = null; fn(...a); }, ms);
  };
  d.flush = async () => { if (pending) { clearTimeout(t); const a = pending; pending = null; await fn(...a); } };
  return d;
}

/* object URLs created for the current screen; revoked on every full render */
let urls = [];
const url = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
const revokeAll = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };

/* ---------------- storage (IndexedDB) ---------------- */
const db = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open('bikur-shamai', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('apts', { keyPath: 'id' }).createIndex('pid', 'pid');
      const ph = d.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('aid', 'aid');
      ph.createIndex('pid', 'pid');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      let out;
      const r = fn(t.objectStore(store));
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('abort'));
    });
  };
  return {
    get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
    put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
    del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
    all: (s) => tx(s, 'readonly', (st) => st.getAll()),
    by: (s, idx, v) => tx(s, 'readonly', (st) => st.index(idx).getAll(v)),
    delBy: (s, idx, v) => tx(s, 'readwrite', (st) => {
      const r = st.index(idx).openKeyCursor(IDBKeyRange.only(v));
      r.onsuccess = () => { const c = r.result; if (c) { st.delete(c.primaryKey); c.continue(); } };
    }),
  };
})();

/* ---------------- the uniform shot list ----------------
   c = fixed section code (used in file names and on the photo stamp)
   count = repeated per room count, flag = only when the apartment has it
   r = number of required photos for the shot */
const SECTIONS = [
  { k: 'entry', c: '01', t: 'כניסה לדירה', shots: [
    { k: 'door', t: 'דלת הכניסה מבחוץ', h: 'מהמבואה הקומתית, כך שהדלת ומספר הדירה נראים במלואם', r: 1 },
    { k: 'landing', t: 'המבואה הקומתית', h: 'מהדלת לכיוון המדרגות והמעלית', r: 0 },
  ] },
  { k: 'living', c: '02', t: 'סלון ופינת אוכל', shots: [
    { k: 'wide', t: 'מבט כללי מהכניסה', h: 'עומדים בפתח החדר, מכוונים לפינה הרחוקה', r: 1 },
    { k: 'back', t: 'מבט נגדי', h: 'מהפינה הרחוקה חזרה לכיוון הכניסה', r: 1 },
    { k: 'view', t: 'הנוף מהחלון', h: 'מול החלון המרכזי, ישר קדימה ובלי זום', r: 1 },
  ] },
  { k: 'kitchen', c: '03', t: 'מטבח', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהפתח, כך שכל המטבח נכנס בתמונה', r: 1 },
    { k: 'fit', t: 'משטח, ארונות וכיור', h: 'מבט ישר על קו המטבח', r: 1 },
  ] },
  { k: 'hall', c: '04', t: 'מבואה ומסדרון', shots: [
    { k: 'wide', t: 'מבט לאורך המסדרון', h: 'מקצה אחד לקצה השני', r: 0 },
  ] },
  { k: 'bed', c: '05', t: 'חדר שינה', count: 'bedrooms', shots: [
    { k: 'wide', t: 'מבט כללי מהדלת', h: 'עומדים בפתח, מכוונים לפינה הרחוקה', r: 1 },
    { k: 'view', t: 'החלון והנוף ממנו', h: 'מול החלון, ישר קדימה ובלי זום', r: 1 },
  ] },
  { k: 'mamad', c: '06', t: 'ממ"ד', flag: 'mamad', shots: [
    { k: 'wide', t: 'מבט כללי מהדלת', h: 'כולל דלת ההדף', r: 1 },
    { k: 'view', t: 'חלון ההדף והנוף ממנו', h: '', r: 0 },
  ] },
  { k: 'bath', c: '07', t: 'חדר רחצה', count: 'baths', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהפתח, כולל המקלחת או האמבטיה', r: 1 },
    { k: 'fit', t: 'כיור וכלים סניטריים', h: '', r: 0 },
  ] },
  { k: 'wc', c: '08', t: 'שירותים נפרדים', count: 'wcs', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהפתח', r: 1 },
  ] },
  { k: 'balcony', c: '09', t: 'מרפסת', count: 'balconies', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהדלת היוצאת למרפסת, כך שהמעקה נראה', r: 1 },
    { k: 'view', t: 'הנוף מהמרפסת', h: 'מהמעקה, ישר קדימה ובלי זום', r: 1 },
    { k: 'closure', t: 'סגירה או תוספת', h: 'אם המרפסת סגורה: צילום של הסגירה מבפנים ומבחוץ', r: 0 },
  ] },
  { k: 'service', c: '10', t: 'מרפסת שירות', flag: 'service', shots: [
    { k: 'wide', t: 'מבט כללי', h: '', r: 1 },
  ] },
  { k: 'garden', c: '11', t: 'גינה או חצר צמודה', flag: 'garden', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהיציאה מהדירה, כך שגבולות הגינה נראים', r: 1 },
    { k: 'bound', t: 'גבולות, גדר ושער', h: '', r: 0 },
  ] },
  { k: 'roof', c: '12', t: 'גג צמוד', flag: 'roof', shots: [
    { k: 'wide', t: 'מבט כללי', h: 'מהיציאה לגג', r: 1 },
    { k: 'access', t: 'הגישה לגג', h: 'מדרגות, פתח או דלת', r: 0 },
  ] },
  { k: 'parking', c: '13', t: 'חניה', flag: 'parking', shots: [
    { k: 'spot', t: 'מקום החניה', h: 'כולל הסימון או מספר החניה', r: 1 },
  ] },
  { k: 'storage', c: '14', t: 'מחסן', flag: 'storage', shots: [
    { k: 'door', t: 'דלת המחסן מבחוץ', h: 'כולל המספר', r: 1 },
    { k: 'in', t: 'פנים המחסן', h: '', r: 0 },
  ] },
  { k: 'add', c: '15', t: 'תוספות בנייה ושינויים', flag: 'addition', shots: [
    { k: 'photo', t: 'התוספת או השינוי', h: 'צילום רחב שמראה איך התוספת מתחברת למבנה המקורי, ואחריו צילום קרוב', r: 1 },
  ] },
  { k: 'outside', c: '16', t: 'הדירה מבחוץ', shots: [
    { k: 'facade', t: 'חזית הבניין עם חלונות הדירה', h: 'מהרחוב או מהחצר, כך שאפשר לזהות את קומת הדירה', r: 0 },
  ] },
  { k: 'defects', c: '17', t: 'ליקויים ומצב מיוחד', shots: [
    { k: 'photo', t: 'ליקוי', h: 'קודם צילום רחב לזיהוי המקום, ואחריו צילום קרוב', r: 0 },
  ] },
  { k: 'docs', c: '18', t: 'מסמכים שהוצגו בביקור', shots: [
    { k: 'photo', t: 'מסמך', h: 'מלמעלה וישר, כל הדף בתוך המסגרת', r: 0 },
  ] },
];
const SEC = Object.fromEntries(SECTIONS.map((s) => [s.k, s]));
const LANDSCAPE_SHOTS = new Set(['wide', 'back', 'view']);

const COUNTS = [
  { k: 'bedrooms', t: 'חדרי שינה', max: 8 },
  { k: 'baths', t: 'חדרי רחצה', max: 5 },
  { k: 'wcs', t: 'שירותים נפרדים', max: 4 },
  { k: 'balconies', t: 'מרפסות', max: 6 },
];
const FLAGS = [
  { k: 'mamad', t: 'ממ"ד' },
  { k: 'service', t: 'מרפסת שירות' },
  { k: 'garden', t: 'גינה צמודה' },
  { k: 'roof', t: 'גג צמוד' },
  { k: 'parking', t: 'חניה' },
  { k: 'storage', t: 'מחסן' },
  { k: 'addition', t: 'תוספת בנייה' },
];
const DIRS = ['צפון', 'דרום', 'מזרח', 'מערב'];
const VIEWS = ['פתוח', 'פתוח חלקית', 'חסום', 'נוף מיוחד'];
const CONDS = ['טוב מאוד', 'טוב', 'סביר', 'ירוד'];
const FIELDS = [
  { k: 'building', t: 'בניין' }, { k: 'entrance', t: 'כניסה' }, { k: 'floor', t: 'קומה' }, { k: 'number', t: 'מספר דירה' },
  { k: 'sub', t: 'תת חלקה' }, { k: 'owner', t: 'בעלים' }, { k: 'phone', t: 'טלפון', type: 'tel' }, { k: 'present', t: 'נוכחים בביקור' },
  { k: 'rooms', t: 'מספר חדרים', mode: 'decimal' }, { k: 'area', t: 'שטח רשום במ"ר', mode: 'decimal' }, { k: 'areaM', t: 'שטח שנמדד במ"ר', mode: 'decimal' },
];

const newApt = (pid, o = {}) => ({
  id: uid(), pid, building: '', entrance: '', floor: '', number: '', sub: '', owner: '', phone: '', present: '',
  rooms: '', area: '', areaM: '', dirs: [], view: '', cond: '', notes: '',
  cfg: { bedrooms: 2, baths: 1, wcs: 0, balconies: 1, mamad: false, service: false, garden: false, roof: false, parking: false, storage: false, addition: false },
  secs: {}, done: false, started: null, finished: null, created: Date.now(), updated: Date.now(), ...o,
});

/* the list of section instances for an apartment, according to its make-up */
function buildPlan(a) {
  const out = [];
  for (const s of SECTIONS) {
    if (s.flag && !a.cfg[s.flag]) continue;
    const n = s.count ? (a.cfg[s.count] || 0) : 0;
    if (s.count) {
      for (let i = 1; i <= n; i++) out.push({ s, key: `${s.k}-${i}`, code: `${s.c}.${i}`, title: `${s.t} ${i}` });
    } else {
      out.push({ s, key: s.k, code: s.c, title: s.t });
    }
  }
  return out;
}
/* slot = "<section instance key>.<shot key>", e.g. "bed-2.view" */
function slotInfo(slot) {
  const [inst, shotK] = slot.split('.');
  const [secK, n] = inst.split('-');
  const s = SEC[secK];
  if (!s) return { code: '99', title: inst, shot: { k: shotK, t: shotK }, inst };
  const shot = s.shots.find((x) => x.k === shotK) || { k: shotK, t: shotK };
  return { s, inst, shot, code: n ? `${s.c}.${n}` : s.c, title: n ? `${s.t} ${n}` : s.t };
}

function progress(a, photos) {
  const cnt = {};
  photos.forEach((p) => { cnt[p.slot] = (cnt[p.slot] || 0) + 1; });
  let need = 0, have = 0;
  const missing = [];
  for (const e of buildPlan(a)) {
    if (a.secs[e.key]?.na) continue;
    for (const sh of e.s.shots) {
      if (!sh.r) continue;
      need += sh.r;
      const got = Math.min(sh.r, cnt[`${e.key}.${sh.k}`] || 0);
      have += got;
      if (got < sh.r) missing.push(`${e.title}: ${sh.t}`);
    }
  }
  return { need, have, missing, pct: need ? Math.round((have / need) * 100) : 100, photos: photos.length };
}

const aptLabel = (a) => [a.building && `בניין ${a.building}`, a.entrance && `כניסה ${a.entrance}`, `דירה ${a.number || '—'}`].filter(Boolean).join(' · ');
const aptFolder = (a) => safe([a.building && `בניין ${a.building}`, a.entrance && `כניסה ${a.entrance}`, `דירה ${padNum(a.number) || 'ללא מספר'}`].filter(Boolean).join(' - '));
const photoName = (p) => { const i = slotInfo(p.slot); return safe(`${i.code} ${i.title} - ${i.shot.t} - ${p.seq}`) + '.jpg'; };
const sortApts = (list) => list.sort((x, y) => cmp(x.building, y.building) || cmp(x.entrance, y.entrance) || cmp(x.number, y.number));
const cfgText = (a) => {
  const parts = COUNTS.filter((c) => a.cfg[c.k]).map((c) => `${a.cfg[c.k]} ${c.t}`);
  return parts.join(', ');
};
const flagsText = (a) => FLAGS.filter((f) => a.cfg[f.k]).map((f) => f.t).join(', ');

/* ---------------- image processing ---------------- */
const MAX_SIDE = 2000;
const THUMB_SIDE = 640;
const canvasBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
  return new Promise((res, rej) => {
    const im = new Image();
    const u = URL.createObjectURL(file);
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
    im.src = u;
  });
}

async function shrink(src, side, q) {
  const w0 = src.width, h0 = src.height, s = Math.min(1, side / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return canvasBlob(c, q);
}

/* resize, and add a uniform identification strip below the picture */
async function processImage(file, mainText, timeText) {
  const bmp = await decode(file);
  const w0 = bmp.width, h0 = bmp.height;
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const bar = Math.round(Math.max(30, Math.min(w, h) * 0.065));
  const c = document.createElement('canvas');
  c.width = w; c.height = h + bar;
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  x.fillStyle = '#13284B'; x.fillRect(0, h, w, bar);
  x.fillStyle = '#9ACD45'; x.fillRect(0, h, w, Math.max(2, Math.round(bar * 0.08)));
  try { await document.fonts.load(`700 ${Math.round(bar * 0.42)}px Heebo`); } catch (e) { /* system font */ }
  const gap = Math.round(bar * 0.4), mid = h + bar / 2 + bar * 0.04;
  x.textBaseline = 'middle';
  x.fillStyle = '#FFFFFF';
  x.font = `500 ${Math.round(bar * 0.38)}px Heebo, Assistant, Arial, sans-serif`;
  x.direction = 'ltr'; x.textAlign = 'left';
  const tw = x.measureText(timeText).width;
  x.fillText(timeText, gap, mid);
  x.font = `700 ${Math.round(bar * 0.42)}px Heebo, Assistant, Arial, sans-serif`;
  x.direction = 'rtl'; x.textAlign = 'right';
  x.fillText(mainText, w - gap, mid, Math.max(50, w - tw - gap * 3));
  const full = await canvasBlob(c, 0.82);
  const thumb = await shrink(c, THUMB_SIDE, 0.72);
  return { full, thumb, w, h: h + bar, portrait: h0 > w0 };
}

async function thumbFrom(blob) {
  const bmp = await decode(blob);
  const t = await shrink(bmp, THUMB_SIDE, 0.72);
  if (bmp.close) bmp.close();
  return t;
}

/* ---------------- ZIP (store, UTF-8 names) ---------------- */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

async function makeZip(files, onStep) {
  const enc = new TextEncoder();
  const parts = [], cd = [];
  let off = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = enc.encode(f.name);
    const isStr = typeof f.data === 'string';
    const data = isStr ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
    const crc = crc32(data), size = data.length;
    const d = new Date(f.date || Date.now());
    const dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(lh, name, isStr ? data : f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    cd.push(ch, name);
    off += 30 + name.length + size;
    if (onStep) onStep(i + 1, files.length);
  }
  const cdSize = cd.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cd, end], { type: 'application/zip' });
}

async function readZip(blob) {
  const tl = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tl).arrayBuffer());
  let p = -1;
  for (let i = tl - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('not-zip');
  const count = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const map = new Map();
  let q = 0;
  for (let i = 0; i < count; i++) {
    const nl = cd.getUint16(q + 28, true), el = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true);
    map.set(dec.decode(new Uint8Array(cd.buffer, q + 46, nl)), { method: cd.getUint16(q + 10, true), csize: cd.getUint32(q + 20, true), lo: cd.getUint32(q + 42, true) });
    q += 46 + nl + el + cl;
  }
  const file = async (name, type = '') => {
    const e = map.get(name);
    if (!e) return null;
    const lh = new DataView(await blob.slice(e.lo, e.lo + 30).arrayBuffer());
    const start = e.lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = blob.slice(start, start + e.csize);
    if (e.method === 0) return new Blob([raw], { type });
    if (e.method === 8 && 'DecompressionStream' in window) {
      const b = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      return new Blob([b], { type });
    }
    throw new Error('unsupported-zip');
  };
  return { names: [...map.keys()], file };
}

/* ---------------- delivery ---------------- */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
async function deliver(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (matchMedia('(pointer:coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  download(blob, name);
}

/* ---------------- report ---------------- */
function aptRows(a, pr) {
  const rows = [
    ['מיקום', [a.building && `בניין ${a.building}`, a.entrance && `כניסה ${a.entrance}`, a.floor !== '' && `קומה ${a.floor}`, `דירה ${a.number || '—'}`].filter(Boolean).join(' · ')],
    ['תת חלקה', a.sub], ['בעלים', [a.owner, a.phone].filter(Boolean).join(' · ')], ['נוכחים בביקור', a.present],
    ['מספר חדרים', a.rooms], ['שטח רשום', a.area && `${a.area} מ"ר`], ['שטח שנמדד', a.areaM && `${a.areaM} מ"ר`],
    ['הרכב', cfgText(a)], ['הצמדות ותוספות', flagsText(a)],
    ['כיווני אוויר', (a.dirs || []).join(', ')], ['נוף', a.view], ['מצב תחזוקה', a.cond],
    ['מועד הביקור', a.started ? fmtDT(a.started) : ''], ['הערות', a.notes],
    ['צילומי חובה', `${pr.have} מתוך ${pr.need}`],
  ];
  if (pr.missing.length && (pr.photos || a.done)) rows.push(['חסרים', pr.missing.join(' · ')]);
  return rows.filter((r) => r[1]).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
}

function reportHTML(p, apts, photosOf, src) {
  let h = '<div class="rep">';
  h += `<header><p class="small muted">תיעוד ביקור שמאי · ניקוד לסדר בחירת הדירות</p><h1>${esc(p.name)}</h1>`;
  h += `<p>${esc([p.address, p.appraiser && `שמאי: ${p.appraiser}`].filter(Boolean).join(' · '))}</p>`;
  h += `<p class="small muted">הופק בתאריך ${fmtDate(Date.now())} · ${apts.length} דירות</p></header>`;
  if (apts.length > 1) {
    h += '<h2 style="margin-top:16px">ריכוז הדירות</h2><table class="sum" style="margin-top:8px"><thead><tr><th>דירה</th><th>קומה</th><th>חדרים</th><th>שטח</th><th>כיווני אוויר</th><th>נוף</th><th>מצב</th><th>צילומים</th><th>סטטוס</th></tr></thead><tbody>';
    for (const a of apts) {
      const pr = progress(a, photosOf(a));
      h += `<tr><td>${esc(aptLabel(a))}</td><td>${esc(a.floor)}</td><td>${esc(a.rooms)}</td><td>${esc(a.area)}</td><td>${esc((a.dirs || []).join(', '))}</td><td>${esc(a.view)}</td><td>${esc(a.cond)}</td><td class="tnum">${pr.photos} (${pr.have}/${pr.need})</td><td>${statusOf(a, pr).t}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  for (const a of apts) {
    const ph = photosOf(a);
    const pr = progress(a, ph);
    if (apts.length > 1 && !ph.length && !a.done) continue;
    h += `<section class="rep-apt"><h2 style="margin-block:14px 8px">${esc(aptLabel(a))}</h2><table>${aptRows(a, pr)}</table>`;
    for (const e of buildPlan(a)) {
      const st = a.secs[e.key] || {};
      const list = ph.filter((x) => x.slot.split('.')[0] === e.key);
      const shotIdx = (x) => e.s.shots.findIndex((s) => `${e.key}.${s.k}` === x.slot);
      list.sort((x, y) => shotIdx(x) - shotIdx(y) || x.seq - y.seq);
      if (!list.length && !st.na && !st.note) continue;
      h += `<div class="rep-sec"><h3>${esc(e.code)} · ${esc(e.title)}</h3>`;
      if (st.na) h += `<p class="rep-note">סומן: לא קיים או אין גישה${st.naWhy ? ` (${esc(st.naWhy)})` : ''}</p>`;
      if (list.length) {
        h += '<div class="rep-ph">';
        for (const x of list) {
          const i = slotInfo(x.slot);
          h += `<figure><img src="${esc(src(a, x))}" alt="${esc(`${i.title}, ${i.shot.t}`)}" loading="eager"><figcaption>${esc(i.shot.t)}${x.seq > 1 ? ` (${x.seq})` : ''} · ${fmtDT(x.at)}</figcaption></figure>`;
        }
        h += '</div>';
      }
      if (st.note) h += `<p class="rep-note"><b>הערה:</b> ${esc(st.note)}</p>`;
      h += '</div>';
    }
    h += '</section>';
  }
  return h + '</div>';
}

function csvOf(apts, photosOf) {
  const head = ['בניין', 'כניסה', 'קומה', 'דירה', 'תת חלקה', 'בעלים', 'טלפון', 'נוכחים', 'חדרים', 'שטח רשום', 'שטח שנמדד',
    'כיווני אוויר', 'נוף', 'מצב תחזוקה', ...COUNTS.map((c) => c.t), ...FLAGS.map((f) => f.t),
    'צילומים', 'צילומי חובה שבוצעו', 'צילומי חובה נדרשים', 'סטטוס', 'מועד הביקור', 'הערות'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = apts.map((a) => {
    const pr = progress(a, photosOf(a));
    return [a.building, a.entrance, a.floor, a.number, a.sub, a.owner, a.phone, a.present, a.rooms, a.area, a.areaM,
      (a.dirs || []).join(' '), a.view, a.cond, ...COUNTS.map((c) => a.cfg[c.k] || 0), ...FLAGS.map((f) => (a.cfg[f.k] ? 'כן' : '')),
      pr.photos, pr.have, pr.need, statusOf(a, pr).t, a.started ? fmtDT(a.started) : '', a.notes];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

function statusOf(a, pr) {
  if (a.done) return { t: 'הושלם', c: 'ok' };
  if (pr.photos) return { t: 'בתהליך', c: 'mid' };
  return { t: 'טרם התחיל', c: '' };
}

async function cssText() {
  try { return await (await fetch('app.css')).text(); } catch (e) { return ''; }
}

/* project (or one apartment) → ZIP with folders of photos, report, CSV and backup */
async function exportZip(p, apts, fileName) {
  const all = await db.by('photos', 'pid', p.id);
  const ids = new Set(apts.map((a) => a.id));
  const photos = all.filter((x) => ids.has(x.aid));
  const folders = new Map(), used = new Set();
  for (const a of apts) {
    let f = aptFolder(a);
    if (used.has(f)) f += ` (${a.id.slice(0, 4)})`;
    used.add(f); folders.set(a.id, f);
  }
  const files = [];
  const meta = [];
  const pathOf = new Map();
  for (const x of photos) {
    const path = `${folders.get(x.aid)}/${photoName(x)}`;
    pathOf.set(x.id, path);
    files.push({ name: path, data: x.blob, date: x.at });
    meta.push({ id: x.id, aid: x.aid, slot: x.slot, seq: x.seq, at: x.at, w: x.w, h: x.h, path });
  }
  const photosOf = (a) => photos.filter((x) => x.aid === a.id);
  const css = await cssText();
  const rep = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.name)} · דוח ביקור</title><style>${css}</style></head><body><div class="wrap view">${reportHTML(p, apts, photosOf, (a, x) => pathOf.get(x.id))}</div></body></html>`;
  files.push({ name: 'דוח ביקור.html', data: rep });
  files.push({ name: 'סיכום דירות.csv', data: csvOf(apts, photosOf) });
  files.push({ name: 'project.json', data: JSON.stringify({ format: 'bikur-shamai', v: 1, exported: Date.now(), project: p, apts, photos: meta }, null, 1) });
  const t = $('#toast');
  const zip = await makeZip(files, (i, n) => { if (n > 20 && i % 10 === 0) { t.hidden = false; t.textContent = `מכין קובץ… ${i} מתוך ${n}`; } });
  await deliver(zip, fileName);
  toast(`הקובץ מוכן: ${photos.length} תמונות`);
}

async function importZip(file) {
  let z, data;
  try {
    z = await readZip(file);
    const j = await z.file('project.json');
    if (!j) throw new Error('no-json');
    data = JSON.parse(await j.text());
    if (data.format !== 'bikur-shamai') throw new Error('format');
  } catch (e) {
    toast('לא הצלחנו לקרוא את הקובץ. צריך לבחור קובץ שהופק מהאפליקציה, בלי לפתוח ולדחוס אותו מחדש.', 5000);
    return;
  }
  const exists = await db.get('projects', data.project.id);
  if (exists && !confirm(`הפרויקט "${exists.name}" כבר קיים במכשיר. להחליף אותו בגרסה מהקובץ?`)) return;
  if (exists) await deleteProject(exists.id);
  await db.put('projects', data.project);
  for (const a of data.apts) await db.put('apts', a);
  let n = 0;
  for (const m of data.photos) {
    const blob = await z.file(m.path, 'image/jpeg');
    if (!blob) continue;
    const thumb = await thumbFrom(blob);
    const { path, ...rec } = m;
    await db.put('photos', { ...rec, pid: data.project.id, blob, thumb });
    n++;
    if (n % 10 === 0) { const t = $('#toast'); t.hidden = false; t.textContent = `משחזר… ${n} מתוך ${data.photos.length}`; }
  }
  toast(`השחזור הושלם: ${data.apts.length} דירות, ${n} תמונות`);
  location.hash = `#/p/${data.project.id}`;
}

async function deleteProject(pid) {
  await db.delBy('photos', 'pid', pid);
  await db.delBy('apts', 'pid', pid);
  await db.del('projects', pid);
}

/* ---------------- state + routing ---------------- */
const main = $('#main');
const S = { p: null, a: null, photos: [], slot: null, view: '' };

const saveApt = debounce(async () => { if (S.a) { S.a.updated = Date.now(); await db.put('apts', S.a); } }, 350);
const saveProj = debounce(async () => { if (S.p) await db.put('projects', S.p); }, 350);

function route() {
  const h = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (h[0] === 'p' && h[1]) {
    if (h[2] === 'a' && h[3]) return { v: h[4] === 'report' ? 'aptReport' : 'apt', pid: h[1], aid: h[3] };
    return { v: h[2] === 'report' ? 'projReport' : 'proj', pid: h[1] };
  }
  return { v: 'home' };
}

async function render() {
  await saveApt.flush(); await saveProj.flush();
  revokeAll();
  const r = route();
  S.view = r.v;
  try {
    if (r.v === 'home') await viewHome();
    else if (r.v === 'proj') await viewProject(r.pid);
    else if (r.v === 'apt') await viewApt(r.pid, r.aid);
    else await viewReport(r.pid, r.v === 'aptReport' ? r.aid : null);
  } catch (e) {
    console.error(e);
    main.innerHTML = `<section class="view wrap"><h1>משהו השתבש</h1><p>${esc(e.message)}</p><p><a href="#/">חזרה לרשימת הפרויקטים</a></p></section>`;
  }
}
async function rerender() { const y = scrollY; await render(); scrollTo(0, y); }
async function go() { await render(); scrollTo(0, 0); main.focus({ preventScroll: true }); }

const notFound = () => { main.innerHTML = '<section class="view wrap"><h1>לא נמצא</h1><p><a href="#/">חזרה לרשימת הפרויקטים</a></p></section>'; };

const RULES = `<ol>
  <li>מחזיקים את הטלפון לרוחב, בגובה החזה.</li>
  <li>בלי זום, בלי פילטרים ובלי מצב פורטרט.</li>
  <li>מדליקים אורות ופותחים תריסים ווילונות לפני הצילום.</li>
  <li>מבט כללי: עומדים בפתח החדר ומכוונים לפינה הרחוקה.</li>
  <li>נוף: עומדים מול החלון ומצלמים ישר קדימה.</li>
  <li>כל תמונה מקבלת פס זיהוי אחיד עם הדירה, החדר והמועד.</li>
</ol>`;

/* ---------- home ---------- */
async function viewHome() {
  const [projects, apts] = await Promise.all([db.all('projects'), db.all('apts')]);
  projects.sort((a, b) => b.created - a.created);
  let storage = '';
  try {
    const e = await navigator.storage.estimate();
    storage = `נפח בשימוש במכשיר: ${(e.usage / 1048576).toFixed(0)} מגה`;
  } catch (e) { /* no estimate */ }
  main.innerHTML = `<section class="view wrap">
    <div class="head"><div><h1>ביקור שמאי</h1><p>תיעוד אחיד בתמונות של מרכיבי הדירות, לצורך ניקוד סדר בחירת הדירות החדשות.</p></div></div>
    <details class="card guide"><summary>איך זה עובד</summary>
      <ol>
        <li>פותחים פרויקט ומוסיפים את הדירות. אפשר להוסיף טווח מספרים בבת אחת.</li>
        <li>בכל דירה מגדירים את ההרכב: חדרים, מרפסות, הצמדות. רשימת הצילומים מתעדכנת לפי ההרכב.</li>
        <li>מצלמים לפי הרשימה. צילומי החובה מסומנים, וסרגל ההתקדמות מראה מה חסר.</li>
        <li>בסוף מפיקים דוח להדפסה וקובץ מרוכז עם כל התמונות, בשמות קבועים לפי הדירה והחדר.</li>
      </ol>
      <p class="small muted">הנתונים נשמרים רק במכשיר הזה ולא נשלחים לשום מקום. מומלץ להוריד קובץ מרוכז בסוף כל יום עבודה, כגיבוי.</p>
    </details>
    <details class="card guide"><summary>נוהל הצילום האחיד</summary>${RULES}</details>
    <h2>פרויקטים</h2>
    ${projects.length ? `<ul class="list">${projects.map((p) => {
      const n = apts.filter((a) => a.pid === p.id);
      const done = n.filter((a) => a.done).length;
      return `<li><a class="item" href="#/p/${p.id}"><div class="item-main"><div class="item-t">${esc(p.name)}</div><div class="item-s">${esc([p.address, p.appraiser].filter(Boolean).join(' · '))}</div></div><span class="badge ${n.length && done === n.length ? 'ok' : ''} tnum">${done}/${n.length} דירות</span></a></li>`;
    }).join('')}</ul>` : '<div class="card empty">עדיין אין פרויקטים. אפשר לפתוח פרויקט חדש כאן למטה.</div>'}
    <form class="card" data-form="new-proj">
      <h2>פרויקט חדש</h2>
      <div class="grid">
        <label class="f wide"><span>שם הפרויקט</span><input type="text" name="name" required placeholder="למשל: פינוי בינוי רחוב הרצל"></label>
        <label class="f wide"><span>כתובת, גוש וחלקה</span><input type="text" name="address"></label>
        <label class="f"><span>שם השמאי</span><input type="text" name="appraiser"></label>
      </div>
      <button class="btn btn-p" type="submit">פתיחת הפרויקט</button>
    </form>
    <div class="card">
      <h2>שחזור מגיבוי</h2>
      <p class="small muted">בחירת קובץ מרוכז שהורד מהאפליקציה, למשל כדי להעביר את העבודה למכשיר אחר.</p>
      <button class="btn btn-s" type="button" data-act="import">בחירת קובץ גיבוי</button>
    </div>
    <p class="small muted">${esc(storage)}</p>
  </section>`;
}

/* ---------- project ---------- */
async function viewProject(pid) {
  const [p, apts, photos] = await Promise.all([db.get('projects', pid), db.by('apts', 'pid', pid), db.by('photos', 'pid', pid)]);
  if (!p) return notFound();
  S.p = p; S.a = null;
  sortApts(apts);
  const photosOf = (a) => photos.filter((x) => x.aid === a.id);
  const done = apts.filter((a) => a.done).length;
  main.innerHTML = `<section class="view wrap">
    <nav class="crumbs"><a href="#/">פרויקטים</a> ‹ ${esc(p.name)}</nav>
    <div class="head"><div><h1>${esc(p.name)}</h1><p>${esc([p.address, p.appraiser && `שמאי: ${p.appraiser}`].filter(Boolean).join(' · '))}</p></div>
      <span class="badge ${apts.length && done === apts.length ? 'ok' : ''} tnum">${done} מתוך ${apts.length} דירות הושלמו · ${photos.length} תמונות</span></div>
    <div class="toolbar">
      <label class="sr" for="q">חיפוש דירה</label>
      <input type="text" id="q" placeholder="חיפוש לפי מספר, בניין או שם">
      <button type="button" class="btn btn-p" data-act="goto-add">הוספת דירה</button>
    </div>
    ${apts.length ? `<ul class="list" id="apts">${apts.map((a) => {
      const pr = progress(a, photosOf(a));
      const st = statusOf(a, pr);
      return `<li data-q="${esc([aptLabel(a), a.owner, a.number].join(' ').toLowerCase())}"><a class="item" href="#/p/${p.id}/a/${a.id}">
        <div class="item-main"><div class="item-t">${esc(aptLabel(a))}</div><div class="item-s">${esc([a.floor !== '' && `קומה ${a.floor}`, a.owner, a.rooms && `${a.rooms} חדרים`].filter(Boolean).join(' · ') || 'לחצו כדי להתחיל')}</div></div>
        <span class="small muted tnum">${pr.have}/${pr.need}</span><span class="badge ${st.c}">${st.t}</span></a></li>`;
    }).join('')}</ul>` : '<div class="card empty">עדיין אין דירות בפרויקט.</div>'}
    <form class="card" id="add" data-form="add-apt">
      <h2>הוספת דירה</h2>
      <div class="grid">
        <label class="f"><span>בניין</span><input type="text" name="building"></label>
        <label class="f"><span>כניסה</span><input type="text" name="entrance"></label>
        <label class="f"><span>קומה</span><input type="text" name="floor" inputmode="numeric"></label>
        <label class="f"><span>מספר דירה</span><input type="text" name="number" required inputmode="numeric"></label>
        <label class="f wide"><span>בעלים</span><input type="text" name="owner"></label>
      </div>
      <button class="btn btn-p" type="submit">הוספה ומעבר לביקור</button>
    </form>
    <form class="card" data-form="add-range">
      <h2>הוספת טווח דירות</h2>
      <p class="small muted">לבניין עם מספור רציף. דירות שכבר קיימות באותו בניין ובאותה כניסה לא יתווספו שוב.</p>
      <div class="grid">
        <label class="f"><span>בניין</span><input type="text" name="building"></label>
        <label class="f"><span>כניסה</span><input type="text" name="entrance"></label>
        <label class="f"><span>מדירה</span><input type="number" name="from" min="1" required></label>
        <label class="f"><span>עד דירה</span><input type="number" name="to" min="1" required></label>
        <label class="f"><span>דירות בכל קומה</span><input type="number" name="per" min="1" placeholder="לא חובה"></label>
        <label class="f"><span>קומת הדירה הראשונה</span><input type="number" name="f0" value="1"></label>
      </div>
      <button class="btn btn-s" type="submit">הוספת הטווח</button>
    </form>
    <div class="card">
      <h2>הפקה וגיבוי</h2>
      <div class="row">
        <a class="btn btn-p" href="#/p/${p.id}/report">דוח לכל הפרויקט</a>
        <button class="btn btn-s" type="button" data-act="zip-proj">קובץ מרוכז עם כל התמונות</button>
        <button class="btn btn-s" type="button" data-act="csv">טבלת סיכום לאקסל</button>
      </div>
      <p class="small muted">הקובץ המרוכז כולל תיקייה לכל דירה, דוח שנפתח בכל דפדפן, טבלת סיכום וקובץ שמאפשר לשחזר את העבודה במכשיר אחר.</p>
    </div>
    <details class="card"><summary>פרטי הפרויקט</summary>
      <div class="grid">
        <label class="f wide"><span>שם הפרויקט</span><input type="text" data-pf="name" value="${esc(p.name)}"></label>
        <label class="f wide"><span>כתובת, גוש וחלקה</span><input type="text" data-pf="address" value="${esc(p.address)}"></label>
        <label class="f"><span>שם השמאי</span><input type="text" data-pf="appraiser" value="${esc(p.appraiser)}"></label>
      </div>
      <button class="btn btn-d btn-sm" type="button" data-act="del-proj">מחיקת הפרויקט מהמכשיר</button>
    </details>
  </section>`;
  S.projApts = apts; S.projPhotos = photos;
}

/* ---------- apartment visit ---------- */
async function viewApt(pid, aid) {
  const [p, a, photos] = await Promise.all([db.get('projects', pid), db.get('apts', aid), db.by('photos', 'aid', aid)]);
  if (!p || !a) return notFound();
  S.p = p; S.a = a; S.photos = photos;
  const pr = progress(a, photos);
  const bySlot = {};
  photos.forEach((x) => { (bySlot[x.slot] ||= []).push(x); });
  Object.values(bySlot).forEach((l) => l.sort((x, y) => x.seq - y.seq));

  const fields = FIELDS.map((f) => `<label class="f"><span>${esc(f.t)}</span><input type="${f.type || 'text'}" ${f.mode ? `inputmode="${f.mode}"` : ''} data-f="${f.k}" value="${esc(a[f.k])}"></label>`).join('');
  const select = (k, label, opts) => `<label class="f"><span>${label}</span><select data-f="${k}"><option value="">—</option>${opts.map((o) => `<option ${a[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;

  const secs = buildPlan(a).map((e) => {
    const st = a.secs[e.key] || {};
    const shots = e.s.shots.map((sh) => {
      const slot = `${e.key}.${sh.k}`;
      const list = bySlot[slot] || [];
      const ok = sh.r ? list.length >= sh.r : list.length > 0;
      return `<div class="shot ${ok ? 'ok' : ''}">
        <div class="shot-h"><div><div class="shot-t">${esc(sh.t)}${sh.r ? '<span class="badge req st">חובה</span>' : ''}</div>${sh.h ? `<div class="shot-hint">${esc(sh.h)}</div>` : ''}</div>
          <div class="shot-btns">
            <button type="button" class="btn btn-p btn-sm" data-act="shoot" data-slot="${slot}" aria-label="צילום: ${esc(`${e.title}, ${sh.t}`)}">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10.5H4z"/><circle cx="12" cy="13.5" r="3.4"/></svg><span>צילום</span></button>
            <button type="button" class="btn btn-s btn-sm" data-act="gallery" data-slot="${slot}" aria-label="בחירה מהגלריה: ${esc(`${e.title}, ${sh.t}`)}">גלריה</button>
          </div></div>
        <div class="thumbs">${list.map((x) => `<button type="button" class="thumb" data-act="view" data-id="${x.id}" aria-label="פתיחת תמונה ${x.seq}"><img src="${url(x.thumb)}" alt=""><b class="tnum">${x.seq}</b></button>`).join('')}</div>
      </div>`;
    }).join('');
    const reqs = e.s.shots.filter((s) => s.r);
    const complete = !st.na && reqs.length > 0 && reqs.every((s) => (bySlot[`${e.key}.${s.k}`] || []).length >= s.r);
    return `<section class="sec ${st.na ? 'na' : ''} ${complete ? 'complete' : ''}" id="s-${e.key}">
      <div class="sec-h"><h3><span class="code tnum">${esc(e.code)}</span>${esc(e.title)}</h3>
        <label class="na-t"><input type="checkbox" data-na="${e.key}" ${st.na ? 'checked' : ''}>אין גישה / לא קיים</label></div>
      <div class="shots">${shots}</div>
      <div class="sec-note"><label class="sr" for="n-${e.key}">הערה ל${esc(e.title)}</label><textarea id="n-${e.key}" data-note="${e.key}" placeholder="${st.na ? 'סיבה, למשל: הדייר לא אפשר כניסה' : 'הערה (לא חובה)'}">${esc(st.note)}</textarea></div>
    </section>`;
  }).join('');

  main.innerHTML = `<section class="view wrap">
    <nav class="crumbs"><a href="#/">פרויקטים</a> ‹ <a href="#/p/${p.id}">${esc(p.name)}</a> ‹ ${esc(aptLabel(a))}</nav>
    <div class="head"><div><h1>${esc(aptLabel(a))}</h1><p>${esc([a.floor !== '' && `קומה ${a.floor}`, a.owner].filter(Boolean).join(' · '))}</p></div>
      <span class="badge ${statusOf(a, pr).c}">${statusOf(a, pr).t}</span></div>
    <details class="card" ${a.started ? '' : 'open'}><summary>פרטי הדירה</summary>
      <div class="grid">${fields}
        ${select('view', 'נוף', VIEWS)}${select('cond', 'מצב תחזוקה', CONDS)}
        <fieldset class="wide"><legend>כיווני אוויר</legend><div class="chips">${DIRS.map((d) => `<label class="chip"><input type="checkbox" data-dir value="${d}" ${(a.dirs || []).includes(d) ? 'checked' : ''}>${d}</label>`).join('')}</div></fieldset>
        <label class="f wide"><span>הערות כלליות</span><textarea data-f="notes">${esc(a.notes)}</textarea></label>
      </div>
    </details>
    <details class="card" ${a.started ? '' : 'open'}><summary>הרכב הדירה</summary>
      <p class="small muted">רשימת הצילומים נבנית לפי ההרכב.</p>
      <div class="cfg">${COUNTS.map((c) => `<div class="f"><span>${c.t}</span><div class="stepper"><button type="button" data-act="dec" data-k="${c.k}" aria-label="פחות ${c.t}">−</button><output class="tnum" aria-live="polite">${a.cfg[c.k] || 0}</output><button type="button" data-act="inc" data-k="${c.k}" aria-label="עוד ${c.t}">+</button></div></div>`).join('')}</div>
      <fieldset><legend>הצמדות ותוספות</legend><div class="chips">${FLAGS.map((f) => `<label class="chip"><input type="checkbox" data-flag="${f.k}" ${a.cfg[f.k] ? 'checked' : ''}>${esc(f.t)}</label>`).join('')}</div></fieldset>
    </details>
    <details class="card guide"><summary>נוהל הצילום האחיד</summary>${RULES}</details>
    ${secs}
    <div class="card">
      <h2>סיום והפקה</h2>
      ${pr.missing.length ? `<p class="small">חסרים ${pr.missing.length} צילומי חובה:</p><ul class="small muted">${pr.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p class="small">כל צילומי החובה בוצעו.</p>'}
      <div class="row">
        <button class="btn ${a.done ? 'btn-s' : 'btn-l'}" type="button" data-act="done">${a.done ? 'ביטול סימון ההשלמה' : 'סימון הביקור כהושלם'}</button>
        <a class="btn btn-s" href="#/p/${p.id}/a/${a.id}/report">דוח לדירה</a>
        <button class="btn btn-s" type="button" data-act="zip-apt">קובץ מרוכז לדירה</button>
      </div>
      <button class="btn btn-d btn-sm" type="button" data-act="del-apt">מחיקת הדירה</button>
    </div>
  </section>
  <div class="dock"><div class="wrap">
    <div class="prog ${pr.have >= pr.need ? 'done' : ''}"><span class="tnum">${pr.have}/${pr.need}</span><div class="prog-track" role="progressbar" aria-label="צילומי חובה" aria-valuemin="0" aria-valuemax="${pr.need}" aria-valuenow="${pr.have}"><i style="width:${pr.pct}%"></i></div></div>
    <a class="btn btn-s btn-sm" href="#/p/${p.id}">לרשימת הדירות</a>
  </div></div>`;
}

/* ---------- report screen ---------- */
async function viewReport(pid, aid) {
  const p = await db.get('projects', pid);
  if (!p) return notFound();
  let apts, photos;
  if (aid) {
    const a = await db.get('apts', aid);
    if (!a) return notFound();
    apts = [a]; photos = await db.by('photos', 'aid', aid);
  } else {
    apts = sortApts(await db.by('apts', 'pid', pid)); photos = await db.by('photos', 'pid', pid);
  }
  const back = aid ? `#/p/${pid}/a/${aid}` : `#/p/${pid}`;
  main.innerHTML = `<section class="view wrap">
    <div class="row no-print"><a class="btn btn-s btn-sm" href="${back}">חזרה</a><button class="btn btn-p btn-sm" type="button" data-act="print">הדפסה או שמירה כקובץ</button></div>
    ${reportHTML(p, apts, (a) => photos.filter((x) => x.aid === a.id), (a, x) => url(x.thumb))}
  </section>`;
}

/* ---------------- events ---------------- */
async function setCfg(k, val) {
  const a = S.a;
  const old = a.cfg[k];
  const next = { ...a.cfg, [k]: val };
  const keep = new Set(buildPlan({ ...a, cfg: next }).map((e) => e.key));
  const lost = S.photos.filter((x) => !keep.has(x.slot.split('.')[0]));
  if (lost.length && !confirm(`השינוי יסיר ${lost.length} תמונות שכבר צולמו בחלק שיורד מהרשימה. להמשיך?`)) { if (typeof old === 'boolean') await rerender(); return; }
  for (const x of lost) await db.del('photos', x.id);
  a.cfg = next;
  saveApt();
  await rerender();
}

async function addPhotos(slot, files) {
  await saveApt.flush();
  const a = S.a, i = slotInfo(slot);
  let seq = Math.max(0, ...S.photos.filter((x) => x.slot === slot).map((x) => x.seq));
  main.classList.add('busy');
  let portrait = false;
  try {
    for (const f of files) {
      seq++;
      const at = f.lastModified || Date.now();
      const label = `${aptLabel(a)} · ${i.code} ${i.title} · ${i.shot.t}${seq > 1 ? ` (${seq})` : ''}`;
      toast(files.length > 1 ? `מעבד תמונה ${seq}…` : 'שומר את התמונה…', 10000);
      const r = await processImage(f, label, fmtDT(at));
      if (r.portrait && LANDSCAPE_SHOTS.has(i.shot.k)) portrait = true;
      const rec = { id: uid(), pid: a.pid, aid: a.id, slot, seq, at, w: r.w, h: r.h, blob: r.full, thumb: r.thumb };
      await db.put('photos', rec);
      S.photos.push(rec);
    }
    if (!a.started) a.started = Date.now();
    a.updated = Date.now();
    await db.put('apts', a);
    toast(portrait ? 'נשמר. שימו לב: התמונה צולמה לאורך, ולפי הנוהל מצלמים לרוחב.' : (files.length > 1 ? `נשמרו ${files.length} תמונות` : 'נשמר'), portrait ? 4500 : 1800);
  } catch (e) {
    console.error(e);
    toast('לא הצלחנו לשמור את התמונה. אולי נגמר המקום במכשיר.', 5000);
  } finally {
    main.classList.remove('busy');
  }
  await rerender();
}

function openPhoto(id) {
  const x = S.photos.find((p) => p.id === id);
  if (!x) return;
  const i = slotInfo(x.slot);
  const lb = $('#lb');
  $('#lb-img').src = url(x.blob);
  $('#lb-img').alt = `${i.title}, ${i.shot.t}`;
  $('#lb-cap').textContent = `${i.code} ${i.title} · ${i.shot.t} (${x.seq}) · ${fmtDT(x.at)}`;
  lb.dataset.id = id;
  lb.showModal();
}

main.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'shoot' || act === 'gallery') {
    S.slot = b.dataset.slot;
    $(act === 'shoot' ? '#in-cam' : '#in-gal').click();
  } else if (act === 'view') openPhoto(b.dataset.id);
  else if (act === 'inc' || act === 'dec') {
    const c = COUNTS.find((x) => x.k === b.dataset.k);
    const v = Math.max(0, Math.min(c.max, (S.a.cfg[c.k] || 0) + (act === 'inc' ? 1 : -1)));
    if (v !== S.a.cfg[c.k]) await setCfg(c.k, v);
  } else if (act === 'done') {
    const pr = progress(S.a, S.photos);
    if (!S.a.done && pr.missing.length && !confirm(`חסרים ${pr.missing.length} צילומי חובה. לסמן את הביקור כהושלם בכל זאת?`)) return;
    S.a.done = !S.a.done;
    S.a.finished = S.a.done ? Date.now() : null;
    saveApt();
    toast(S.a.done ? 'הביקור סומן כהושלם' : 'הסימון בוטל');
    await rerender();
  } else if (act === 'zip-apt') {
    await saveApt.flush();
    b.disabled = true;
    try { await exportZip(S.p, [S.a], `${outName(S.a.building && `b${S.a.building}`, S.a.entrance && `e${S.a.entrance}`, `apt${S.a.number}`)}.zip`); } finally { b.disabled = false; }
  } else if (act === 'zip-proj') {
    b.disabled = true;
    try { await exportZip(S.p, S.projApts, `${outName('project')}.zip`); } finally { b.disabled = false; }
  } else if (act === 'csv') {
    const blob = new Blob([csvOf(S.projApts, (a) => S.projPhotos.filter((x) => x.aid === a.id))], { type: 'text/csv;charset=utf-8' });
    download(blob, `${outName('summary')}.csv`);
  } else if (act === 'print') window.print();
  else if (act === 'goto-add') { $('#add').scrollIntoView({ behavior: 'smooth' }); $('#add input').focus({ preventScroll: true }); }
  else if (act === 'import') $('#in-zip').click();
  else if (act === 'del-apt') {
    if (!confirm(`למחוק את ${aptLabel(S.a)} ואת כל ${S.photos.length} התמונות שלה? אי אפשר לבטל.`)) return;
    await db.delBy('photos', 'aid', S.a.id);
    await db.del('apts', S.a.id);
    const pid = S.a.pid; S.a = null;
    location.hash = `#/p/${pid}`;
  } else if (act === 'del-proj') {
    if (!confirm(`למחוק את הפרויקט "${S.p.name}" עם כל הדירות והתמונות מהמכשיר? אי אפשר לבטל. כדאי להוריד קובץ מרוכז לפני כן.`)) return;
    await deleteProject(S.p.id);
    S.p = null;
    location.hash = '#/';
  }
});

main.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.f !== undefined && S.a) { S.a[t.dataset.f] = t.value; saveApt(); }
  else if (t.dataset.note !== undefined && S.a) { (S.a.secs[t.dataset.note] ||= {}).note = t.value; saveApt(); }
  else if (t.dataset.pf !== undefined && S.p) { S.p[t.dataset.pf] = t.value; saveProj(); }
  else if (t.id === 'q') {
    const q = t.value.trim().toLowerCase();
    $$('#apts > li').forEach((li) => { li.hidden = q && !li.dataset.q.includes(q); });
  }
});

main.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (!S.a) return;
  if (t.dataset.f !== undefined) { S.a[t.dataset.f] = t.value; saveApt(); }
  else if (t.hasAttribute('data-dir')) { S.a.dirs = $$('[data-dir]:checked').map((x) => x.value); saveApt(); }
  else if (t.dataset.na !== undefined) { (S.a.secs[t.dataset.na] ||= {}).na = t.checked; saveApt(); await rerender(); }
  else if (t.dataset.flag !== undefined) await setCfg(t.dataset.flag, t.checked);
});

main.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]');
  if (!f) return;
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(f).entries());
  Object.keys(d).forEach((k) => { d[k] = String(d[k]).trim(); });
  const kind = f.dataset.form;
  if (kind === 'new-proj') {
    if (!d.name) return;
    const p = { id: uid(), name: d.name, address: d.address, appraiser: d.appraiser, created: Date.now() };
    await db.put('projects', p);
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* optional */ }
    location.hash = `#/p/${p.id}`;
  } else if (kind === 'add-apt') {
    if (!d.number) return;
    const a = newApt(S.p.id, { building: d.building, entrance: d.entrance, floor: d.floor, number: d.number, owner: d.owner });
    await db.put('apts', a);
    location.hash = `#/p/${S.p.id}/a/${a.id}`;
  } else if (kind === 'add-range') {
    const from = parseInt(d.from, 10), to = parseInt(d.to, 10), per = parseInt(d.per, 10) || 0;
    if (!(from > 0 && to >= from) || to - from > 400) { toast('צריך טווח תקין, עד 400 דירות בפעם אחת'); return; }
    const have = new Set(S.projApts.filter((a) => (a.building || '') === d.building && (a.entrance || '') === d.entrance).map((a) => String(a.number)));
    let n = 0;
    for (let i = from; i <= to; i++) {
      if (have.has(String(i))) continue;
      const floor = per ? String((parseInt(d.f0, 10) || 0) + Math.floor((i - from) / per)) : '';
      await db.put('apts', newApt(S.p.id, { building: d.building, entrance: d.entrance, number: String(i), floor, created: Date.now() + i }));
      n++;
    }
    toast(`נוספו ${n} דירות`);
    await rerender();
  }
});

const onFiles = async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (files.length && S.slot && S.a) await addPhotos(S.slot, files);
};
$('#in-cam').addEventListener('change', onFiles);
$('#in-gal').addEventListener('change', onFiles);
$('#in-zip').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) await importZip(f);
});

$('#lb-close').addEventListener('click', () => $('#lb').close());
$('#lb').addEventListener('click', (ev) => { if (ev.target === $('#lb')) $('#lb').close(); });
$('#lb-del').addEventListener('click', async () => {
  const id = $('#lb').dataset.id;
  if (!confirm('למחוק את התמונה?')) return;
  await db.del('photos', id);
  S.photos = S.photos.filter((x) => x.id !== id);
  $('#lb').close();
  toast('התמונה נמחקה');
  await rerender();
});

const net = () => { $('#net').hidden = navigator.onLine; };
addEventListener('online', net);
addEventListener('offline', net);
addEventListener('pagehide', () => { saveApt.flush(); saveProj.flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveApt.flush(); saveProj.flush(); } });
addEventListener('hashchange', go);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

net();
render();

})();
