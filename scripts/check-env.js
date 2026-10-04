const forbiddenVariables = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_URL_PROXY',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_DIRECT_POSTGREST',
  'VITE_SUPABASE_STRIP_AUTH_HEADERS'
];

const configured = forbiddenVariables.filter(name =>
  String(process.env[name] || '').trim().length > 0
);

if (configured.length > 0) {
  console.error(`Legacy backend configuration is still present: ${configured.join(', ')}`);
  process.exit(1);
}

console.log('Legacy Termux/PostgREST environment is disabled.');
