const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { fileTypeFromFile } = require('file-type');
const requireSupabaseUser = require('../middleware/supabase-auth.cjs');

const router = express.Router();
const uploadRoot = path.resolve(__dirname, process.env.UPLOAD_DIR || '../uploads');
const maxAllowedBytes = 50 * 1024 * 1024;
const photoLimit = Math.min(maxAllowedBytes, Math.max(1, Number(process.env.MAX_PHOTO_MB || 8)) * 1024 * 1024);
const videoLimit = Math.min(maxAllowedBytes, Math.max(1, Number(process.env.MAX_VIDEO_MB || 50)) * 1024 * 1024);
const allowed = {
  photo: new Set(['image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/webm'])
};
const profileFields = 'id,username,display_name,avatar_url,cover_url,status_text,is_private';

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try {
      await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 });
      callback(null, uploadRoot);
    } catch (error) { callback(error); }
  },
  filename: (_req, _file, callback) => callback(null, crypto.randomUUID() + '.upload')
});

function uploaderFor(mediaType) {
  return multer({
    storage,
    limits: { fileSize: mediaType === 'photo' ? photoLimit : videoLimit, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (!allowed[mediaType] || !allowed[mediaType].has(file.mimetype)) {
        return callback(new Error('Format de fichier non accepté.'));
      }
      return callback(null, true);
    }
  });
}

async function resultJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || 'Erreur Supabase.');
    error.status = response.status;
    throw error;
  }
  return data;
}

router.use(requireSupabaseUser);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireUuidParam(param) {
  return (req, res, next) => {
    if (!uuidPattern.test(req.params[param] || '')) return res.status(400).json({ error: 'Identifiant invalide.' });
    return next();
  };
}

router.get('/me', async (req, res, next) => {
  try {
    const q = new URLSearchParams({ select: profileFields, id: 'eq.' + req.user.id, limit: '1' });
    const rows = await resultJson(await req.supabaseRest('profiles?' + q));
    if (!rows?.length) return res.status(404).json({ error: 'Profil SSPACE introuvable.' });
    return res.set('Cache-Control', 'no-store').json({ profile: rows[0] });
  } catch (error) { return next(error); }
});

router.get('/:userId', requireUuidParam('userId'), async (req, res, next) => {
  try {
    const q = new URLSearchParams({ select: profileFields, id: 'eq.' + req.params.userId, limit: '1' });
    const rows = await resultJson(await req.supabaseRest('profiles?' + q));
    if (!rows?.length) return res.status(404).json({ error: 'Profil introuvable ou privé.' });
    return res.set('Cache-Control', 'no-store').json({ profile: rows[0] });
  } catch (error) { return next(error); }
});

router.get('/:userId/media', requireUuidParam('userId'), async (req, res, next) => {
  try {
    const q = new URLSearchParams({
      select: 'id,owner_id,media_type,mime_type,size_bytes,created_at',
      owner_id: 'eq.' + req.params.userId,
      order: 'created_at.desc',
      limit: '100'
    });
    const rows = await resultJson(await req.supabaseRest('profile_media?' + q));
    const media = (rows || []).map(({ owner_id, ...item }) => ({
      ...item,
      content_url: '/api/profil/media/' + item.id + '/content'
    }));
    return res.set('Cache-Control', 'no-store').json({ media });
  } catch (error) { return next(error); }
});

router.post('/me/:mediaType', (req, res, next) => {
  const mediaType = req.params.mediaType;
  if (!['photo', 'video'].includes(mediaType)) return res.status(400).json({ error: 'Type de média invalide.' });

  uploaderFor(mediaType).single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Fichier trop volumineux.' : uploadError.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant (champ « file »).' });

    try {
      const detected = await fileTypeFromFile(req.file.path);
      if (!detected || !allowed[mediaType].has(detected.mime)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(415).json({ error: 'Le contenu réel du fichier ne correspond pas à un format autorisé.' });
      }

      const payload = {
        owner_id: req.user.id,
        media_type: mediaType,
        storage_key: path.basename(req.file.filename),
        mime_type: detected.mime,
        size_bytes: req.file.size
      };
      const rows = await resultJson(await req.supabaseRest('profile_media', {
        method: 'POST',
        body: JSON.stringify(payload)
      }));
      if (!rows?.length) throw new Error('Supabase n’a pas retourné le média créé.');
      return res.status(201).json({
        media: { ...rows[0], content_url: '/api/profil/media/' + rows[0].id + '/content' }
      });
    } catch (error) {
      await fs.unlink(req.file.path).catch(() => {});
      return next(error);
    }
  });
});

router.get('/media/:mediaId/content', requireUuidParam('mediaId'), async (req, res, next) => {
  try {
    const q = new URLSearchParams({ select: 'storage_key,mime_type', id: 'eq.' + req.params.mediaId, limit: '1' });
    const rows = await resultJson(await req.supabaseRest('profile_media?' + q));
    if (!rows?.length) return res.status(404).json({ error: 'Fichier introuvable.' });

    const filePath = path.join(uploadRoot, path.basename(rows[0].storage_key));
    await fs.access(filePath);
    res.set({
      'Content-Type': rows[0].mime_type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline'
    });
    return res.sendFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Fichier absent du stockage.' });
    return next(error);
  }
});

router.delete('/media/:mediaId', requireUuidParam('mediaId'), async (req, res, next) => {
  try {
    const q = new URLSearchParams({
      select: 'storage_key',
      id: 'eq.' + req.params.mediaId,
      owner_id: 'eq.' + req.user.id
    });
    const rows = await resultJson(await req.supabaseRest('profile_media?' + q, { method: 'DELETE' }));
    if (!rows?.length) return res.status(404).json({ error: 'Fichier introuvable.' });
    const filePath = path.join(uploadRoot, path.basename(rows[0].storage_key));
    await fs.unlink(filePath).catch(() => {});
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

module.exports = router;