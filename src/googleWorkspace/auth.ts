import { GOOGLE_WORKSPACE_SCOPES } from './config';

interface GoogleTokenResponse {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

interface GoogleTokenClient {
    requestAccessToken(options?: { prompt?: string }): void;
}

interface GoogleOAuth2Api {
    initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: GoogleTokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
    }): GoogleTokenClient;
    revoke(token: string, callback?: () => void): void;
}

declare global {
    interface Window {
        google?: { accounts?: { oauth2?: GoogleOAuth2Api } };
    }
}

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<void> | null = null;

const loadGoogleIdentityServices = (): Promise<void> => {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (scriptPromise) return scriptPromise;

    scriptPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
            `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`
        );
        const script = existing || document.createElement('script');
        const handleLoad = () => window.google?.accounts?.oauth2
            ? resolve()
            : reject(new Error('A biblioteca de autorização do Google não foi inicializada.'));
        const handleError = () => reject(new Error('Não foi possível carregar a autorização do Google.'));

        script.addEventListener('load', handleLoad, { once: true });
        script.addEventListener('error', handleError, { once: true });
        if (!existing) {
            script.src = GOOGLE_IDENTITY_SCRIPT;
            script.async = true;
            script.defer = true;
            document.head.appendChild(script);
        }
    }).catch(error => {
        scriptPromise = null;
        throw error;
    });
    return scriptPromise;
};

export class GoogleAuthorizationRequiredError extends Error {
    constructor(message = 'Conecte sua conta Google para continuar.') {
        super(message);
        this.name = 'GoogleAuthorizationRequiredError';
    }
}

export class GoogleWorkspaceAuth {
    private accessToken: string | null = null;
    private expiresAt = 0;

    constructor(
        private readonly clientId: string,
        private readonly authServerUrl?: string,
    ) {}

    isConnected(): boolean {
        return Boolean(this.accessToken && Date.now() < this.expiresAt - 30_000);
    }

    getAccessToken(): string {
        if (!this.isConnected() || !this.accessToken) {
            this.clearToken();
            throw new GoogleAuthorizationRequiredError();
        }
        return this.accessToken;
    }

    async ensureAccessToken(): Promise<string> {
        if (this.isConnected()) return this.getAccessToken();
        if (this.authServerUrl) {
            await this.loadTokenFromBackend(false);
            return this.getAccessToken();
        }
        return this.getAccessToken();
    }

    async connect(interactive = true): Promise<void> {
        if (this.authServerUrl) {
            try {
                await this.loadTokenFromBackend(interactive);
                return;
            } catch (error) {
                if (error instanceof GoogleAuthorizationRequiredError || !this.clientId) throw error;
                console.warn('[GoogleWorkspaceAuth] Servidor OAuth local indisponível; usando autorização no navegador.');
            }
        }
        if (!this.clientId) throw new Error('A conexão OAuth do Google não foi configurada.');
        if (!interactive) {
            throw new GoogleAuthorizationRequiredError();
        }
        await loadGoogleIdentityServices();
        const oauth2 = window.google?.accounts?.oauth2;
        if (!oauth2) throw new Error('Google Identity Services indisponível.');

        await new Promise<void>((resolve, reject) => {
            const client = oauth2.initTokenClient({
                client_id: this.clientId,
                scope: GOOGLE_WORKSPACE_SCOPES,
                callback: response => {
                    if (response.error || !response.access_token) {
                        reject(new Error(response.error_description || response.error || 'Autorização Google recusada.'));
                        return;
                    }
                    this.accessToken = response.access_token;
                    this.expiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600)) * 1000;
                    resolve();
                },
                error_callback: error => reject(
                    new Error(error.message || error.type || 'A janela de autorização foi fechada.')
                ),
            });
            client.requestAccessToken({ prompt: '' });
        });
    }

    async disconnect(): Promise<void> {
        const token = this.accessToken;
        this.clearToken();
        if (this.authServerUrl) {
            await fetch(`${this.authServerUrl.replace(/\/$/, '')}/auth/google/disconnect`, {
                method: 'POST',
            }).catch(() => undefined);
        }
        if (token && window.google?.accounts?.oauth2) {
            window.google.accounts.oauth2.revoke(token);
        }
    }

    clearToken(): void {
        this.accessToken = null;
        this.expiresAt = 0;
    }

    private async loadTokenFromBackend(interactive: boolean): Promise<void> {
        const baseUrl = this.authServerUrl?.replace(/\/$/, '');
        if (!baseUrl) throw new GoogleAuthorizationRequiredError();
        const response = await fetch(`${baseUrl}/auth/google/token`, {
            headers: { Accept: 'application/json' },
        });
        if (response.status === 401) {
            if (interactive) {
                const returnTo = window.location.href;
                window.location.assign(
                    `${baseUrl}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`
                );
            }
            throw new GoogleAuthorizationRequiredError(
                interactive ? 'Redirecionando para autorização do Google.' : undefined
            );
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.access_token) {
            throw new Error(payload.error || 'O servidor OAuth local não forneceu um token válido.');
        }
        this.accessToken = payload.access_token;
        this.expiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000;
    }
}
