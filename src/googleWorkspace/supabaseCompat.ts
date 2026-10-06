import { googleWorkspaceService } from './workspaceService';
import {
    GOOGLE_SOURCE_KEY_FIELDS,
    GOOGLE_SOURCE_TABLE_MAP,
    GoogleSourceTable,
} from './schema';
import type { StoredSheetRecord } from './repository';

type Row = Record<string, any>;
type Operation = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
type Filter = (row: Row) => boolean;

interface QueryResult {
    data: any;
    error: null | { code: string; message: string; details?: unknown };
    count?: number | null;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const createId = (): string => globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const scalarEqual = (left: unknown, right: unknown): boolean => {
    if (left === null || left === undefined) return right === null || right === undefined;
    if (right === null || right === undefined) return false;
    return String(left) === String(right);
};
const compare = (left: unknown, right: unknown): number => {
    if (left === right) return 0;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left).localeCompare(String(right));
};
const recordKey = (row: Row, fields: readonly string[]): string =>
    JSON.stringify(fields.map(field => row[field] ?? null));
const project = (row: Row, columns: string): Row => {
    if (!columns || columns.trim() === '*') return clone(row);
    const selected: Row = {};
    columns.split(',').map(column => column.trim()).filter(Boolean).forEach(column => {
        selected[column] = clone(row[column]);
    });
    return selected;
};
const errorResult = (error: unknown): QueryResult => ({
    data: null,
    error: {
        code: error instanceof Error && error.name === 'GoogleAuthorizationRequiredError'
            ? 'GOOGLE_AUTH_REQUIRED'
            : 'GOOGLE_SHEETS_ERROR',
        message: error instanceof Error ? error.message : String(error),
        details: error,
    },
    count: null,
});

class GoogleSheetsQueryBuilder implements PromiseLike<QueryResult> {
    private operation: Operation = 'select';
    private payload: Row | Row[] | null = null;
    private filters: Filter[] = [];
    private orders: Array<{ column: string; ascending: boolean }> = [];
    private selectedColumns = '*';
    private shouldReturnRows = false;
    private head = false;
    private countMode: string | undefined;
    private maxRows: number | undefined;
    private rangeStart: number | undefined;
    private rangeEnd: number | undefined;
    private singleMode: 'single' | 'maybeSingle' | null = null;
    private conflictFields: string[] | null = null;

    constructor(private readonly table: GoogleSourceTable) {}

    select(columns = '*', options: { count?: string; head?: boolean } = {}): this {
        this.selectedColumns = columns || '*';
        this.shouldReturnRows = this.operation !== 'select';
        this.countMode = options.count;
        this.head = Boolean(options.head);
        return this;
    }

    insert(payload: Row | Row[]): this {
        this.operation = 'insert';
        this.payload = payload;
        return this;
    }

    upsert(payload: Row | Row[], options: { onConflict?: string } = {}): this {
        this.operation = 'upsert';
        this.payload = payload;
        this.conflictFields = options.onConflict
            ? options.onConflict.split(',').map(field => field.trim()).filter(Boolean)
            : null;
        return this;
    }

    update(payload: Row): this {
        this.operation = 'update';
        this.payload = payload;
        return this;
    }

    delete(): this {
        this.operation = 'delete';
        return this;
    }

    eq(column: string, value: unknown): this {
        this.filters.push(row => scalarEqual(row[column], value));
        return this;
    }

    neq(column: string, value: unknown): this {
        this.filters.push(row => !scalarEqual(row[column], value));
        return this;
    }

    gt(column: string, value: unknown): this {
        this.filters.push(row => compare(row[column], value) > 0);
        return this;
    }

    gte(column: string, value: unknown): this {
        this.filters.push(row => compare(row[column], value) >= 0);
        return this;
    }

    lt(column: string, value: unknown): this {
        this.filters.push(row => compare(row[column], value) < 0);
        return this;
    }

    lte(column: string, value: unknown): this {
        this.filters.push(row => compare(row[column], value) <= 0);
        return this;
    }

    is(column: string, value: unknown): this {
        this.filters.push(row => value === null ? row[column] == null : scalarEqual(row[column], value));
        return this;
    }

    in(column: string, values: unknown[]): this {
        this.filters.push(row => values.some(value => scalarEqual(row[column], value)));
        return this;
    }

    or(expression: string): this {
        const alternatives = expression.split(',').map(part => {
            const [column, operator, ...rawValue] = part.split('.');
            const value = rawValue.join('.');
            if (operator === 'is' && value === 'null') return (row: Row) => row[column] == null;
            if (operator === 'neq') return (row: Row) => !scalarEqual(row[column], value);
            return (row: Row) => scalarEqual(row[column], value);
        });
        this.filters.push(row => alternatives.some(filter => filter(row)));
        return this;
    }

    order(column: string, options: { ascending?: boolean } = {}): this {
        this.orders.push({ column, ascending: options.ascending !== false });
        return this;
    }

    limit(value: number): this {
        this.maxRows = Math.max(0, value);
        return this;
    }

    range(from: number, to: number): this {
        this.rangeStart = Math.max(0, from);
        this.rangeEnd = Math.max(this.rangeStart, to);
        return this;
    }

    single(): this {
        this.singleMode = 'single';
        return this;
    }

    maybeSingle(): this {
        this.singleMode = 'maybeSingle';
        return this;
    }

    then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected);
    }

    private matches(row: Row): boolean {
        return this.filters.every(filter => filter(row));
    }

    private shapeRows(rows: Row[], totalCount: number): QueryResult {
        let result = [...rows];
        for (const order of [...this.orders].reverse()) {
            result.sort((left, right) => compare(left[order.column], right[order.column]) * (order.ascending ? 1 : -1));
        }
        if (this.rangeStart !== undefined) result = result.slice(this.rangeStart, (this.rangeEnd ?? this.rangeStart) + 1);
        if (this.maxRows !== undefined) result = result.slice(0, this.maxRows);
        const projected = result.map(row => project(row, this.selectedColumns));
        const count = this.countMode ? totalCount : null;
        if (this.head) return { data: null, error: null, count };
        if (this.singleMode === 'single') {
            if (projected.length !== 1) {
                return { data: null, error: { code: 'PGRST116', message: 'A consulta não retornou exatamente uma linha.' }, count };
            }
            return { data: projected[0], error: null, count };
        }
        if (this.singleMode === 'maybeSingle') {
            if (projected.length > 1) {
                return { data: null, error: { code: 'PGRST116', message: 'A consulta retornou mais de uma linha.' }, count };
            }
            return { data: projected[0] || null, error: null, count };
        }
        return { data: projected, error: null, count };
    }

    private async execute(): Promise<QueryResult> {
        try {
            const connection = googleWorkspaceService.getConnection()
                || await googleWorkspaceService.connectAndInitialize(false);
            const repository = connection.repository;
            const sheet = GOOGLE_SOURCE_TABLE_MAP[this.table];
            const stored = await repository.list<Row>(sheet);

            if (this.operation === 'select') {
                const matching = stored.map(record => record.value).filter(row => this.matches(row));
                return this.shapeRows(matching, matching.length);
            }

            const now = new Date().toISOString();
            let next = [...stored];
            let affected: Row[] = [];

            if (this.operation === 'insert' || this.operation === 'upsert') {
                const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as Row[];
                const keyFields = this.conflictFields || [...GOOGLE_SOURCE_KEY_FIELDS[this.table]];
                for (const raw of incoming) {
                    const row = clone(raw);
                    if (!row.id && keyFields.includes('id')) row.id = createId();
                    if (!row.created_at) row.created_at = now;
                    if (!row.updated_at) row.updated_at = now;
                    const existingIndex = next.findIndex(record =>
                        keyFields.every(field => scalarEqual(record.value[field], row[field]))
                    );
                    if (existingIndex >= 0 && this.operation === 'insert') {
                        return { data: null, error: { code: '23505', message: 'Registro duplicado.' }, count: null };
                    }
                    if (existingIndex >= 0) {
                        const existing = next[existingIndex];
                        const merged = { ...existing.value, ...row, updated_at: row.updated_at || now };
                        next[existingIndex] = {
                            ...existing,
                            key: recordKey(merged, keyFields),
                            revision: existing.revision + 1,
                            updatedAt: now,
                            value: merged,
                        };
                        affected.push(merged);
                    } else {
                        const id = String(row.id || createId());
                        next.push({
                            id,
                            key: recordKey(row, keyFields),
                            revision: 1,
                            updatedAt: now,
                            value: row,
                            rowNumber: next.length + 2,
                        });
                        affected.push(row);
                    }
                }
            } else if (this.operation === 'update') {
                const updates = clone(this.payload || {}) as Row;
                next = next.map(record => {
                    if (!this.matches(record.value)) return record;
                    const value = { ...record.value, ...updates };
                    affected.push(value);
                    return { ...record, revision: record.revision + 1, updatedAt: now, value };
                });
            } else if (this.operation === 'delete') {
                const kept: Array<StoredSheetRecord<Row>> = [];
                for (const record of next) {
                    if (this.matches(record.value)) affected.push(record.value);
                    else kept.push(record);
                }
                next = kept;
            }

            await repository.replaceAll(sheet, next);
            return this.shouldReturnRows
                ? this.shapeRows(affected, affected.length)
                : { data: null, error: null, count: this.countMode ? affected.length : null };
        } catch (error) {
            return errorResult(error);
        }
    }
}

export const googleSheetsSupabaseCompat = {
    from(table: string): GoogleSheetsQueryBuilder {
        if (!(table in GOOGLE_SOURCE_TABLE_MAP)) {
            throw new Error(`A tabela ${table} não está mapeada para Google Sheets.`);
        }
        return new GoogleSheetsQueryBuilder(table as GoogleSourceTable);
    },
    async rpc(name: string): Promise<QueryResult> {
        return {
            data: null,
            error: {
                code: 'PGRST202',
                message: `A função ${name} não existe no adaptador Google Sheets; será usado o fallback do aplicativo.`,
            },
            count: null,
        };
    },
};

