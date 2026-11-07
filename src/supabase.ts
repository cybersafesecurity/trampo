import { createClient } from '@supabase/supabase-js';

export const isSupabaseLive = import.meta.env.VITE_TRAMPO_BACKEND === 'supabase';
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const supabasePublishableKey = key || '';
export const supabase = isSupabaseLive && url && key ? createClient(url, key, {
  // PKCE keeps the email callback exchangeable only in the browser that has the
  // generated verifier. supabase-js exchanges ?code=... and emits PASSWORD_RECOVERY.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
}) : null;
export const supabaseFunctionUrl = url ? `${url.replace(/\/$/, '')}/functions/v1/trampo-api` : '';
export const supabaseConfigError = isSupabaseLive && !supabase ? 'Live Supabase configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.' : '';
