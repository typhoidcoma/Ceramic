import { useCallback, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseClient, hasSupabaseConfig } from "../../data/supabase";

type AuthStatus = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  error: string | null;
  configMissing: boolean;
};

export type UseAuthResult = AuthStatus & {
  sendOtp: (email: string) => Promise<{ ok: boolean; error?: string }>;
  verifyOtp: (email: string, token: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<{ ok: boolean; error?: string }>;
};

export function useAuth(): UseAuthResult {
  const [status, setStatus] = useState<AuthStatus>({
    session: null,
    user: null,
    loading: true,
    error: null,
    configMissing: !hasSupabaseConfig(),
  });

  useEffect(() => {
    if (!hasSupabaseConfig()) {
      setStatus({
        session: null,
        user: null,
        loading: false,
        error: "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.",
        configMissing: true,
      });
      return;
    }

    const supabase = getSupabaseClient();
    let active = true;

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        setStatus({
          session: data.session,
          user: data.session?.user ?? null,
          loading: false,
          error: error?.message ?? null,
          configMissing: false,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus({
          session: null,
          user: null,
          loading: false,
          error: error instanceof Error ? error.message : "Failed to read session.",
          configMissing: false,
        });
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setStatus((prev) => ({
        ...prev,
        session,
        user: session?.user ?? null,
        loading: false,
        error: null,
      }));
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const sendOtp = useCallback(async (email: string) => {
    if (!hasSupabaseConfig()) return { ok: false, error: "Supabase config missing." };
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const verifyOtp = useCallback(async (email: string, token: string) => {
    if (!hasSupabaseConfig()) return { ok: false, error: "Supabase config missing." };
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const signOut = useCallback(async () => {
    if (!hasSupabaseConfig()) return { ok: false, error: "Supabase config missing." };
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signOut();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  return {
    ...status,
    sendOtp,
    verifyOtp,
    signOut,
  };
}
