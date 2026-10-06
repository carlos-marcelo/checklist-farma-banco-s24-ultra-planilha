import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from 'vite';

const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
const host = env.GOOGLE_AUTH_HOST || '127.0.0.1';
const port = Number(env.GOOGLE_AUTH_PORT || 8787);
const credentialsPath = env.GOOGLE_OAUTH_CREDENTIALS_PATH;
const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI
    || `http://${host}:${port}/oauth/google/callback`;
const allowedOrigins = new Set([
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://localhost:3000',
    'http://localhost:3001',
]);
const scopes = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
];
const pendingStates = new Map();

if (!credentialsPath) {
    console.error('GOOGLE_OAUTH_CREDENTIALS_PATH não foi configurado.');
    process.exit(1);
}

const credentialsDocument = JSON.parse(await readFile(credentialsPath, 'utf8'));
const credentials = credentialsDocument.web || credentialsDocument.installed;
if (!credentials?.client_id || !credentials?.client_secret) {
    console.error('O arquivo OAuth não contém credenciais válidas para aplicativo Web.');
    process.exit(1);
}

const tokenPath = env.GOOGLE_OAUTH_TOKEN_PATH
    || path.join(path.dirname(credentialsPath), 'checklist-farma-google-token.json');

const sendJson = (response, status, value, origin) => {
    if (origin && allowedOrigins.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
    }
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(value));
};

const readToken = async () => {
    try { return JSON.parse(await readFile(tokenPath, 'utf8')); }
    catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
};

const saveToken = async token => {
    await mkdir(path.dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
};

const tokenRequest = async parameters => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters),
    });
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error_description || payload.error || 'Falha ao obter token do Google.');
    }
    return payload;
};

const exchangeAuthorizationCode = code => tokenRequest({
    code,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
});

const refreshAccessToken = async stored => {
    if (!stored?.refresh_token) throw new Error('Autorização persistente ainda não realizada.');
    const refreshed = await tokenRequest({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: stored.refresh_token,
        grant_type: 'refresh_token',
    });
    const merged = {
        ...stored,
        ...refreshed,
        refresh_token: refreshed.refresh_token || stored.refresh_token,
        expiry_date: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
    };
    await saveToken(merged);
    return merged;
};

const getValidToken = async () => {
    const stored = await readToken();
    if (!stored) return null;
    if (stored.access_token && Number(stored.expiry_date || 0) > Date.now() + 60_000) return stored;
    return refreshAccessToken(stored);
};

const normalizeReturnTo = value => {
    try {
        const parsed = new URL(value || 'http://127.0.0.1:3001/');
        return allowedOrigins.has(parsed.origin) ? parsed.toString() : 'http://127.0.0.1:3001/';
    } catch {
        return 'http://127.0.0.1:3001/';
    }
};

const buildAuthorizationUrl = (state, loginHint) => {
    const params = new URLSearchParams({
        client_id: credentials.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        state,
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
};

const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === 'OPTIONS') {
        if (origin && allowedOrigins.has(origin)) {
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.setHeader('Vary', 'Origin');
        }
        response.writeHead(204);
        response.end();
        return;
    }

    try {
        if (request.method === 'GET' && url.pathname === '/health') {
            sendJson(response, 200, { ok: true }, origin);
            return;
        }

        if (request.method === 'GET' && url.pathname === '/auth/google/status') {
            const token = await readToken();
            sendJson(response, 200, { configured: true, authorized: Boolean(token?.refresh_token) }, origin);
            return;
        }

        if (request.method === 'GET' && url.pathname === '/auth/google/token') {
            const token = await getValidToken();
            if (!token) {
                sendJson(response, 401, { error: 'authorization_required' }, origin);
                return;
            }
            sendJson(response, 200, {
                access_token: token.access_token,
                expires_in: Math.max(60, Math.floor((token.expiry_date - Date.now()) / 1000)),
            }, origin);
            return;
        }

        if (request.method === 'GET' && url.pathname === '/auth/google/start') {
            const state = randomBytes(32).toString('hex');
            pendingStates.set(state, {
                returnTo: normalizeReturnTo(url.searchParams.get('return_to')),
                expiresAt: Date.now() + 10 * 60_000,
            });
            response.writeHead(302, {
                Location: buildAuthorizationUrl(state, url.searchParams.get('login_hint')),
                'Cache-Control': 'no-store',
            });
            response.end();
            return;
        }

        if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
            const state = url.searchParams.get('state');
            const pending = state ? pendingStates.get(state) : null;
            if (!pending || pending.expiresAt < Date.now()) {
                response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Solicitação OAuth inválida ou expirada. Volte ao aplicativo e tente novamente.');
                return;
            }
            pendingStates.delete(state);
            const code = url.searchParams.get('code');
            if (!code) throw new Error(url.searchParams.get('error') || 'O Google não retornou o código OAuth.');
            const token = await exchangeAuthorizationCode(code);
            await saveToken({
                ...token,
                expiry_date: Date.now() + Number(token.expires_in || 3600) * 1000,
                authorized_at: new Date().toISOString(),
            });
            const destination = new URL(pending.returnTo);
            destination.searchParams.set('google_connected', '1');
            response.writeHead(302, { Location: destination.toString(), 'Cache-Control': 'no-store' });
            response.end();
            return;
        }

        if (request.method === 'POST' && url.pathname === '/auth/google/disconnect') {
            const token = await readToken();
            const revokeToken = token?.refresh_token || token?.access_token;
            if (revokeToken) {
                await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revokeToken)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                }).catch(() => undefined);
            }
            await unlink(tokenPath).catch(error => {
                if (error?.code !== 'ENOENT') throw error;
            });
            sendJson(response, 200, { disconnected: true }, origin);
            return;
        }

        sendJson(response, 404, { error: 'not_found' }, origin);
    } catch (error) {
        console.error('[google-oauth]', error instanceof Error ? error.message : error);
        sendJson(response, 500, { error: error instanceof Error ? error.message : 'Erro interno.' }, origin);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [state, pending] of pendingStates) {
        if (pending.expiresAt < now) pendingStates.delete(state);
    }
}, 60_000).unref();

server.listen(port, host, () => {
    console.log(`Google OAuth local server: http://${host}:${port}`);
    console.log(`OAuth credentials loaded from: ${credentialsPath}`);
    console.log(`Token storage: ${tokenPath}`);
});

