import { getGoogleWorkspaceConfig } from './config';

const SESSION_KEY = 'checklistFarma.appsScript.session';

export interface AppsScriptSessionUser {
    email: string;
    name?: string;
    phone?: string;
    role?: string;
    approved?: boolean;
    rejected?: boolean;
    company_id?: string | null;
    area?: string | null;
    filial?: string | null;
    preferred_theme?: string | null;
    photo?: string | null;
    [key: string]: unknown;
}

interface StoredSession {
    token: string;
    user: AppsScriptSessionUser;
    expiresAt?: string;
}

interface ApiEnvelope<T> {
    ok: boolean;
    data?: T;
    error?: { code?: string; message?: string } | string;
    count?: number | null;
}

const readSession = (): StoredSession | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(SESSION_KEY) || window.sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredSession;
        if (!parsed?.token || !parsed?.user?.email) return null;
        if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
            window.localStorage.removeItem(SESSION_KEY);
            window.sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
};

const saveSession = (session: StoredSession | null) => {
    if (typeof window === 'undefined') return;
    if (!session) {
        window.localStorage.removeItem(SESSION_KEY);
        window.sessionStorage.removeItem(SESSION_KEY);
    } else {
        const serialized = JSON.stringify(session);
        try { window.localStorage.setItem(SESSION_KEY, serialized); } catch { /* ignore quota */ }
        try { window.sessionStorage.setItem(SESSION_KEY, serialized); } catch { /* ignore quota */ }
    }
};

class GoogleAppsScriptClient {
    private readonly endpoint = getGoogleWorkspaceConfig().appsScriptUrl || '';

    isConfigured(): boolean {
        return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/i.test(this.endpoint);
    }

    isAuthenticated(): boolean {
        return Boolean(readSession());
    }

    getCurrentUser(): AppsScriptSessionUser | null {
        return readSession()?.user || null;
    }

    async login(email: string, password: string): Promise<AppsScriptSessionUser> {
        const data = await this.request<StoredSession>('login', { email, password }, false);
        saveSession(data);
        return data.user;
    }

    async register(user: Record<string, unknown>): Promise<void> {
        await this.request('register', { user }, false);
    }

    async logout(): Promise<void> {
        try { await this.request('logout', {}, true); } catch { /* local logout still succeeds */ }
        this.clearSession();
    }

    clearSession(): void {
        saveSession(null);
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem('APP_CURRENT_EMAIL');
        }
    }

    async query<T>(query: Record<string, unknown>): Promise<T> {
        return this.request<T>('query', { query }, true);
    }

    private async request<T>(action: string, payload: Record<string, unknown>, authenticated: boolean): Promise<T> {
        if (!this.isConfigured()) throw new Error('A API segura do Google Apps Script não foi configurada.');
        const session = readSession();
        if (authenticated && !session) {
            throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'), { code: 'AUTH_REQUIRED' });
        }
        const response = await fetch(this.endpoint, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ action, payload, sessionToken: session?.token || null }),
        });
        const envelope = await response.json() as ApiEnvelope<T>;
        if (!response.ok || !envelope.ok) {
            const detail = typeof envelope.error === 'string' ? envelope.error : envelope.error || {};
            const message = typeof detail === 'string' ? detail : detail.message || 'Falha na API segura do Google.';
            const code = typeof detail === 'string' ? 'APPS_SCRIPT_ERROR' : detail.code || 'APPS_SCRIPT_ERROR';
            if (code === 'AUTH_REQUIRED' || code === 'SESSION_EXPIRED') {
                this.clearSession();
                if (typeof window !== 'undefined') window.dispatchEvent(new Event('checklist-farma:session-expired'));
            }
            throw Object.assign(new Error(message), { code });
        }
        return envelope.data as T;
    }
}

export const googleAppsScriptClient = new GoogleAppsScriptClient();
