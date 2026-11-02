// The version (updated_at) of each record as this browser last loaded it.
// An edit sends it back, and the server refuses the edit if someone else
// changed the record in between (see server/routes/index.js).
const VERSIONED = new Set(['accounts', 'bills', 'bookings', 'cheques', 'compliance', 'customers', 'invoices', 'portals', 'vendors', 'visas']);
const versions = new Map();

function rememberVersions(path, data) {
  const match = /^\/([a-z-]+)(?:\/(\d+))?$/.exec(path.split('?')[0]);
  if (!match || !VERSIONED.has(match[1]) || !data || typeof data !== 'object') return;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row && row.id != null && typeof row.updated_at === 'string') versions.set(`/${match[1]}/${row.id}`, row.updated_at);
  }
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const version = method === 'PUT' ? versions.get(path) : undefined;
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(version !== undefined ? { 'X-Record-Version': version } : {}) },
    ...options,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    // The session ended or a one-time password must be changed: show sign-in.
    const signIn = response.status === 401
      || (response.status === 403 && data?.code === 'password_change_required');
    if (signIn && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('auth-required'));
    const error = new Error((data && data.error) || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (method === 'GET' || method === 'PUT') rememberVersions(path, data);
  return data;
}

export const api = {
  get(path, query) {
    let url = path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, value);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return request(url);
  },
  post(path, body) {
    return request(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  put(path, body) {
    return request(path, { method: 'PUT', body: JSON.stringify(body || {}) });
  },
  del(path, body) {
    return request(path, {
      method: 'DELETE',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  },
};
