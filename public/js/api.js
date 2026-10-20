async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
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
    const error = new Error((data && data.error) || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
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
  del(path) {
    return request(path, { method: 'DELETE' });
  },
};
