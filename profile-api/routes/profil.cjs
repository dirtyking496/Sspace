const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { fileTypeFromFile } = require('file-type');
const db = require('../db.cjs');
const requireSupabaseUser = require('../middleware/supabase-auth.cjs');

const router = express.Router();
const uploadRoot = path.resolve(__dirname, process.env.UPLOAD_DIR || '../uploads');
const maxAllowedBytes = 50 * 1024 * 1024;
const photoLimit = Math.min(
  maxAllowedBytes,
  Math.max(1, Number(process.env.MAX_PHOTO_MB || 8)) * 1024 * 1024
);
const videoLimit = Math.min(
  maxAllowedBytes,
  Math.max(1, Number(process.env.MAX_VIDEO_MB || 50)) * 1024 * 1024
);
const allowed = {
  photo: new Set(['image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/webm'])
};

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try {
      await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 });
      callback(null, uploadRoot);
    } catch (error) {
      callback(error);
    }
  },
  filename: (_req, _file, callback) => {
    callback(null, crypto.randomUUID() + '.upload');
  }
});

function uploaderFor(mediaType) {
  return multer({
    storage,
    limits: {
      fileSize: mediaType === 'photo' ? photoLimit : videoLimit,
      files: 1
    },
    fileFilter: (_req, file, callback) => {
      if (!allowed[mediaType] || !allowed[mediaType].has(file.mimetype)) {
        return callback(new Error('Format de fichier non accepté.'));
      }
      return callback(null, true);
    }
  });
}

router.use(requireSupabaseUser);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuidParam(param) {
  return (req, res, next) => {
    if (!uuidPattern.test(req.params[param] || '')) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }
    return next();
  };
}

async function requireProfile(userId) {
  const result = await db.query(
    'select id from public.profiles where id = $1 limit 1',
    [userId]
  );
  return result.rowCount > 0;
}

router.get('/me', async (req, res, next) => {
  try {
    const result = await db.query(
      'select id, username, display_name, avatar_url, cover_url, status_text from public.profiles where id = $1 limit 1',
      [req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Profil SSPACE introuvable.' });
    }
    return res.set('Cache-Control', 'no-store').json({ profile: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/:userId', requireUuidParam('userId'), async (req, res, next) => {
  try {
    const result = await db.query(
      'select id, username, display_name, avatar_url, cover_url, status_text from public.profiles where id = $1 and (id = $2 or coalesce(is_private, false) = false) limit 1',
      [req.params.userId, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Profil introuvable ou privé.' });
    }
    return res.set('Cache-Control', 'no-store').json({ profile: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/:userId/media', requireUuidParam('userId'), async (req, res, next) => {
  try {
    const result = await db.query(
      'select m.id, m.owner_id, m.media_type, m.mime_type, m.size_bytes, m.created_at from public.profile_media m join public.profiles p on p.id = m.owner_id where m.owner_id = $1 and (m.owner_id = $2 or coalesce(p.is_private, false) = false) order by m.created_at desc limit 100',
      [req.params.userId, req.user.id]
    );
    const media = result.rows.map(({ owner_id, ...item }) => ({
      ...item,
      content_url: '/api/profil/media/' + item.id + '/content'
    }));
    return res.set('Cache-Control', 'no-store').json({ media });
  } catch (error) {
    return next(error);
  }
});

router.post('/me/:mediaType', (req, res, next) => {
  const mediaType = req.params.mediaType;
  if (!['photo', 'video'].includes(mediaType)) {
    return res.status(400).json({ error: 'Type de média invalide.' });
  }

  uploaderFor(mediaType).single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'Fichier trop volumineux.' : uploadError.message
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier manquant (champ « file »).' });
    }

    try {
      const detected = await fileTypeFromFile(req.file.path);
      if (!detected || !allowed[mediaType].has(detected.mime)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(415).json({
          error: 'Le contenu réel du fichier ne correspond pas à un format autorisé.'
        });
      }
      if (mediaType === 'photo' && req.file.size > photoLimit) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(413).json({ error: 'Photo trop volumineuse.' });
      }
      if (!await requireProfile(req.user.id)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(404).json({ error: 'Profil SSPACE introuvable.' });
      }

      const result = await db.query(
        'insert into public.profile_media (owner_id, media_type, storage_key, mime_type, size_bytes) values ($1, $2, $3, $4, $5) returning id, media_type, mime_type, size_bytes, created_at',
        [
          req.user.id,
          mediaType,
          path.basename(req.file.filename),
          detected.mime,
          req.file.size
        ]
      );

      return res.status(201).json({
        media: {
          ...result.rows[0],
          content_url: '/api/profil/media/' + result.rows[0].id + '/content'
        }
      });
    } catch (error) {
      await fs.unlink(req.file.path).catch(() => {});
      return next(error);
    }
  });
});

router.get('/media/:mediaId/content', requireUuidParam('mediaId'), async (req, res, next) => {
  try {
    const result = await db.query(
      'select m.storage_key, m.mime_type from public.profile_media m join public.profiles p on p.id = m.owner_id where m.id = $1 and (m.owner_id = $2 or coalesce(p.is_private, false) = false) limit 1',
      [req.params.mediaId, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Fichier introuvable.' });
    }

    const filePath = path.join(uploadRoot, path.basename(result.rows[0].storage_key));
    await fs.access(filePath);
    res.set({
      'Content-Type': result.rows[0].mime_type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline'
    });
    return res.sendFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Fichier absent du stockage.' });
    }
    return next(error);
  }
});

router.delete('/media/:mediaId', requireUuidParam('mediaId'), async (req, res, next) => {
  try {
    const result = await db.query(
      'delete from public.profile_media where id = $1 and owner_id = $2 returning storage_key',
      [req.params.mediaId, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Fichier introuvable.' });
    }
    const filePath = path.join(uploadRoot, path.basename(result.rows[0].storage_key));
    await fs.unlink(filePath).catch(() => {});
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;