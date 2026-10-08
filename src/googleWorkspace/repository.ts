import { GoogleApiClient } from './apiClient';
import { GoogleWorkspaceTable, isGoogleWorkspaceTable, quoteSheetTitle } from './schema';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_PAYLOAD_CELL_CHARS = 40_000;
const MAX_WRITE_BATCH_ROWS = 500;
const MAX_WRITE_BATCH_CHARS = 1_500_000;
const CHUNK_PREFIX = '__CF_CHUNKED_V1__';
const CHUNK_KEY_PREFIX = '__cf_chunk__:';

export interface StoredSheetRecord<T> {
    id: string;
    key: string;
    revision: number;
    updatedAt: string;
    value: T;
    rowNumber: number;
    physicalRowCount?: number;
}

export interface SheetRecordChanges<T extends object> {
    append?: Array<StoredSheetRecord<T>>;
    update?: Array<StoredSheetRecord<T>>;
    remove?: Array<StoredSheetRecord<T>>;
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

const createWriteBatches = (rows: unknown[][]): Array<{ start: number; rows: unknown[][] }> => {
    const batches: Array<{ start: number; rows: unknown[][] }> = [];
    let current: unknown[][] = [];
    let currentChars = 0;
    let start = 0;

    rows.forEach((row, index) => {
        const rowChars = JSON.stringify(row).length;
        if (current.length > 0 && (
            current.length >= MAX_WRITE_BATCH_ROWS ||
            currentChars + rowChars > MAX_WRITE_BATCH_CHARS
        )) {
            batches.push({ start, rows: current });
            start = index;
            current = [];
            currentChars = 0;
        }
        current.push(row);
        currentChars += rowChars;
    });

    if (current.length > 0) batches.push({ start, rows: current });
    return batches;
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
                let physicalRowCount = 1;
                if (payload.startsWith(CHUNK_PREFIX)) {
                    const separator = payload.indexOf('__', CHUNK_PREFIX.length);
                    const chunkCount = Number(payload.slice(CHUNK_PREFIX.length, separator));
                    if (!Number.isInteger(chunkCount) || chunkCount < 1 || separator < 0) {
                        throw new Error('Marcador de payload fragmentado inválido.');
                    }
                    physicalRowCount = chunkCount;
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
                    physicalRowCount,
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
        if (current) {
            record.physicalRowCount = current.physicalRowCount;
            await this.applyChanges(table, { update: [record] });
        } else {
            await this.applyChanges(table, { append: [record] });
        }
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

        await this.applyChanges(table, { remove: [current] });
        return true;
    }

    async applyChanges<T extends object>(
        tableName: GoogleWorkspaceTable,
        changes: SheetRecordChanges<T>,
    ): Promise<void> {
        const table = assertTable(tableName);
        const append = [...(changes.append || [])];
        const updateInPlace: Array<{ record: StoredSheetRecord<T>; rows: unknown[][] }> = [];
        const clearRanges: string[] = [];

        for (const record of changes.update || []) {
            const rows = serializeRecordRows(record);
            const previousRowCount = Math.max(1, record.physicalRowCount || 1);
            if (rows.length > previousRowCount) {
                // O registro cresceu e não pode invadir a linha seguinte. Primeiro cria
                // a nova versão no fim e só depois limpa a versão anterior.
                append.push(record);
                clearRanges.push(`${quoteSheetTitle(table)}!A${record.rowNumber}:E${record.rowNumber + previousRowCount - 1}`);
                continue;
            }
            updateInPlace.push({ record, rows });
            if (rows.length < previousRowCount) {
                clearRanges.push(
                    `${quoteSheetTitle(table)}!A${record.rowNumber + rows.length}:E${record.rowNumber + previousRowCount - 1}`
                );
            }
        }

        for (const record of changes.remove || []) {
            const previousRowCount = Math.max(1, record.physicalRowCount || 1);
            clearRanges.push(`${quoteSheetTitle(table)}!A${record.rowNumber}:E${record.rowNumber + previousRowCount - 1}`);
        }

        // Registros que cresceram são anexados antes da limpeza para que uma falha
        // transitória nunca apague a única cópia válida do dado.
        await this.append(table, append);

        for (let offset = 0; offset < updateInPlace.length; offset += 100) {
            const batch = updateInPlace.slice(offset, offset + 100);
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values:batchUpdate`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        valueInputOption: 'RAW',
                        data: batch.map(({ record, rows }) => ({
                            range: `${quoteSheetTitle(table)}!A${record.rowNumber}:E${record.rowNumber + rows.length - 1}`,
                            majorDimension: 'ROWS',
                            values: rows,
                        })),
                    }),
                }
            );
        }

        for (let offset = 0; offset < clearRanges.length; offset += 500) {
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values:batchClear`,
                {
                    method: 'POST',
                    body: JSON.stringify({ ranges: clearRanges.slice(offset, offset + 500) }),
                }
            );
        }
    }

    async append<T extends object>(
        tableName: GoogleWorkspaceTable,
        records: Array<StoredSheetRecord<T>>,
    ): Promise<void> {
        if (records.length === 0) return;
        const table = assertTable(tableName);
        const physicalRows = records.flatMap(record => serializeRecordRows(record));
        const appendRange = encodeURIComponent(`${quoteSheetTitle(table)}!A:E`);
        for (const batch of createWriteBatches(physicalRows)) {
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        majorDimension: 'ROWS',
                        values: batch.rows,
                    }),
                }
            );
        }
    }

    async replaceAll<T extends object>(
        tableName: GoogleWorkspaceTable,
        records: Array<StoredSheetRecord<T>>,
    ): Promise<void> {
        const table = assertTable(tableName);
        const physicalRows = records.flatMap(record => serializeRecordRows(record));
        const rowCapacity = await this.ensureRowCapacity(table, physicalRows.length + 1);
        for (const batch of createWriteBatches(physicalRows)) {
            const firstRow = batch.start + 2;
            const lastRow = firstRow + batch.rows.length - 1;
            const range = encodeURIComponent(`${quoteSheetTitle(table)}!A${firstRow}:E${lastRow}`);
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${range}?valueInputOption=RAW`,
                {
                    method: 'PUT',
                    body: JSON.stringify({
                        majorDimension: 'ROWS',
                        values: batch.rows,
                    }),
                }
            );
        }
        const clearFrom = physicalRows.length + 2;
        if (clearFrom <= rowCapacity) {
            const clearRange = encodeURIComponent(`${quoteSheetTitle(table)}!A${clearFrom}:E${rowCapacity}`);
            await this.api.request(
                `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${clearRange}:clear`,
                { method: 'POST', body: '{}' }
            );
        }
    }

    private async ensureRowCapacity(table: GoogleWorkspaceTable, requiredRows: number): Promise<number> {
        const fields = encodeURIComponent('sheets(properties(sheetId,title,gridProperties(rowCount)))');
        const metadata = await this.api.request<{
            sheets?: Array<{
                properties?: {
                    sheetId?: number;
                    title?: string;
                    gridProperties?: { rowCount?: number };
                };
            }>;
        }>(`${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}?includeGridData=false&fields=${fields}`);
        const properties = metadata.sheets
            ?.map(sheet => sheet.properties)
            .find(candidate => candidate?.title === table);
        const currentRows = Number(properties?.gridProperties?.rowCount || 0);
        if (requiredRows <= currentRows) return currentRows;
        if (properties?.sheetId === undefined) {
            throw new Error(`Não foi possível localizar a aba ${table} para expandir suas linhas.`);
        }
        await this.api.request(
            `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}:batchUpdate`,
            {
                method: 'POST',
                body: JSON.stringify({
                    requests: [{
                        appendDimension: {
                            sheetId: properties.sheetId,
                            dimension: 'ROWS',
                            length: requiredRows - currentRows,
                        },
                    }],
                }),
            }
        );
        return requiredRows;
    }
}
