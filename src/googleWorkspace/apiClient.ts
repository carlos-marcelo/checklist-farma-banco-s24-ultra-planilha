import { GoogleWorkspaceAuth } from './auth';

export class GoogleApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'GoogleApiError';
    }
}

const extractErrorMessage = (payload: any, status: number): string =>
    payload?.error?.message || payload?.error_description || `A API do Google respondeu com status ${status}.`;

export class GoogleApiClient {
    constructor(private readonly auth: GoogleWorkspaceAuth) {}

    async request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
        for (let attempt = 0; attempt < 7; attempt += 1) {
            const headers = new Headers(init.headers);
            headers.set('Authorization', `Bearer ${await this.auth.ensureAccessToken()}`);
            if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

            const response = await fetch(url, { ...init, headers });
            const text = await response.text();
            let payload: any = undefined;
            if (text) {
                try { payload = JSON.parse(text); } catch { payload = text; }
            }

            if (response.ok) return payload as T;
            if (response.status === 401) this.auth.clearToken();
            if (response.status === 429 && attempt < 6) {
                const retryAfterSeconds = Number(response.headers.get('retry-after') || 0);
                const delayMs = Math.max(retryAfterSeconds * 1000, Math.min(20_000, 2_000 * (attempt + 1)));
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }
            throw new GoogleApiError(extractErrorMessage(payload, response.status), response.status, payload);
        }
        throw new GoogleApiError('A API do Google excedeu o limite de tentativas.', 429);
    }
}
