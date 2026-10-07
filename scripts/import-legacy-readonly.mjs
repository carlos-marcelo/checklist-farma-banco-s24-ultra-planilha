import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const LEGACY_ENV_FILE = '.env.legacy-disabled';
const PAGE_SIZE = 500;
const SOURCE_TIMEOUT_MS = 20_000;
const SKIPPED_TABLES = new Set(['active_sessions']);

const parseEnvFile = raw => {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
};

const legacyEnv = parseEnvFile(await readFile(LEGACY_ENV_FILE, 'utf8'));
const legacyProxyUrl = String(legacyEnv.VITE_SUPABASE_URL_PROXY || '').trim();
const legacyHost = (() => {
  try { return new URL(legacyProxyUrl).host; }
  catch { return legacyProxyUrl.replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
})();
if (!legacyHost || !/^[a-z0-9.-]+$/i.test(legacyHost)) {
  throw new Error('Host legado ausente ou inválido.');
}
const legacyOrigin = `https://${legacyHost}`;

const legacyGet = async (table, offset) => {
  const url = new URL(`/${encodeURIComponent(table)}`, legacyOrigin);
  url.searchParams.set('select', '*');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  if (url.origin !== legacyOrigin) throw new Error('Origem legada não permitida.');

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(`${table}: ${payload.code || response.status} ${payload.message || ''}`.trim());
      }
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error(`${table}: resposta não é uma lista.`);
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
  }
  throw lastError;
};

const fetchAll = async table => {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await legacyGet(table, offset);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

const stableId = key => createHash('sha256').update(key).digest('hex').slice(0, 32);
const rowKey = (row, fields) => JSON.stringify(fields.map(field => row[field] ?? null));
const rowTimestamp = row => Date.parse(row.updated_at || row.created_at || '') || 0;

const vite = await createServer({ appType: 'custom', server: { middlewareMode: true } });
try {
  const { googleWorkspaceService } = await vite.ssrLoadModule('/src/googleWorkspace/workspaceService.ts');
  const schema = await vite.ssrLoadModule('/src/googleWorkspace/schema.ts');
  const connection = await googleWorkspaceService.connectAndInitialize(false);

  for (const table of Object.keys(schema.GOOGLE_SOURCE_TABLE_MAP)) {
    if (SKIPPED_TABLES.has(table)) {
      console.log(`${table}: ignorada (sessão temporária)`);
      continue;
    }

    const sheet = schema.GOOGLE_SOURCE_TABLE_MAP[table];
    const keyFields = schema.GOOGLE_SOURCE_KEY_FIELDS[table];
    const [sourceRows, targetRecords] = await Promise.all([
      fetchAll(table),
      connection.repository.list(sheet),
    ]);

    const sourceByKey = new Map();
    for (const row of sourceRows) {
      const key = rowKey(row, keyFields);
      const previous = sourceByKey.get(key);
      if (!previous || rowTimestamp(row) >= rowTimestamp(previous)) sourceByKey.set(key, row);
    }

    const merged = new Map(targetRecords.map(record => [record.key, record]));
    const importedAt = new Date().toISOString();
    let changed = false;
    for (const [key, row] of sourceByKey) {
      const current = merged.get(key);
      const value = current ? { ...current.value, ...row } : row;
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) continue;
      merged.set(key, {
        id: current?.id || String(row.id || stableId(`${table}:${key}`)),
        key,
        revision: (current?.revision || 0) + 1,
        updatedAt: importedAt,
        value,
        rowNumber: current?.rowNumber || merged.size + 2,
      });
      changed = true;
    }

    if (changed) await connection.repository.replaceAll(sheet, [...merged.values()]);
    console.log(`${table}: origem=${sourceRows.length}, únicos=${sourceByKey.size}, destino=${merged.size}, ${changed ? 'atualizada' : 'sem alterações'}`);
  }
} finally {
  await vite.close();
}
