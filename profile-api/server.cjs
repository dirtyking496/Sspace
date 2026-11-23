const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db.cjs');

const app = express();
const port = Number(process.env.PORT || 3000);
const origins = (process.env.FRONTEND_ORIGINS || 'https://sspaceweb.vercel.app')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(new Error('Origine non autorisée.'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'sspace-profile-api' });
});
app.use('/api/profil', require('./routes/profil.cjs'));
app.use((_req, res) => res.status(404).json({ error: 'Route introuvable.' }));
app.use((error, _req, res, _next) => {
  console.error('SSPACE API error:', error.message);
  if (error.message === 'Origine non autorisée.') {
    return res.status(403).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Erreur serveur.' });
});

const server = app.listen(port, () => {
  console.log('SSPACE Profile API écoute sur le port ' + port);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    try {
      await pool.end();
      process.exit(0);
    } catch (error) {
      console.error('Erreur fermeture PostgreSQL:', error.message);
      process.exit(1);
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);