import { googleSheetsSupabaseCompat } from './src/googleWorkspace/supabaseCompat';

// Compatibility export: callers keep the existing query contract, while every
// read and write is executed exclusively against the managed Google Sheets.
// No Termux/PostgREST/Supabase endpoint exists in this runtime path.
export const supabase: any = googleSheetsSupabaseCompat;

export const isSupabaseConfigured = () => false;
