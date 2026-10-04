import { createClient } from '@supabase/supabase-js';

// Safety boundary for the spreadsheet migration branch.
// The legacy Termux/PostgREST backend must never be contacted from this copy.
const OFFLINE_SUPABASE_URL = 'http://127.0.0.1:9';
const OFFLINE_SUPABASE_KEY = 'legacy-backend-disabled';

const createOfflineResponse = () => new Response(JSON.stringify({
  code: 'LEGACY_BACKEND_DISABLED',
  details: null,
  hint: null,
  message: 'A fonte Termux/PostgREST foi desativada nesta copia. Use a nova fonte de planilhas.'
}), {
  status: 503,
  statusText: 'Legacy backend disabled',
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-data-source': 'offline-migration'
  }
});

// SupabaseService still provides the application's current data contract while
// it is migrated table by table. Returning locally prevents every read/write
// from reaching a network, even if a legacy .env file exists on the machine.
const offlineFetch: typeof fetch = async () => createOfflineResponse();

export const supabase = createClient(OFFLINE_SUPABASE_URL, OFFLINE_SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: {
    fetch: offlineFetch,
  },
});

export const isSupabaseConfigured = () => false;
