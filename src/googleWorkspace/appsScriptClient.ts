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

/**
 * Fila com limite estrito de concorrência.
 * O Google Apps Script Web App derruba conexões (ERR_CONNECTION_CLOSED) quando
 * recebe mais de 2 a 3 requisições simultâneas concorrendo por planilhas.
 */
class RequestConcurrencyQueue {
    private running = 0;
    private readonly maxConcurrent = 3;
    private readonly queue: Array<() => void> = [];

    async run<T>(fn: () => Promise<T>): Promise<T> {
        while (this.running >= this.maxConcurrent) {
            await new Promise<void>(resolve => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            // Pequeno espaçamento para despressurizar o Google Apps Script
            setTimeout(() => {
                const next = this.queue.shift();
                if (next) next();
            }, 30);
        }
    }
}

class GoogleAppsScriptClient {
    private readonly endpoint = getGoogleWorkspaceConfig().appsScriptUrl || '';
    private readonly queue = new RequestConcurrencyQueue();
    private readonly inFlightReadQueries = new Map<string, Promise<unknown>>();
    private readonly completedReadQueries = new Map<string, unknown>();
    private readCacheGeneration = 0;
    private readonly maxCompletedReadQueries = 160;

    private getReadQueryKey(query: Record<string, unknown>): string {
        const sessionEmail = readSession()?.user?.email || 'anonymous';
        return `${sessionEmail}|${String(query.table || '')}|${JSON.stringify(query)}`;
    }

    /** Limpa leituras guardadas apenas durante a página atual. */
    clearReadCache(table?: string): void {
        this.readCacheGeneration++;
        if (!table) {
            this.completedReadQueries.clear();
            return;
        }
        const tableMarker = `|${table}|`;
        for (const key of this.completedReadQueries.keys()) {
            if (key.includes(tableMarker)) this.completedReadQueries.delete(key);
        }
    }

    private rememberRead(queryKey: string, value: unknown): void {
        if (this.completedReadQueries.has(queryKey)) this.completedReadQueries.delete(queryKey);
        this.completedReadQueries.set(queryKey, value);
        while (this.completedReadQueries.size > this.maxCompletedReadQueries) {
            const oldest = this.completedReadQueries.keys().next().value;
            if (oldest === undefined) break;
            this.completedReadQueries.delete(oldest);
        }
    }

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
        // Remove o token anterior antes de autenticar. Requisições que já estavam
        // em voo continuam com uma cópia dele, mas não poderão invalidar a nova sessão.
        this.clearReadCache();
        saveSession(null);
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
        this.clearReadCache();
        saveSession(null);
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem('APP_CURRENT_EMAIL');
        }
    }

    async query<T>(query: Record<string, unknown>): Promise<T> {
        const isSelect = query.operation === 'select';
        if (isSelect) {
            // Reaproveita consultas idênticas durante toda a vida desta página.
            // A chave inclui o usuário para nunca compartilhar dados entre sessões.
            const queryKey = this.getReadQueryKey(query);
            if (this.completedReadQueries.has(queryKey)) {
                const cached = this.completedReadQueries.get(queryKey);
                // Promove para o fim do LRU.
                this.completedReadQueries.delete(queryKey);
                this.completedReadQueries.set(queryKey, cached);
                return cached as T;
            }
            const inFlight = this.inFlightReadQueries.get(queryKey);
            if (inFlight) {
                return inFlight as Promise<T>;
            }
            const generation = this.readCacheGeneration;
            const promise = this.request<T>('query', { query }, true)
                .then(result => {
                    const resultError = result && typeof result === 'object' && 'error' in (result as object)
                        ? (result as { error?: unknown }).error
                        : null;
                    if (!resultError && generation === this.readCacheGeneration) {
                        this.rememberRead(queryKey, result);
                    }
                    return result;
                })
                .finally(() => {
                    this.inFlightReadQueries.delete(queryKey);
                });
            this.inFlightReadQueries.set(queryKey, promise);
            return promise;
        }
        const result = await this.request<T>('query', { query }, true);
        const resultError = result && typeof result === 'object' && 'error' in (result as object)
            ? (result as { error?: unknown }).error
            : null;
        if (!resultError) this.clearReadCache(String(query.table || '') || undefined);
        return result;
    }

    private async request<T>(action: string, payload: Record<string, unknown>, authenticated: boolean): Promise<T> {
        if (!this.isConfigured()) throw new Error('A API segura do Google Apps Script não foi configurada.');
        const session = readSession();
        if (authenticated && !session) {
            throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'), { code: 'AUTH_REQUIRED' });
        }

        // Executa através da fila de concorrência controlada para nunca afogar o Google Apps Script
        return this.queue.run(async () => {
            let lastError: unknown = null;
            const isWrite = action === 'query' && payload && typeof payload === 'object' && (payload as any).operation && (payload as any).operation !== 'select';
            const maxAttempts = isWrite ? 4 : 2;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timeoutId = controller ? setTimeout(() => controller.abort(), isWrite ? 40_000 : 18_000) : null;

                try {
                    if (typeof navigator !== 'undefined' && !navigator.onLine) {
                        throw Object.assign(new Error('Sem conexão com a internet.'), { code: 'OFFLINE' });
                    }

                    const response = await fetch(this.endpoint, {
                        signal: controller?.signal,
                        method: 'POST',
                        redirect: 'follow',
                        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                        body: JSON.stringify({ action, payload, sessionToken: session?.token || null }),
                    });

                    const rawText = await response.text();
                    let envelope: ApiEnvelope<T>;
                    try {
                        envelope = JSON.parse(rawText) as ApiEnvelope<T>;
                    } catch {
                        const isHtml = /^\s*</i.test(rawText);
                        const is404 = response.status === 404 || /404\s+Not\s+Found/i.test(rawText);
                        if (is404) {
                            throw Object.assign(new Error('Falha temporária no serviço do Google (404). Tentando novamente...'), {
                                code: 'TRANSIENT_ECHO_404',
                                status: 404
                            });
                        }
                        const errMsg = isHtml
                            ? 'O serviço do Google Apps Script demorou para responder ou retornou página temporária. Tentando novamente...'
                            : 'Resposta inválida do serviço do Google.';
                        throw Object.assign(new Error(errMsg), {
                            code: 'TRANSIENT_HTML_ERROR',
                            status: response.status
                        });
                    }

                    if (!response.ok || !envelope.ok) {
                        const detail = typeof envelope.error === 'string' ? envelope.error : envelope.error || {};
                        const message = typeof detail === 'string' ? detail : detail.message || 'Falha na API segura do Google.';
                        const code = typeof detail === 'string' ? 'APPS_SCRIPT_ERROR' : detail.code || 'APPS_SCRIPT_ERROR';
                        if (code === 'AUTH_REQUIRED' || code === 'SESSION_EXPIRED') {
                            const currentSession = readSession();
                            const belongsToCurrentSession = !!(
                                session?.token &&
                                currentSession?.token &&
                                currentSession.token === session.token
                            );
                            if (belongsToCurrentSession) {
                                this.clearSession();
                                if (typeof window !== 'undefined') {
                                    window.dispatchEvent(new Event('checklist-farma:session-expired'));
                                }
                            }
                        }
                        throw Object.assign(new Error(message), { code });
                    }
                    return envelope.data as T;
                } catch (err: any) {
                    lastError = err;
                    if (err?.code === 'AUTH_REQUIRED' || err?.code === 'SESSION_EXPIRED' || err?.code === 'INVALID_CREDENTIALS') {
                        throw err;
                    }
                    const isTransient = err?.code === 'TRANSIENT_HTML_ERROR' ||
                        err?.code === 'TRANSIENT_ECHO_404' ||
                        err?.code === 'APPS_SCRIPT_TIMEOUT' ||
                        err?.name === 'AbortError' ||
                        err instanceof TypeError ||
                        String(err?.message || '').includes('Failed to fetch') ||
                        String(err?.message || '').includes('NetworkError') ||
                        String(err?.message || '').includes('network') ||
                        String(err?.message || '').includes('Unexpected token') ||
                        String(err?.message || '').includes('CONNECTION_CLOSED') ||
                        String(err?.message || '').includes('ERR_CONNECTION_CLOSED') ||
                        String(err?.message || '').includes('aborted') ||
                        err?.code === 'OFFLINE';

                    if (attempt < maxAttempts - 1 && isTransient) {
                        // Backoff progressivo: 1.2s, 2.3s, 4.2s com jitter aleatório para evitar colisões
                        const baseDelay = 1200 * Math.pow(1.8, attempt);
                        const jitter = Math.floor(Math.random() * 350);
                        await new Promise(r => setTimeout(r, baseDelay + jitter));
                        continue;
                    }
                    throw err;
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }
            }
            throw lastError;
        });
    }
}

export const googleAppsScriptClient = new GoogleAppsScriptClient();
