require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const { JWT_SECRET, SSPACE_SHARED_SECRET, ALLOWED_ORIGIN, PORT = 3000 } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET (32 caractères minimum) est requis dans .env');
  process.exit(1);
}

const DATA_DIR = path.dirname(path.resolve(process.env.DB_PATH || './data/messenger.db'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
try { if (process.env.ICE_SERVERS) ICE = JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS invalide, STUN par défaut'); }

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
    },
  },
}));
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)'); next(); });
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const now = () => Date.now();
const online = new Map(); // userId -> nombre de sockets connectés
const signToken = (u) => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, username: u.username, display_name: u.display_name });
const MSG = 'id,conversation_id,sender_id,body,kind,media,duration,created_at';

const st = {
  userById: db.prepare('SELECT * FROM users WHERE id=?'),
  userByName: db.prepare('SELECT * FROM users WHERE username=?'),
  userBySspace: db.prepare('SELECT * FROM users WHERE sspace_id=?'),
  insertUser: db.prepare('INSERT INTO users(username,display_name,pass_hash,sspace_id,created_at) VALUES(?,?,?,?,?)'),
  isMember: db.prepare('SELECT 1 FROM members WHERE conversation_id=? AND user_id=?'),
  memberIds: db.prepare('SELECT user_id FROM members WHERE conversation_id=?'),
  members: db.prepare('SELECT u.id,u.display_name,u.last_seen FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=?'),
  isBlocked: db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)'),
  insertMsg: db.prepare('INSERT INTO messages(conversation_id,sender_id,body,kind,media,duration,created_at) VALUES(?,?,?,?,?,?,?)'),
  msgById: db.prepare(`SELECT ${MSG} FROM messages WHERE id=?`),
  markRead: db.prepare('UPDATE members SET last_read_id=MAX(last_read_id,?) WHERE conversation_id=? AND user_id=?'),
  convById: db.prepare('SELECT id,is_group FROM conversations WHERE id=?'),
  convByKey: db.prepare('SELECT id FROM conversations WHERE direct_key=?'),
  upload: db.prepare('SELECT * FROM uploads WHERE file=?'),
  freeUpload: db.prepare('SELECT * FROM uploads WHERE file=? AND user_id=? AND used=0'),
  useUpload: db.prepare('UPDATE uploads SET used=1 WHERE file=?'),
  mediaAccess: db.prepare('SELECT 1 FROM messages m JOIN members mm ON mm.conversation_id=m.conversation_id WHERE m.media=? AND mm.user_id=? LIMIT 1'),
  contacts: db.prepare('SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.conversation_id=m2.conversation_id WHERE m1.user_id=? AND m2.user_id!=?'),
};

const createConversation = db.transaction((title, isGroup, key, ids) => {
  const cid = db
    .prepare('INSERT INTO conversations(title,is_group,direct_key,created_at) VALUES(?,?,?,?)')
    .run(title, isGroup ? 1 : 0, key, now()).lastInsertRowid;
  const ins = db.prepare('INSERT INTO members(conversation_id,user_id) VALUES(?,?)');
  ids.forEach((id) => ins.run(cid, id));
  return Number(cid);
});
const insertMessageWithMedia = db.transaction((cid, uid, body, kind, media, duration) => {
  const id = st.insertMsg.run(cid, uid, body, kind, media, duration, now()).lastInsertRowid;
  if (media) st.useUpload.run(media);
  st.markRead.run(id, cid, uid);
  return st.msgById.get(id);
});

/* ---------- Authentification ---------- */
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/i.test(username || ''))
    return res.status(400).json({ error: 'Nom d’utilisateur : 3 à 20 lettres, chiffres ou _' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 100)
    return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  if (st.userByName.get(username)) return res.status(409).json({ error: 'Ce nom est déjà pris' });
  const name = String(displayName || username).trim().slice(0, 40) || username;
  const hash = await bcrypt.hash(password, 12);
  const info = st.insertUser.run(username, name, hash, null, now());
  const u = st.userById.get(info.lastInsertRowid);
  res.json({ token: signToken(u), user: publicUser(u) });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const u = typeof username === 'string' ? st.userByName.get(username) : null;
  const ok = u && u.pass_hash && typeof password === 'string' && (await bcrypt.compare(password, u.pass_hash));
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });
  res.json({ token: signToken(u), user: publicUser(u) });
});

// Connexion unique : SSpace signe un jeton court (HS256) avec le secret partagé.
// Contenu attendu : { sub: "<id SSpace>", username, name, exp }
app.post('/api/sso', authLimiter, (req, res) => {
  if (!SSPACE_SHARED_SECRET) return res.status(501).json({ error: 'SSO non configuré' });
  try {
    const p = jwt.verify(String(req.body?.token || ''), SSPACE_SHARED_SECRET, { algorithms: ['HS256'] });
    const sid = String(p.sub || '');
    if (!sid) throw new Error('sub manquant');
    let u = st.userBySspace.get(sid);
    if (!u) {
      const base = String(p.username || 'user' + sid).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'user';
      let name = base, i = 1;
      while (st.userByName.get(name)) name = base + i++;
      const info = st.insertUser.run(name, String(p.name || name).slice(0, 40), null, sid, now());
      u = st.userById.get(info.lastInsertRowid);
    }
    res.json({ token: signToken(u), user: publicUser(u) });
  } catch {
    res.status(401).json({ error: 'Jeton SSpace invalide' });
  }
});

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const { uid } = jwt.verify(t, JWT_SECRET);
    const u = st.userById.get(uid);
    if (!u) throw new Error('inconnu');
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'Non connecté' });
  }
}

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));
app.get('/api/ice', auth, (req, res) => res.json(ICE));

/* ---------- Utilisateurs, conversations, messages ---------- */
app.get('/api/users', auth, (req, res) => {
  const s = String(req.query.q || '').trim().slice(0, 30).replace(/[\\%_]/g, '\\$&');
  if (!s) return res.json([]);
  const rows = db
    .prepare("SELECT id,username,display_name FROM users WHERE id!=? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') LIMIT 10")
    .all(req.user.id, s + '%', '%' + s + '%');
  res.json(rows);
});

app.get('/api/conversations', auth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(`SELECT c.id,c.title,c.is_group,
      (SELECT COUNT(*) FROM messages x WHERE x.conversation_id=c.id AND x.id>m.last_read_id AND x.sender_id!=@uid) AS unread,
      COALESCE((SELECT MIN(o.last_read_id) FROM members o WHERE o.conversation_id=c.id AND o.user_id!=@uid),0) AS others_read,
      (SELECT MAX(x.id) FROM messages x WHERE x.conversation_id=c.id) AS last_id
      FROM conversations c JOIN members m ON m.conversation_id=c.id AND m.user_id=@uid`)
    .all({ uid });
  const out = rows
    .map((c) => ({
      id: c.id, title: c.title, is_group: !!c.is_group, unread: c.unread, others_read: c.others_read,
      members: st.members.all(c.id).map((m) => ({ ...m, online: online.has(m.id) })),
      last: c.last_id ? st.msgById.get(c.last_id) : null,
    }))
    .sort((a, b) => (b.last?.id || 0) - (a.last?.id || 0) || b.id - a.id);
  res.json(out);
});

app.post('/api/conversations', auth, (req, res) => {
  const uid = req.user.id;
  const { userId, title, userIds } = req.body || {};
  if (userId) {
    const other = st.userById.get(Number(userId));
    if (!other || other.id === uid) return res.status(400).json({ error: 'Utilisateur invalide' });
    if (st.isBlocked.get(uid, other.id, other.id, uid)) return res.status(403).json({ error: 'Conversation impossible' });
    const key = [uid, other.id].sort((a, b) => a - b).join(':');
    const existing = st.convByKey.get(key);
    return res.json({ id: existing ? existing.id : createConversation(null, false, key, [uid, other.id]) });
  }
  const name = typeof title === 'string' ? title.trim().slice(0, 60) : '';
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))].filter((i) => i && i !== uid && st.userById.get(i));
  if (!name || ids.length < 2 || ids.length > 49) return res.status(400).json({ error: 'Groupe : un titre et 2 à 49 membres' });
  res.json({ id: createConversation(name, true, null, [uid, ...ids]) });
});

app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const cid = Number(req.params.id);
  if (!st.isMember.get(cid, req.user.id)) return res.status(404).json({ error: 'Introuvable' });
  const before = Number(req.query.before) || 0;
  const rows = db
    .prepare(`SELECT ${MSG} FROM messages WHERE conversation_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 50`)
    .all(cid, before, before);
  res.json(rows.reverse());
});

app.post('/api/blocks', auth, (req, res) => {
  const target = st.userById.get(Number(req.body?.userId));
  if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Utilisateur invalide' });
  db.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) VALUES(?,?)').run(req.user.id, target.id);
  res.json({ ok: true });
});

app.delete('/api/blocks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Photos, vidéos, messages vocaux ---------- */
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post('/api/upload', auth, uploadLimiter, express.raw({ type: () => true, limit: MAX_MB + 'mb' }), (req, res) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[mime];
  if (!ext) return res.status(415).json({ error: 'Format non pris en charge' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Fichier vide' });
  const file = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'voice';
  db.prepare('INSERT INTO uploads(file,user_id,kind,mime,used,created_at) VALUES(?,?,?,?,0,?)').run(file, req.user.id, kind, mime, now());
  res.json({ file, kind });
});

// Les médias ne sont accessibles qu’aux membres de la conversation (jeton dans l’en-tête).
app.get('/api/media/:file', auth, (req, res) => {
  const f = req.params.file;
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(f)) return res.status(404).end();
  const up = st.upload.get(f);
  if (!up || !(up.user_id === req.user.id || st.mediaAccess.get(f, req.user.id))) return res.status(404).end();
  res.type(up.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(f, { root: UPLOAD_DIR });
});

// Nettoyage des fichiers envoyés mais jamais utilisés dans un message (> 1 h)
setInterval(() => {
  const old = db.prepare('SELECT file FROM uploads WHERE used=0 AND created_at<?').all(now() - 3600 * 1000);
  for (const { file } of old) {
    fs.rm(path.join(UPLOAD_DIR, file), { force: true }, () => {});
    db.prepare('DELETE FROM uploads WHERE file=?').run(file);
  }
}, 3600 * 1000).unref();

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `Fichier trop volumineux (max ${MAX_MB} Mo)` });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

/* ---------- Temps réel ---------- */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN || false }, maxHttpBufferSize: 1e5 });

io.use((socket, next) => {
  try {
    const { uid } = jwt.verify(String(socket.handshake.auth?.token || ''), JWT_SECRET);
    const u = st.userById.get(uid);
    if (!u) throw new Error('inconnu');
    socket.user = u;
    next();
  } catch {
    next(new Error('Non autorisé'));
  }
});

const broadcastPresence = (uid, isOnline, lastSeen) =>
  st.contacts.all(uid, uid).forEach(({ id }) => io.to('u:' + id).emit('presence', { userId: uid, online: isOnline, lastSeen }));

const makeBucket = (max, msPerToken) => {
  let tokens = max, last = now();
  return () => {
    const t = now();
    tokens = Math.min(max, tokens + (t - last) / msPerToken);
    last = t;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
};

/* Appels 1-à-1 (signalisation WebRTC : le média passe directement entre les téléphones) */
const calls = new Map(); // callId -> { id, cid, caller, callee, video, answeredAt, timer }
const inCall = (uid) => [...calls.values()].some((c) => c.caller === uid || c.callee === uid);
const fmtDur = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };

function endCall(call, reason) {
  if (!calls.delete(call.id)) return;
  clearTimeout(call.timer);
  io.to('u:' + call.caller).to('u:' + call.callee).emit('call:end', { callId: call.id, reason });
  const label = call.video ? '📹 Appel vidéo' : '📞 Appel vocal';
  const body = call.answeredAt
    ? `${label} · ${fmtDur(now() - call.answeredAt)}`
    : reason === 'declined' ? `${label} refusé` : `${label} manqué`;
  const msg = insertMessageWithMedia(call.cid, call.caller, body, 'call', null, null);
  [call.caller, call.callee].forEach((u) => io.to('u:' + u).emit('message:new', msg));
}

io.on('connection', (socket) => {
  const uid = socket.user.id;
  socket.join('u:' + uid);
  const n = (online.get(uid) || 0) + 1;
  online.set(uid, n);
  if (n === 1) broadcastPresence(uid, true, null);

  const allow = makeBucket(20, 500);       // messages, saisie
  const allowSignal = makeBucket(300, 20); // signalisation d’appel (beaucoup de candidats ICE)
  const toMembers = (cid, ev, payload, exceptSelf) =>
    st.memberIds.all(cid).forEach(({ user_id }) => {
      if (!(exceptSelf && user_id === uid)) io.to('u:' + user_id).emit(ev, payload);
    });

  socket.on('message:send', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (!allow()) return ack({ error: 'Trop de messages, ralentis un peu' });
    const cid = Number(data?.conversationId);
    const body = typeof data?.body === 'string' ? data.body.trim() : '';
    if (body.length > 4000) return ack({ error: 'Message trop long' });
    if (!st.isMember.get(cid, uid)) return ack({ error: 'Conversation introuvable' });
    const conv = st.convById.get(cid);
    if (!conv.is_group) {
      const other = st.memberIds.all(cid).find((m) => m.user_id !== uid);
      if (other && st.isBlocked.get(uid, other.user_id, other.user_id, uid)) return ack({ error: 'Message impossible' });
    }
    let kind = 'text', media = null, duration = null;
    if (data?.upload) {
      const up = st.freeUpload.get(String(data.upload), uid);
      if (!up) return ack({ error: 'Fichier introuvable' });
      kind = up.kind;
      media = up.file;
      duration = kind === 'text' || kind === 'image' ? null : Math.max(0, Math.min(Number(data.duration) || 0, 600000));
    } else if (!body) {
      return ack({ error: 'Message vide' });
    }
    toMembers(cid, 'message:new', insertMessageWithMedia(cid, uid, body, kind, media, duration), false);
    ack({ ok: true });
  });

  socket.on('message:read', (data) => {
    const cid = Number(data?.conversationId), upTo = Number(data?.upToId);
    if (!cid || !upTo || !st.isMember.get(cid, uid)) return;
    st.markRead.run(upTo, cid, uid);
    toMembers(cid, 'message:read', { conversationId: cid, userId: uid, upToId: upTo }, false);
  });

  socket.on('typing', (data) => {
    const cid = Number(data?.conversationId);
    if (!cid || !allow() || !st.isMember.get(cid, uid)) return;
    toMembers(cid, 'typing', { conversationId: cid, userId: uid, typing: !!data.typing }, true);
  });

  /* --- appels --- */
  socket.on('call:invite', (d, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const cid = Number(d?.conversationId);
    if (!st.isMember.get(cid, uid)) return ack({ error: 'Conversation introuvable' });
    const conv = st.convById.get(cid);
    if (!conv || conv.is_group) return ack({ error: 'Appels : discussions privées uniquement' });
    const other = st.memberIds.all(cid).find((m) => m.user_id !== uid)?.user_id;
    if (!other) return ack({ error: 'Conversation introuvable' });
    if (st.isBlocked.get(uid, other, other, uid)) return ack({ error: 'Appel impossible' });
    if (!online.has(other)) return ack({ error: 'Cette personne est hors ligne' });
    if (inCall(uid) || inCall(other)) return ack({ error: 'Ligne occupée' });
    const id = crypto.randomUUID();
    const call = { id, cid, caller: uid, callee: other, video: !!d.video, answeredAt: 0 };
    call.timer = setTimeout(() => endCall(call, 'missed'), 40000);
    calls.set(id, call);
    io.to('u:' + other).emit('call:incoming', {
      callId: id, conversationId: cid, video: call.video, from: { id: uid, name: socket.user.display_name },
    });
    ack({ ok: true, callId: id });
  });

  socket.on('call:answer', (d) => {
    const call = calls.get(d?.callId);
    if (!call || call.callee !== uid) return;
    if (d.accept) {
      clearTimeout(call.timer);
      call.answeredAt = now();
      socket.to('u:' + uid).emit('call:handled', { callId: call.id }); // coupe la sonnerie des autres appareils
      io.to('u:' + call.caller).emit('call:accepted', { callId: call.id });
    } else {
      endCall(call, 'declined');
    }
  });

  socket.on('call:signal', (d) => {
    const call = calls.get(d?.callId);
    if (!call || !allowSignal()) return;
    const to = call.caller === uid ? call.callee : call.callee === uid ? call.caller : null;
    if (!to || JSON.stringify(d.data || '').length > 20000) return;
    io.to('u:' + to).emit('call:signal', { callId: call.id, data: d.data });
  });

  socket.on('call:end', (d) => {
    const call = calls.get(d?.callId);
    if (!call || (call.caller !== uid && call.callee !== uid)) return;
    endCall(call, call.answeredAt ? 'ended' : call.caller === uid ? 'cancelled' : 'declined');
  });

  socket.on('disconnect', () => {
    const left = (online.get(uid) || 1) - 1;
    if (left > 0) return online.set(uid, left);
    online.delete(uid);
    const ts = now();
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(ts, uid);
    calls.forEach((c) => { if (c.caller === uid || c.callee === uid) endCall(c, 'ended'); });
    broadcastPresence(uid, false, ts);
  });
});

server.listen(PORT, () => console.log(`SSpace Messenger sur http://localhost:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
