import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Publishable Supabase config. These values are safe for the browser:
 * every table read/write is gated by RLS. The service-role key is NEVER
 * referenced here or anywhere in client code.
 */
const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when publishable env vars are present → the live backend may be used. */
export const supabaseConfigured: boolean = Boolean(URL && ANON_KEY && URL.startsWith("https://"));

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (!client) {
    client = createClient(URL!, ANON_KEY!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "implicit",
      },
    });
  }
  return client;
}