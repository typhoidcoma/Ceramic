function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (configured && configured.trim().length > 0) {
    const normalized = configured.trim().replace("http://localhost:8787", "http://127.0.0.1:8787");
    return trimSlash(normalized);
  }
  return "http://127.0.0.1:8787";
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}
