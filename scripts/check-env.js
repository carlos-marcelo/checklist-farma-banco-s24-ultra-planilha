import { loadEnv } from 'vite';
import { existsSync, readFileSync } from 'node:fs';

const environment = {
  ...loadEnv('development', process.cwd(), ''),
  ...process.env,
};

const forbiddenVariables = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_URL_PROXY',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_DIRECT_POSTGREST',
  'VITE_SUPABASE_STRIP_AUTH_HEADERS'
];

const configured = forbiddenVariables.filter(name =>
  String(environment[name] || '').trim().length > 0
);

if (configured.length > 0) {
  console.error(`Legacy backend configuration is still present: ${configured.join(', ')}`);
  process.exit(1);
}

if (existsSync('.env.legacy-disabled')) {
  console.error('Legacy backend file .env.legacy-disabled must not exist after migration.');
  process.exit(1);
}

const packageDocument = JSON.parse(readFileSync('package.json', 'utf8'));
if (packageDocument.dependencies?.['@supabase/supabase-js']) {
  console.error('The legacy Supabase client dependency must not be installed.');
  process.exit(1);
}

console.log('Legacy Termux/PostgREST environment is disabled.');

const googleClientId = String(environment.VITE_GOOGLE_CLIENT_ID || '').trim();
const googleAuthServerUrl = String(environment.VITE_GOOGLE_AUTH_SERVER_URL || '').trim();
if (googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com')) {
  console.error('VITE_GOOGLE_CLIENT_ID does not look like a Google OAuth Web Client ID.');
  process.exit(1);
}

if (environment.VITE_GOOGLE_CLIENT_SECRET) {
  console.error('VITE_GOOGLE_CLIENT_SECRET must never be exposed in a frontend environment.');
  process.exit(1);
}

console.log(googleClientId
  ? 'Google Workspace browser client ID is configured.'
  : googleAuthServerUrl
    ? 'Google Workspace local OAuth server is configured.'
    : 'Google Workspace authorization is not configured yet.');
