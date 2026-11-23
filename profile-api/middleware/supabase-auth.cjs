module.exports = async function requireSupabaseUser(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match && match[1] ? match[1].trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Session SSPACE requise.' });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return res.status(503).json({ error: 'Vérification Supabase non configurée.' });
  }

  try {
    const response = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8_000)
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Session SSPACE invalide ou expirée.' });
    }

    const user = await response.json();
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Session SSPACE invalide.' });
    }

    req.user = { id: user.id, email: user.email || null };
    req.supabaseRest = (resource, options = {}) => {
      const headers = {
        apikey: anonKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers || {})
      };
      return fetch(supabaseUrl + '/rest/v1/' + resource, {
        ...options,
        headers,
        signal: AbortSignal.timeout(12_000)
      });
    };
    return next();
  } catch (error) {
    console.error('Supabase request failed:', error.message);
    return res.status(503).json({
      error: 'Service Supabase temporairement indisponible.'
    });
  }
};