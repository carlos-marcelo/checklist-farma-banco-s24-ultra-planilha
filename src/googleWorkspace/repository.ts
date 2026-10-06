import { GoogleApiClient } from './apiClient';
import { GoogleWorkspaceTable, isGoogleWorkspaceTable, quoteSheetTitle } from './schema';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_PAYLOAD_CELL_CHARS = 40_000;
const CHUNK_PREFIX = '__CF_CHUNKED_V1__';
const CHUNK_KEY_PREFIX = '__cf_chunk__:';

export interface StoredSheetRecord<T> {
    id: string;
    key: string;
    revision: number;
    updatedAt: string;
    value: T;
    rowNumber: number;
}

export interface UpsertOptions { expectedRevision?: number; }

export class GoogleSheetConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GoogleSheetConflictError';
    }
}

const assertTable = (table: string): GoogleWorkspaceTable => {
    if (!isGoogleWorkspaceTable(table)) {
        throw new Error(`A aba ${table} não pertence ao esquema gerenciado.`);
    }
    return table;
};

const createId = (): string => globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const splitPayload = (payload: string): string[] => {
    const chunks: string[] = [];
    for (let offset = 0; offset < payload.length; offset += MAX_PAYLOAD_CELL_CHARS) {
        chunks.push(payload.slice(offset, offset + MAX_PAYLOAD_CELL_CHARS));
    }
    return chunks.length > 0 ? chunks : [''];
};

const serializeRecordRows = <T>(record: StoredSheetRecord<T>): unknown[][] => {
    const payload = JSON.stringify(record.value);
    if (payload.length <= MAX_PAYLOAD_CELL_CHARS) {
        return [[record.id, record.key, record.revision, record.updatedAt, payload]];
    }
    const chunks = splitPayload(payload);
    return chunks.map((chunk, index) => [
        index === 0 ? record.id : `${record.id}:chunk:${index}`,
        index === 0 ? record.key : `${CHUNK_KEY_PREFIX}${record.id}:${index}`,
        record.revision,
        record.updatedAt,
        index === 0 ? `${CHUNK_PREFIX}${chunks.length}__${chunk}` : chunk,
    ]);
};

export class GoogleSheetsRepository {
    constructor(
        private readonly api: GoogleApiClient,
        readonly spreadsheetId: string,
    ) {}

    async list<T>(tableName: GoogleWorkspaceTable): Promise<Array<StoredSheetRecord<T>>> {
        const table = assertTable(tableName);
        const range = encodeURIComponent(`${quoteSheetTitle(table)}!A2:E`);
        const response = await this.api.request<{ values?: unknown[][] }>(
            `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${range}?majorDimension=ROWS`
        );

        const rows = response.values || [];
        const records: Array<StoredSheetRecord<T>> = [];
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const physicalRowNumber = index + 2;
            if (!row[0] || !row[1] || row[4] === undefined) continue;
            if (String(row[1]).startsWith(CHUNK_KEY_PREFIX)) continue;
            try {
                let payload = String(row[4]);
                if (payload.startsWith(CHUNK_PREFIX)) {
                    const separator = payload.indexOf('__', CHUNK_PREFIX.length);
                    const chunkCount = Number(payload.slice(CHUNK_PREFIX.length, separator));
                    if (!Number.isInteger(chunkCount) || chunkCount < 1 || separator < 0) {
                        throw new Error('Marcador de payload fragmentado inválido.');
                    }
                    payload = payload.slice(separator + 2);
                    for (let chunkIndex = 1; chunkIndex < chunkCount; chunkIndex += 1) {
                        payload += String(rows[index + chunkIndex]?.[4] ?? '');
                    }
                    index += chunkCount - 1;
                }
                records.push({
                    id: String(row[0]),
                    key: String(row[1]),
                    revision: Math.max(1, Number(row[2]) || 1),
                    updatedAt: String(row[3] || ''),
                    value: JSON.parse(payload) as T,
                    rowNumber: physicalRowNumber,
                });
            } catch (error) {
                console.warn(`[GoogleSheetsRepository] Linha inválida ignorada em ${table}.`, error);
            }
        }
        return records;
    }

    async get<T>(table: GoogleWorkspaceTable, key: string): Promise<StoredSheetRecord<T> | null> {
        const normalizedKey = String(key).trim();
        const records = await this.list<T>(table);
        return records.find(record => record.key === normalizedKey) || null;
    }

    async upsert<T extends object>(
        tableName: GoogleWorkspaceTable,
        key: string,
        value: T,
        options: UpsertOptions = {},
    ): Promise<StoredSheetRecord<T>> {
        const table = assertTable(tableName);
        const normalizedKey = String(key).trim();
        if (!normalizedKey) throw new Error('A chave do registro não pode estar vazia.');

        const records = await this.list<T>(table);
        const rowIndex = records.findIndex(record => record.key === normalizedKey);
        const current = rowIndex >= 0 ? records[rowIndex] : null;
        if (options.expectedRevision !== undefined && (current?.revision || 0) !== options.expectedRevision) {
            throw new GoogleSheetConflictError(
                `O registro ${normalizedKey} foi alterado em outra sessão. Atualize os dados e tente novamente.`
            );
        }

        const record: StoredSheetRecord<T> = {
            id: current?.id || createId(),
            key: normalizedKey,
            revision: (current?.revision || 0) + 1,
            updatedAt: new Date().toISOString(),
            value,
            rowNumber: current?.rowNumber || records.length + 2,
        };
        if (current) records[rowIndex] = record;
        else records.push(record);
        await this.replaceAll(table, records);
        return record;
    }

    async remove(tableName: GoogleWorkspaceTable, key: string, expectedRevision?: number): Promise<boolean> {
        const table = assertTable(tableName);
        const normalizedKey = String(key).trim();
        const records = await this.list<object>(table);
        const rowIndex = records.findIndex(record => record.key === normalizedKey);
        if (rowIndex < 0) return false;

        const current = records[rowIndex];
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
            throw new GoogleSheetConflictError(
                `O registro ${normalizedKey} foi alterado em outra sessão. Atualize os dados e tente novamente.`
            );
        }

        records.splice(rowIndex, 1);
        await this.replaceAll(table, records);
        return true;
    }

    async replaceAll<T extends object>(
        tableName: GoogleWorkspaceTable,
        records: Array<StoredSheetRecord<T>>,
    ): Promise<void> {
        const table = assertTable(tableName);
        const physicalRows = records.flatMap(record => serializeRecordRows(record));
        if (physicalRows.length > 0) {
            const range = encodeURIComponent(`${quoteSheetTitle(table)}!A2:E${physicalRows.length + 1}`);
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${range}?valueInputOption=RAW`,
                {
                    method: 'PUT',
                    body: JSON.stringify({
                        majorDimension: 'ROWS',
                        values: physicalRows,
                    }),
                }
            );
        }
        const clearFrom = physicalRows.length + 2;
        const clearRange = encodeURIComponent(`${quoteSheetTitle(table)}!A${clearFrom}:E`);
        await this.api.request(
            `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${clearRange}:clear`,
            { method: 'POST', body: '{}' }
        );
    }
}
