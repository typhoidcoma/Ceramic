function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (configured && configured.trim().length > 0) return trimSlash(configured.trim());
  return "http://localhost:8787";
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}
