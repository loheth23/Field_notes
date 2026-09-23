// Field Notes — multi-user Node.js backend
// Accounts, sessions, text notes and images are stored on this server.
// For production, use persistent storage/volume and HTTPS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_DIR = path.join(DATA_DIR, 'users');

fs.mkdirSync(USERS_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}', 'utf8');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const EXT_FROM_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
};
const sessions = new Map();

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}
function safeUsername(username) {
  return username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function safeTextFilename(text) {
  let name = text.normalize('NFKC').trim().split(/\s+/)[0]
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!name) name = 'note';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = `note-${name}`;
  return name;
}
function userDir(username) {
  return path.join(USERS_DIR, username);
}
function notesDir(username) {
  return path.join(userDir(username), 'notes');
}
function uploadsDir(username) {
  return path.join(userDir(username), 'uploads');
}
function ensureUserDirs(username) {
  fs.mkdirSync(notesDir(username), { recursive: true });
  fs.mkdirSync(uploadsDir(username), { recursive: true });
}
function uniqueNoteFile(username, baseName) {
  let filename = `${baseName}.txt`, n = 2;
  while (fs.existsSync(path.join(notesDir(username), filename))) {
    filename = `${baseName}-${n}.txt`; n++;
  }
  return filename;
}
function cookieOptions(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req.headers.cookie).field_notes_session;
  return sid ? sessions.get(sid) : null;
}
function requireUser(req, res) {
  const username = currentUser(req);
  if (!username) { sendJSON(res, 401, { error: 'Not logged in' }); return null; }
  return username;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJSON(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}
function readBody(req, limitBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limitBytes) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function saveImage(dataUrl, username, baseName) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m || !EXT_FROM_MIME[m[1]]) throw new Error('Unsupported image format');
  const filename = `${baseName || crypto.randomUUID()}${EXT_FROM_MIME[m[1]]}`;
  fs.writeFileSync(path.join(uploadsDir(username), filename), Buffer.from(m[2], 'base64'));
  return `/uploads/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`;
}
function readClips(username) {
  ensureUserDirs(username);
  const clips = [];
  const dir = notesDir(username);
  for (const filename of fs.readdirSync(dir)) {
    if (!filename.endsWith('.txt')) continue;
    const stat = fs.statSync(path.join(dir, filename));
    const id = filename.slice(0, -4);
    let image = null;
    for (const ext of IMAGE_EXTENSIONS) {
      const img = path.join(uploadsDir(username), id + ext);
      if (fs.existsSync(img)) { image = `/uploads/${encodeURIComponent(username)}/${encodeURIComponent(id + ext)}`; break; }
    }
    clips.push({ id, text: fs.readFileSync(path.join(dir, filename), 'utf8') || null, image, created: stat.birthtimeMs || stat.mtimeMs });
  }
  for (const filename of fs.readdirSync(uploadsDir(username))) {
    const ext = path.extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    const id = filename.slice(0, -ext.length);
    if (clips.some(c => c.id === id)) continue;
    const stat = fs.statSync(path.join(uploadsDir(username), filename));
    clips.push({ id, text: null, image: `/uploads/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`, created: stat.birthtimeMs || stat.mtimeMs });
  }
  return clips.sort((a, b) => b.created - a.created);
}
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(id);
}
function serveStatic(res, baseDir, requestedPath) {
  const decoded = decodeURIComponent(requestedPath);
  const filePath = path.resolve(baseDir, '.' + decoded);
  if (!filePath.startsWith(path.resolve(baseDir) + path.sep) && filePath !== path.resolve(baseDir)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname === '/api/signup' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const username = safeUsername(body.username || '');
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length < 3) return sendJSON(res, 400, { error: 'Username must be at least 3 letters/numbers.' });
      if (password.length < 4) return sendJSON(res, 400, { error: 'Password must be at least 4 characters.' });
      const users = readUsers();
      if (users[username]) return sendJSON(res, 409, { error: 'That username already exists.' });
      const { salt, hash } = hashPassword(password);
      users[username] = { salt, hash, created: Date.now() };
      writeUsers(users); ensureUserDirs(username);
      const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, username);
      return sendJSON(res, 201, { username }, { 'Set-Cookie': cookieOptions('field_notes_session', sid, 60 * 60 * 24 * 30) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const username = safeUsername(body.username || ''); const password = typeof body.password === 'string' ? body.password : '';
      const user = readUsers()[username];
      if (!user || !verifyPassword(password, user.salt, user.hash)) return sendJSON(res, 401, { error: 'Invalid username or password.' });
      const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, username);
      return sendJSON(res, 200, { username }, { 'Set-Cookie': cookieOptions('field_notes_session', sid, 60 * 60 * 24 * 30) });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const sid = parseCookies(req.headers.cookie).field_notes_session; if (sid) sessions.delete(sid);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookieOptions('field_notes_session', '', 0) });
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      const username = currentUser(req); return sendJSON(res, 200, { loggedIn: !!username, username: username || null });
    }
    if (pathname === '/api/clips' && req.method === 'GET') {
      const username = requireUser(req, res); if (!username) return;
      return sendJSON(res, 200, readClips(username));
    }
    if (pathname === '/api/clips' && req.method === 'POST') {
      const username = requireUser(req, res); if (!username) return;
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text && !payload.image) return sendJSON(res, 400, { error: 'A clip needs text, an image, or both.' });
      ensureUserDirs(username);
      let filename = null, imagePath = null;
      if (text) {
        filename = uniqueNoteFile(username, safeTextFilename(text));
        fs.writeFileSync(path.join(notesDir(username), filename), text, 'utf8');
      }
      if (payload.image) {
        try { imagePath = saveImage(payload.image, username, filename ? filename.slice(0, -4) : null); }
        catch (e) { if (filename) fs.unlinkSync(path.join(notesDir(username), filename)); return sendJSON(res, 400, { error: e.message }); }
      }
      const id = filename ? filename.slice(0, -4) : path.basename(imagePath).split('.')[0];
      return sendJSON(res, 201, { id, text: text || null, image: imagePath, created: Date.now() });
    }
    if (pathname.startsWith('/api/clips/') && req.method === 'DELETE') {
      const username = requireUser(req, res); if (!username) return;
      const id = decodeURIComponent(pathname.slice('/api/clips/'.length));
      if (!safeId(id)) return sendJSON(res, 400, { error: 'Invalid clip id.' });
      fs.rmSync(path.join(notesDir(username), `${id}.txt`), { force: true });
      for (const ext of IMAGE_EXTENSIONS) fs.rmSync(path.join(uploadsDir(username), id + ext), { force: true });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname.startsWith('/uploads/')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length !== 3) return send(res, 404, 'Not found');
      const username = decodeURIComponent(parts[1]); const filename = decodeURIComponent(parts[2]);
      const loggedIn = currentUser(req);
      if (!loggedIn || loggedIn !== username || !/^[A-Za-z0-9._-]+$/.test(filename)) return send(res, 403, 'Forbidden');
      return serveStatic(res, uploadsDir(username), '/' + filename);
    }
    if (req.method === 'GET') return serveStatic(res, PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
    return send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Field Notes server running at http://localhost:${PORT}`));
