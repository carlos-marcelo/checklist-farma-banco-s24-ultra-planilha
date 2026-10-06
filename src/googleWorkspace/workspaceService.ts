import { GoogleApiClient, GoogleApiError } from './apiClient';
import { GoogleWorkspaceAuth } from './auth';
import { getGoogleWorkspaceConfig, isGoogleWorkspaceConfigured } from './config';
import { GoogleSheetsRepository } from './repository';
import {
    GOOGLE_WORKSPACE_SCHEMA_VERSION,
    GOOGLE_WORKSPACE_TABLES,
    MANAGED_SHEET_HEADERS,
    quoteSheetTitle,
} from './schema';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const ACTIVE_SPREADSHEET_KEY = 'checklistFarma.googleWorkspace.spreadsheetId';
const APP_PROPERTY_KEY = 'checklistFarmaData';
const APP_PROPERTY_VALUE = 'schema-v1';

interface SpreadsheetMetadata {
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}

export interface GoogleWorkspaceConnection {
    spreadsheetId: string;
    spreadsheetUrl: string;
    spreadsheetName: string;
    repository: GoogleSheetsRepository;
}

export interface GoogleWorkspaceStatus {
    configured: boolean;
    connected: boolean;
    spreadsheetId?: string;
}

const readStoredSpreadsheetId = (): string | undefined => {
    try { return localStorage.getItem(ACTIVE_SPREADSHEET_KEY) || undefined; }
    catch { return undefined; }
};

const storeSpreadsheetId = (id: string): void => {
    try { localStorage.setItem(ACTIVE_SPREADSHEET_KEY, id); } catch { /* storage is optional */ }
};

const headersMatch = (values: unknown[]): boolean =>
    MANAGED_SHEET_HEADERS.every((header, index) => String(values[index] ?? '') === header);

export class GoogleWorkspaceService {
    private readonly config = getGoogleWorkspaceConfig();
    private readonly auth = new GoogleWorkspaceAuth(this.config.clientId, this.config.authServerUrl);
    private readonly api = new GoogleApiClient(this.auth);
    private connection: GoogleWorkspaceConnection | null = null;
    private initializationPromise: Promise<GoogleWorkspaceConnection> | null = null;

    getStatus(): GoogleWorkspaceStatus {
        return {
            configured: isGoogleWorkspaceConfigured(),
            connected: this.auth.isConnected(),
            spreadsheetId: this.connection?.spreadsheetId
                || this.config.spreadsheetId
                || readStoredSpreadsheetId(),
        };
    }

    getConnection(): GoogleWorkspaceConnection | null {
        return this.auth.isConnected() ? this.connection : null;
    }

    async connectAndInitialize(interactive = true): Promise<GoogleWorkspaceConnection> {
        if (this.connection && this.auth.isConnected()) return this.connection;
        if (this.initializationPromise) return this.initializationPromise;
        this.initializationPromise = this.initialize(interactive);
        try {
            return await this.initializationPromise;
        } finally {
            this.initializationPromise = null;
        }
    }

    private async initialize(interactive: boolean): Promise<GoogleWorkspaceConnection> {
        await this.auth.connect(interactive);
        const metadata = await this.resolveSpreadsheet();
        await this.ensureManagedSchema(metadata);

        const repository = new GoogleSheetsRepository(this.api, metadata.spreadsheetId);
        const schemaRecord = await repository.get<{ version: number }>('cf_metadata', 'schema');
        if (!schemaRecord || schemaRecord.value.version !== GOOGLE_WORKSPACE_SCHEMA_VERSION) {
            await repository.upsert('cf_metadata', 'schema', {
                version: GOOGLE_WORKSPACE_SCHEMA_VERSION,
                initializedAt: new Date().toISOString(),
                application: 'checklist-farma',
            }, schemaRecord ? { expectedRevision: schemaRecord.revision } : undefined);
        }

        storeSpreadsheetId(metadata.spreadsheetId);
        this.connection = {
            spreadsheetId: metadata.spreadsheetId,
            spreadsheetUrl: metadata.spreadsheetUrl
                || `https://docs.google.com/spreadsheets/d/${metadata.spreadsheetId}/edit`,
            spreadsheetName: metadata.properties?.title || this.config.spreadsheetName,
            repository,
        };
        return this.connection;
    }

    async disconnect(): Promise<void> {
        await this.auth.disconnect();
        this.connection = null;
    }

    private async resolveSpreadsheet(): Promise<SpreadsheetMetadata> {
        if (this.config.spreadsheetId) {
            return this.getSpreadsheet(this.config.spreadsheetId);
        }

        const storedId = readStoredSpreadsheetId();
        if (storedId) {
            try {
                return await this.getSpreadsheet(storedId);
            } catch (error) {
                if (!(error instanceof GoogleApiError) || ![403, 404].includes(error.status)) throw error;
            }
        }

        const discoveredId = await this.findManagedSpreadsheet();
        if (discoveredId) return this.getSpreadsheet(discoveredId);
        const createdId = await this.createManagedSpreadsheet();
        return this.getSpreadsheet(createdId);
    }

    private getSpreadsheet(id: string): Promise<SpreadsheetMetadata> {
        const fields = encodeURIComponent(
            'spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))'
        );
        return this.api.request<SpreadsheetMetadata>(
            `${SHEETS_API}/${encodeURIComponent(id)}?fields=${fields}`
        );
    }

    private async findManagedSpreadsheet(): Promise<string | null> {
        const query = [
            "mimeType = 'application/vnd.google-apps.spreadsheet'",
            'trashed = false',
            `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' }`,
        ].join(' and ');
        const params = new URLSearchParams({
            q: query,
            spaces: 'drive',
            orderBy: 'modifiedTime desc',
            pageSize: '10',
            fields: 'files(id,name,modifiedTime,webViewLink)',
        });
        const response = await this.api.request<{ files?: Array<{ id?: string }> }>(
            `${DRIVE_FILES_API}?${params.toString()}`
        );
        return response.files?.find(file => file.id)?.id || null;
    }

    private async createManagedSpreadsheet(): Promise<string> {
        const body: Record<string, unknown> = {
            name: this.config.spreadsheetName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            appProperties: { [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE },
        };
        if (this.config.folderId) body.parents = [this.config.folderId];

        const response = await this.api.request<{ id?: string }>(
            `${DRIVE_FILES_API}?fields=id,name,webViewLink`,
            { method: 'POST', body: JSON.stringify(body) }
        );
        if (!response.id) throw new Error('O Google Drive não retornou o ID da planilha criada.');
        return response.id;
    }

    private async ensureManagedSchema(metadata: SpreadsheetMetadata): Promise<void> {
        const existing = new Set(
            (metadata.sheets || []).map(sheet => sheet.properties?.title).filter(Boolean)
        );
        const missing = GOOGLE_WORKSPACE_TABLES.filter(table => !existing.has(table));
        if (missing.length > 0) {
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(metadata.spreadsheetId)}:batchUpdate`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        requests: missing.map(title => ({ addSheet: { properties: { title } } })),
                    }),
                }
            );
        }

        const ranges = GOOGLE_WORKSPACE_TABLES.map(table => `${quoteSheetTitle(table)}!1:1`);
        const params = new URLSearchParams();
        ranges.forEach(range => params.append('ranges', range));
        params.set('majorDimension', 'ROWS');
        const currentHeaders = await this.api.request<{
            valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
        }>(`${SHEETS_API}/${encodeURIComponent(metadata.spreadsheetId)}/values:batchGet?${params}`);

        const headerWrites: Array<{ range: string; majorDimension: string; values: readonly (readonly string[])[] }> = [];
        GOOGLE_WORKSPACE_TABLES.forEach((table, index) => {
            const values = currentHeaders.valueRanges?.[index]?.values?.[0] || [];
            if (values.length === 0) {
                headerWrites.push({
                    range: `${quoteSheetTitle(table)}!A1:E1`,
                    majorDimension: 'ROWS',
                    values: [MANAGED_SHEET_HEADERS],
                });
                return;
            }
            if (!headersMatch(values)) {
                throw new Error(
                    `A aba ${table} já existe, mas o cabeçalho não corresponde ao esquema do aplicativo.`
                );
            }
        });

        if (headerWrites.length > 0) {
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(metadata.spreadsheetId)}/values:batchUpdate`,
                {
                    method: 'POST',
                    body: JSON.stringify({ valueInputOption: 'RAW', data: headerWrites }),
                }
            );
        }
    }
}

export const googleWorkspaceService = new GoogleWorkspaceService();
