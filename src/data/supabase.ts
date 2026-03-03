import { createClient } from "@supabase/supabase-js";

let cached: ReturnType<typeof createClient> | null = null;

export type SupabaseConfig = {
  url: string;
  publishableKey: string;
};

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) {
    return null;
  }
  return { url, publishableKey };
}

export function hasSupabaseConfig(): boolean {
  return Boolean(getSupabaseConfig());
}

export function getSupabaseClient() {
  if (cached) return cached;
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
  }
  cached = createClient(config.url, config.publishableKey);
  return cached;
}
