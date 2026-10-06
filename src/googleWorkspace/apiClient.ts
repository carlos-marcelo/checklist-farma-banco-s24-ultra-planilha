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
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${await this.auth.ensureAccessToken()}`);
        if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

        const response = await fetch(url, { ...init, headers });
        const text = await response.text();
        let payload: any = undefined;
        if (text) {
            try { payload = JSON.parse(text); } catch { payload = text; }
        }

        if (!response.ok) {
            if (response.status === 401) this.auth.clearToken();
            throw new GoogleApiError(extractErrorMessage(payload, response.status), response.status, payload);
        }
        return payload as T;
    }
}
