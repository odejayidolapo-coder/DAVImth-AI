
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed') as Error & {
      response?: { status: number; data: unknown };
    };

    error.response = {
      status: response.status,
      data,
    };

    throw error;
  }

  return { data, status: response.status };
}

export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body?: unknown) => request('POST', path, body),
  put: (path: string, body?: unknown) => request('PUT', path, body),
  patch: (path: string, body?: unknown) => request('PATCH', path, body),
  delete: (path: string) => request('DELETE', path),
};
