// Preencha somente na copia privada aberta em script.google.com.
const CF_SPREADSHEET_ID = 'COLE_AQUI_O_ID_DA_PLANILHA';
const CF_SESSION_SHEET = 'cf_api_sessions';
const CF_HEADERS = ['id', 'record_key', 'revision', 'updated_at', 'payload_json'];
const CF_CHUNK_PREFIX = '__CF_CHUNKED_V1__';
const CF_CHUNK_KEY_PREFIX = '__cf_chunk__:';
const CF_MAX_CELL_CHARS = 40000;
const CF_SESSION_HOURS = 12;

const CF_TABLES = {
  checklist_definitions: 'cf_checklist_definitions', users: 'cf_users', companies: 'cf_companies',
  access_matrix: 'cf_access_matrix', configs: 'cf_app_config', reports: 'cf_checklist_reports',
  stock_conference_sessions: 'cf_stock_sessions', stock_conference_reports: 'cf_stock_reports',
  pv_sessions: 'cf_pv_sessions', audit_sessions: 'cf_audit_sessions',
  pv_active_sales_reports: 'cf_pv_active_sales_reports', pv_branch_records: 'cf_pv_branch_records',
  pv_sales_history: 'cf_pv_sales_history', pv_sales_uploads: 'cf_pv_sales_uploads',
  pv_sales_analysis_reports: 'cf_pv_sales_analysis_reports', pv_branch_record_events: 'cf_pv_branch_record_events',
  app_event_logs: 'cf_app_event_logs', global_base_files: 'cf_global_base_files',
  pv_dashboard_reports: 'cf_pv_dashboard_reports', pv_inventory_reports: 'cf_pv_inventory_reports',
  pv_reports: 'cf_pv_reports', drafts: 'cf_drafts', tickets: 'cf_tickets', active_sessions: 'cf_active_sessions'
};

const CF_KEYS = {
  checklist_definitions: ['id'], users: ['email'], companies: ['id'], access_matrix: ['level'], configs: ['id'],
  reports: ['id'], stock_conference_sessions: ['user_email'], stock_conference_reports: ['id'],
  pv_sessions: ['user_email'], audit_sessions: ['branch', 'audit_number'],
  pv_active_sales_reports: ['company_id', 'branch'], pv_branch_records: ['id'], pv_sales_history: ['id'],
  pv_sales_uploads: ['id'], pv_sales_analysis_reports: ['company_id', 'branch', 'period_label'],
  pv_branch_record_events: ['id'], app_event_logs: ['id'], global_base_files: ['company_id', 'module_key'],
  pv_dashboard_reports: ['id'], pv_inventory_reports: ['company_id', 'branch'],
  pv_reports: ['user_email', 'report_type'], drafts: ['user_email'], tickets: ['id'], active_sessions: ['client_id']
};

const CF_MASTER_WRITE_TABLES = new Set([
  'companies', 'access_matrix', 'configs', 'checklist_definitions', 'global_base_files'
]);

function doGet() {
  return json_({ ok: true, data: { service: 'Checklist Farma Sheets API', version: 1 } });
}

function doPost(event) {
  try {
    const body = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    const action = String(body.action || '');
    if (action === 'login') return json_({ ok: true, data: login_(body.payload || {}) });
    if (action === 'register') return json_({ ok: true, data: register_(body.payload || {}) });

    const context = requireSession_(body.sessionToken);
    if (action === 'logout') {
      revokeSession_(context.sessionRecord);
      return json_({ ok: true, data: null });
    }
    if (action === 'query') return json_({ ok: true, data: executeQuery_(body.payload && body.payload.query, context.user) });
    throw apiError_('INVALID_ACTION', 'Operação inválida.');
  } catch (error) {
    return json_({
      ok: false,
      error: { code: error && error.code || 'APPS_SCRIPT_ERROR', message: error && error.message || String(error) }
    });
  }
}

function setupChecklistFarmaApi() {
  if (!CF_SPREADSHEET_ID || CF_SPREADSHEET_ID === 'COLE_AQUI_O_ID_DA_PLANILHA') {
    throw new Error('Preencha CF_SPREADSHEET_ID antes de executar o setup.');
  }
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('CF_PASSWORD_PEPPER')) {
    properties.setProperty('CF_PASSWORD_PEPPER', randomToken_() + randomToken_());
  }
  properties.setProperty('CF_SPREADSHEET_ID', CF_SPREADSHEET_ID);
  ensureSheet_(CF_SESSION_SHEET);
  return 'API preparada. Agora implante como Web App executando como você.';
}

/**
 * Execute manualmente uma unica vez no momento do corte para producao.
 * Converte todas as senhas legadas em hashes e apaga o texto puro da planilha.
 * Depois disso, o projeto antigo que compara senhas diretamente nao autentica
 * esses usuarios; por isso esta funcao e separada do setup.
 */
function migrateAllLegacyPasswords() {
  setupChecklistFarmaApi();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const records = listRecords_(CF_TABLES.users);
    let migrated = 0;
    records.forEach(record => {
      const user = record.value || {};
      if (user.password_hash || !user.password) return;
      const next = Object.assign({}, user, passwordFields_(String(user.password)));
      delete next.password;
      writeRecord_(CF_TABLES.users, Object.assign({}, record, {
        revision: record.revision + 1,
        updatedAt: nowIso_(),
        value: next
      }));
      migrated += 1;
    });
    return migrated + ' senha(s) migrada(s); o texto puro foi removido.';
  } finally {
    lock.releaseLock();
  }
}

function login_(payload) {
  const email = normalizeEmail_(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw apiError_('INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
  enforceLoginRateLimit_(email);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const records = listRecords_(CF_TABLES.users);
    const record = records.find(item => normalizeEmail_(item.value.email) === email);
    const user = record && record.value;
    if (!user || !verifyPassword_(user, password)) {
      registerLoginFailure_(email);
      throw apiError_('INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }
    if (user.rejected) throw apiError_('USER_REJECTED', 'Seu acesso foi recusado ou bloqueado.');
    if (!user.approved) throw apiError_('USER_PENDING', 'Sua conta ainda não foi aprovada.');

    if (!user.password_hash) {
      const migrated = Object.assign({}, user, passwordFields_(password));
      delete migrated.password;
      writeRecord_(CF_TABLES.users, Object.assign({}, record, {
        revision: record.revision + 1, updatedAt: nowIso_(), value: migrated
      }));
      Object.assign(user, migrated);
    }
    clearLoginFailures_(email);
    return createSession_(sanitizeUser_(user));
  } finally {
    lock.releaseLock();
  }
}

function register_(payload) {
  const raw = payload.user || {};
  const email = normalizeEmail_(raw.email);
  const password = String(raw.password || '');
  if (!email || password.length < 8) {
    throw apiError_('INVALID_REGISTRATION', 'Informe um e-mail válido e uma senha com pelo menos 8 caracteres.');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const records = listRecords_(CF_TABLES.users);
    if (records.some(item => normalizeEmail_(item.value.email) === email)) {
      throw apiError_('DUPLICATE_USER', 'E-mail já cadastrado.');
    }
    const now = nowIso_();
    const user = {
      id: Utilities.getUuid(), email: email, name: String(raw.name || '').trim(), phone: String(raw.phone || ''),
      role: 'USER', approved: false, rejected: false, company_id: raw.company_id || null,
      created_at: now, updated_at: now
    };
    Object.assign(user, passwordFields_(password));
    appendRecords_(CF_TABLES.users, [newRecord_(user, ['email'])]);
    return null;
  } finally {
    lock.releaseLock();
  }
}

function executeQuery_(query, user) {
  if (!query || !CF_TABLES[query.table]) throw apiError_('INVALID_TABLE', 'Tabela não permitida.');
  const table = String(query.table);
  const sheetName = CF_TABLES[table];
  const operation = String(query.operation || 'select');
  const lock = operation === 'select' ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(30000);
  try {
    const stored = listRecords_(sheetName);
    const visible = stored.filter(record => canRead_(table, record.value, user));
    if (operation === 'select') {
      const rows = visible.map(record => {
        const row = sanitizeRow_(table, record.value);
        if (!row.id && record.id) row.id = record.id;
        if (!row.updated_at && record.updatedAt) row.updated_at = record.updatedAt;
        return row;
      }).filter(row => matches_(row, query.filters || []));
      return shapeRows_(rows, query);
    }

    const now = nowIso_();
    const affected = [];
    const append = [];
    const update = [];
    const remove = [];
    const payloads = Array.isArray(query.payload) ? query.payload : [query.payload];
    const keyFields = query.conflictFields && query.conflictFields.length ? query.conflictFields : CF_KEYS[table];

    if (operation === 'insert' || operation === 'upsert') {
      payloads.filter(Boolean).forEach(raw => {
        let row = clone_(raw);
        if (!row.id) row.id = Utilities.getUuid();
        if (!row.created_at) row.created_at = now;
        if (!row.updated_at) row.updated_at = now;
        row = preparePasswordMutation_(table, row);
        const existing = stored.find(record => keyFields.every(field => scalarEqual_(record.value[field], row[field])));
        if (existing && operation === 'insert') throw apiError_('23505', 'Registro duplicado.');
        if (existing && !row.id) row.id = existing.value && existing.value.id || existing.id;
        const nextValue = existing ? Object.assign({}, existing.value, row, { updated_at: row.updated_at || now }) : row;
        assertWrite_(table, existing && existing.value, nextValue, raw, user, operation);
        if (existing) update.push(Object.assign({}, existing, { revision: existing.revision + 1, updatedAt: now, value: nextValue }));
        else append.push(newRecord_(nextValue, keyFields));
        affected.push(sanitizeRow_(table, nextValue));
      });
    } else {
      visible.forEach(record => {
        const safe = sanitizeRow_(table, record.value);
        if (!matches_(safe, query.filters || [])) return;
        if (operation === 'delete') {
          assertWrite_(table, record.value, null, {}, user, operation);
          remove.push(record);
          affected.push(safe);
          return;
        }
        let patch = preparePasswordMutation_(table, clone_(query.payload || {}));
        const nextValue = Object.assign({}, record.value, patch, { updated_at: patch.updated_at || now });
        assertWrite_(table, record.value, nextValue, query.payload || {}, user, operation);
        update.push(Object.assign({}, record, { revision: record.revision + 1, updatedAt: now, value: nextValue }));
        affected.push(sanitizeRow_(table, nextValue));
      });
    }
    applyChanges_(sheetName, append, update, remove);
    return query.shouldReturnRows ? shapeRows_(affected, query) : { data: null, error: null, count: query.countMode ? affected.length : null };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function canReadLegacy_(table, row, user) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'MASTER') return true;
  if (table === 'users') {
    return normalizeEmail_(row.email) === normalizeEmail_(user.email) ||
      (role === 'ADMINISTRATIVO' && sameCompany_(row, user));
  }
  if (table === 'companies') return !user.company_id || String(row.id || '') === String(user.company_id || '');
  if (['access_matrix', 'configs', 'checklist_definitions'].indexOf(table) >= 0) return true;
  if (row.company_id && !sameCompany_(row, user)) return false;
  if (role === 'ADMINISTRATIVO') return !row.company_id || sameCompany_(row, user);
  if (row.user_email && normalizeEmail_(row.user_email) === normalizeEmail_(user.email)) return true;
  if (row.branch) return normalizeBranch_(row.branch) === normalizeBranch_(user.filial);
  if (row.area) return normalizeText_(row.area) === normalizeText_(user.area);
  return !row.company_id && !row.user_email;
}

function assertWriteLegacy_(table, current, next, patch, user, operation) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'MASTER') return;
  if (CF_MASTER_WRITE_TABLES.has(table)) throw apiError_('FORBIDDEN', 'Apenas o Master pode alterar estes dados.');
  if (table === 'users') {
    if (!current || normalizeEmail_(current.email) !== normalizeEmail_(user.email)) throw apiError_('FORBIDDEN', 'Usuário sem permissão.');
    const allowed = new Set(['name', 'phone', 'photo', 'preferred_theme', 'password', 'area', 'filial', 'updated_at']);
    Object.keys(patch || {}).forEach(key => { if (!allowed.has(key)) throw apiError_('FORBIDDEN', 'Campo de usuário protegido.'); });
    return;
  }
  if (operation === 'insert' && table === 'app_event_logs') {
    if (normalizeEmail_(next.user_email) !== normalizeEmail_(user.email)) throw apiError_('FORBIDDEN', 'Log inválido.');
    return;
  }
  const candidate = next || current || {};
  if (candidate.company_id && !sameCompany_(candidate, user)) throw apiError_('FORBIDDEN', 'Empresa não permitida.');
  if (candidate.user_email && normalizeEmail_(candidate.user_email) === normalizeEmail_(user.email)) return;
  if (candidate.branch && normalizeBranch_(candidate.branch) === normalizeBranch_(user.filial)) return;
  if (candidate.area && normalizeText_(candidate.area) === normalizeText_(user.area)) return;
  if (String(user.role || '').toUpperCase() === 'ADMINISTRATIVO' && sameCompany_(candidate, user)) return;
  throw apiError_('FORBIDDEN', 'Você não tem permissão para esta gravação.');
}

function hasAccess_(user, moduleId) {
  const role = String(user && user.role || 'USER').toUpperCase();
  if (role === 'MASTER') return true;
  const row = listRecords_(CF_TABLES.access_matrix).find(record =>
    String(record.value.level || '').toUpperCase() === role
  );
  return !!(row && row.value && row.value.modules && row.value.modules[moduleId]);
}

function canRead_(table, row, user) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'MASTER') return true;
  if (table === 'users') {
    return normalizeEmail_(row.email) === normalizeEmail_(user.email) ||
      ((role === 'ADMINISTRATIVO' || hasAccess_(user, 'userManagement') || hasAccess_(user, 'userApproval')) && sameCompany_(row, user));
  }
  if (table === 'companies') return !user.company_id || String(row.id || '') === String(user.company_id || '');
  if (['access_matrix', 'configs', 'checklist_definitions'].indexOf(table) >= 0) return true;
  if (row.company_id && !sameCompany_(row, user)) return false;
  if (role === 'ADMINISTRATIVO') return !row.company_id || sameCompany_(row, user);
  if (row.user_email && normalizeEmail_(row.user_email) === normalizeEmail_(user.email)) return true;
  if (row.branch) return normalizeBranch_(row.branch) === normalizeBranch_(user.filial);
  if (row.area) return normalizeText_(row.area) === normalizeText_(user.area);
  return !row.company_id && !row.user_email;
}

function assertWrite_(table, current, next, patch, user, operation) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'MASTER') return;
  if (table === 'companies') {
    if (!hasAccess_(user, 'companyEditing') || !sameCompany_(next || current || {}, user)) {
      throw apiError_('FORBIDDEN', 'Sem permissao para editar esta empresa.');
    }
    return;
  }
  if (CF_MASTER_WRITE_TABLES.has(table)) throw apiError_('FORBIDDEN', 'Apenas o Master pode alterar estes dados.');
  if (table === 'users') {
    const candidate = next || current || {};
    const isSelf = current && normalizeEmail_(current.email) === normalizeEmail_(user.email);
    const canManage = (role === 'ADMINISTRATIVO' || hasAccess_(user, 'userManagement')) && sameCompany_(candidate, user);
    const canApprove = (role === 'ADMINISTRATIVO' || hasAccess_(user, 'userApproval')) && sameCompany_(candidate, user);
    if (!isSelf && !canManage && !canApprove) throw apiError_('FORBIDDEN', 'Usuario sem permissao.');
    const selfFields = new Set(['name', 'phone', 'photo', 'preferred_theme', 'password', 'area', 'filial', 'updated_at']);
    const approvalFields = new Set(['approved', 'rejected', 'updated_at']);
    Object.keys(patch || {}).forEach(key => {
      if (isSelf && selfFields.has(key)) return;
      if (canApprove && approvalFields.has(key)) return;
      if (canManage) return;
      throw apiError_('FORBIDDEN', 'Campo de usuario protegido.');
    });
    return;
  }
  if (operation === 'insert' && table === 'app_event_logs') {
    if (normalizeEmail_(next.user_email) !== normalizeEmail_(user.email)) throw apiError_('FORBIDDEN', 'Log invalido.');
    return;
  }
  const candidate = next || current || {};
  if (candidate.company_id && !sameCompany_(candidate, user)) throw apiError_('FORBIDDEN', 'Empresa nao permitida.');
  if (candidate.user_email && normalizeEmail_(candidate.user_email) === normalizeEmail_(user.email)) return;
  if (candidate.branch && normalizeBranch_(candidate.branch) === normalizeBranch_(user.filial)) return;
  if (candidate.area && normalizeText_(candidate.area) === normalizeText_(user.area)) return;
  if (role === 'ADMINISTRATIVO' && sameCompany_(candidate, user)) return;
  throw apiError_('FORBIDDEN', 'Voce nao tem permissao para esta gravacao.');
}

function preparePasswordMutation_(table, row) {
  if (table !== 'users' || !Object.prototype.hasOwnProperty.call(row, 'password')) return row;
  const password = String(row.password || '');
  if (password.length < 8) throw apiError_('WEAK_PASSWORD', 'A senha deve ter pelo menos 8 caracteres.');
  delete row.password;
  return Object.assign(row, passwordFields_(password));
}

function passwordFields_(password) {
  const salt = randomToken_().slice(0, 32);
  return { password_hash: passwordHash_(password, salt), password_salt: salt, password_version: 'hmac-sha256-v1' };
}

function verifyPassword_(user, password) {
  if (user.password_hash && user.password_salt) {
    return constantEqual_(user.password_hash, passwordHash_(password, user.password_salt));
  }
  return constantEqual_(String(user.password || ''), String(password || ''));
}

function passwordHash_(password, salt) {
  const pepper = PropertiesService.getScriptProperties().getProperty('CF_PASSWORD_PEPPER');
  if (!pepper) throw apiError_('NOT_CONFIGURED', 'Execute setupChecklistFarmaApi antes de publicar.');
  const bytes = Utilities.computeHmacSha256Signature(String(password) + ':' + String(salt), pepper, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes);
}

function createSession_(user) {
  const token = randomToken_() + randomToken_();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CF_SESSION_HOURS * 3600000).toISOString();
  const value = { token_hash: digest_(token), user_email: user.email, created_at: now.toISOString(), expires_at: expiresAt };
  appendRecords_(CF_SESSION_SHEET, [newRecord_(value, ['token_hash'])]);
  return { token: token, user: user, expiresAt: expiresAt };
}

function requireSession_(token) {
  if (!token) throw apiError_('AUTH_REQUIRED', 'Entre novamente para continuar.');
  const hash = digest_(String(token));
  const record = listRecords_(CF_SESSION_SHEET).find(item => constantEqual_(item.value.token_hash, hash));
  if (!record || Date.parse(record.value.expires_at || '') <= Date.now()) {
    if (record) applyChanges_(CF_SESSION_SHEET, [], [], [record]);
    throw apiError_('SESSION_EXPIRED', 'Sua sessão expirou. Entre novamente.');
  }
  const userRecord = listRecords_(CF_TABLES.users).find(item => normalizeEmail_(item.value.email) === normalizeEmail_(record.value.user_email));
  if (!userRecord || !userRecord.value.approved || userRecord.value.rejected) throw apiError_('AUTH_REQUIRED', 'Usuário sem acesso ativo.');
  return { sessionRecord: record, user: sanitizeUser_(userRecord.value) };
}

function revokeSession_(record) { applyChanges_(CF_SESSION_SHEET, [], [], [record]); }

function sanitizeUser_(user) {
  const safe = clone_(user);
  delete safe.password; delete safe.password_hash; delete safe.password_salt; delete safe.password_version;
  return safe;
}

function sanitizeRow_(table, row) { return table === 'users' ? sanitizeUser_(row) : clone_(row); }

function shapeRows_(rows, query) {
  let result = rows.slice();
  (query.orders || []).slice().reverse().forEach(order => result.sort((a, b) => {
    const an = a[order.column] == null, bn = b[order.column] == null;
    if (an !== bn && order.nullsFirst !== undefined) return an === order.nullsFirst ? -1 : 1;
    return compare_(a[order.column], b[order.column]) * (order.ascending === false ? -1 : 1);
  }));
  const total = result.length;
  if (query.rangeStart !== undefined && query.rangeStart !== null) result = result.slice(query.rangeStart, (query.rangeEnd == null ? query.rangeStart : query.rangeEnd) + 1);
  if (query.maxRows !== undefined && query.maxRows !== null) result = result.slice(0, Math.max(0, query.maxRows));
  result = result.map(row => project_(row, query.selectedColumns || '*'));
  const count = query.countMode ? total : null;
  if (query.head) return { data: null, error: null, count: count };
  if (query.singleMode === 'single' && result.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'A consulta não retornou exatamente uma linha.' }, count: count };
  if (query.singleMode === 'maybeSingle' && result.length > 1) return { data: null, error: { code: 'PGRST116', message: 'A consulta retornou mais de uma linha.' }, count: count };
  if (query.singleMode) return { data: result[0] || null, error: null, count: count };
  return { data: result, error: null, count: count };
}

function matches_(row, filters) {
  return filters.every(filter => {
    if (filter.operator === 'or') return String(filter.expression || '').split(',').some(part => {
      const pieces = part.split('.'); const column = pieces.shift(); const operator = pieces.shift(); const value = pieces.join('.');
      if (operator === 'is' && value === 'null') return row[column] == null;
      if (operator === 'neq') return !scalarEqual_(row[column], value);
      return scalarEqual_(row[column], value);
    });
    const actual = row[filter.column];
    if (filter.operator === 'eq') return scalarEqual_(actual, filter.value);
    if (filter.operator === 'neq') return !scalarEqual_(actual, filter.value);
    if (filter.operator === 'gt') return compare_(actual, filter.value) > 0;
    if (filter.operator === 'gte') return compare_(actual, filter.value) >= 0;
    if (filter.operator === 'lt') return compare_(actual, filter.value) < 0;
    if (filter.operator === 'lte') return compare_(actual, filter.value) <= 0;
    if (filter.operator === 'is') return filter.value === null ? actual == null : scalarEqual_(actual, filter.value);
    if (filter.operator === 'in') return (filter.values || []).some(value => scalarEqual_(actual, value));
    return false;
  });
}

var _cachedRecords_ = {};
function listRecords_(sheetName) {
  if (_cachedRecords_[sheetName]) return _cachedRecords_[sheetName];
  const sheet = ensureSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const records = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row[0] || !row[1] || row[4] === '') continue;
    if (String(row[1]).indexOf(CF_CHUNK_KEY_PREFIX) === 0) continue;
    let payload = String(row[4]); let count = 1;
    if (payload.indexOf(CF_CHUNK_PREFIX) === 0) {
      const separator = payload.indexOf('__', CF_CHUNK_PREFIX.length);
      count = Number(payload.slice(CF_CHUNK_PREFIX.length, separator));
      payload = payload.slice(separator + 2);
      for (let chunk = 1; chunk < count; chunk++) payload += String(rows[index + chunk] && rows[index + chunk][4] || '');
      index += count - 1;
    }
    try {
      records.push({ id: String(row[0]), key: String(row[1]), revision: Math.max(1, Number(row[2]) || 1),
        updatedAt: String(row[3] || ''), value: JSON.parse(payload), rowNumber: index - count + 3, physicalRowCount: count });
    } catch (error) { console.warn('Registro inválido em ' + sheetName + ': ' + error); }
  }
  _cachedRecords_[sheetName] = records;
  return records;
}

function applyChanges_(sheetName, append, update, remove) {
  _cachedRecords_ = {};
  const sheet = ensureSheet_(sheetName);
  (append || []).forEach(record => appendRecord_(sheet, record));
  (update || []).forEach(record => writeRecord_(sheetName, record));
  (remove || []).forEach(record => sheet.getRange(record.rowNumber, 1, Math.max(1, record.physicalRowCount || 1), 5).clearContent());
}

function writeRecord_(sheetName, record) {
  const sheet = ensureSheet_(sheetName); const rows = serializeRows_(record); const previous = Math.max(1, record.physicalRowCount || 1);
  if (rows.length > previous) {
    appendRecord_(sheet, record);
    sheet.getRange(record.rowNumber, 1, previous, 5).clearContent();
    return;
  }
  sheet.getRange(record.rowNumber, 1, rows.length, 5).setValues(rows);
  if (rows.length < previous) sheet.getRange(record.rowNumber + rows.length, 1, previous - rows.length, 5).clearContent();
}

function appendRecords_(sheetName, records) { const sheet = ensureSheet_(sheetName); records.forEach(record => appendRecord_(sheet, record)); }
function appendRecord_(sheet, record) { const rows = serializeRows_(record); sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows); }
function serializeRows_(record) {
  const payload = JSON.stringify(record.value); const chunks = [];
  for (let i = 0; i < payload.length; i += CF_MAX_CELL_CHARS) chunks.push(payload.slice(i, i + CF_MAX_CELL_CHARS));
  if (chunks.length <= 1) return [[record.id, record.key, record.revision, record.updatedAt, payload]];
  return chunks.map((chunk, index) => [index === 0 ? record.id : record.id + ':chunk:' + index,
    index === 0 ? record.key : CF_CHUNK_KEY_PREFIX + record.id + ':' + index, record.revision, record.updatedAt,
    index === 0 ? CF_CHUNK_PREFIX + chunks.length + '__' + chunk : chunk]);
}

function newRecord_(value, fields) { const now = nowIso_(); if (!value.id) value.id = Utilities.getUuid(); return { id: String(value.id), key: JSON.stringify(fields.map(f => value[f] == null ? null : value[f])), revision: 1, updatedAt: now, value: value, rowNumber: 0, physicalRowCount: 0 }; }
var _cachedBook_ = null;
var _cachedSheets_ = {};
function getSpreadsheetBook_() { if (!_cachedBook_) { var id = PropertiesService.getScriptProperties().getProperty('CF_SPREADSHEET_ID') || CF_SPREADSHEET_ID; _cachedBook_ = SpreadsheetApp.openById(id); } return _cachedBook_; }
function ensureSheet_(name) { if (_cachedSheets_[name]) return _cachedSheets_[name]; var book = getSpreadsheetBook_(); var sheet = book.getSheetByName(name); if (!sheet) sheet = book.insertSheet(name); if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 5).setValues([CF_HEADERS]); _cachedSheets_[name] = sheet; return sheet; }
function project_(row, columns) { if (!columns || columns.trim() === '*') return clone_(row); const result = {}; columns.split(',').map(c => c.trim()).filter(Boolean).forEach(c => result[c] = clone_(row[c])); return result; }
function sameCompany_(row, user) { return !user.company_id || !row.company_id || String(row.company_id || '') === String(user.company_id || ''); }
function normalizeEmail_(value) { return String(value || '').trim().toLowerCase(); }
function normalizeText_(value) { return String(value || '').trim().toUpperCase(); }
function normalizeBranch_(value) { return normalizeText_(value).replace(/^FILIAL\s*/i, '').replace(/^0+/, ''); }
function scalarEqual_(a, b) { if (a == null) return b == null; if (b == null) return false; return String(a) === String(b); }
function compare_(a, b) { if (a === b) return 0; if (a == null) return -1; if (b == null) return 1; const an = Number(a), bn = Number(b); return isFinite(an) && isFinite(bn) ? an - bn : String(a).localeCompare(String(b)); }
function clone_(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function nowIso_() { return new Date().toISOString(); }
function randomToken_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); }
function digest_(value) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)); }
function constantEqual_(a, b) { a = String(a || ''); b = String(b || ''); let diff = a.length ^ b.length; const length = Math.max(a.length, b.length); for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0); return diff === 0; }
function apiError_(code, message) { const error = new Error(message); error.code = code; return error; }
function json_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function enforceLoginRateLimit_(email) { const count = Number(CacheService.getScriptCache().get('login:' + email) || 0); if (count >= 8) throw apiError_('RATE_LIMITED', 'Muitas tentativas. Aguarde cinco minutos.'); }
function registerLoginFailure_(email) { const cache = CacheService.getScriptCache(); const key = 'login:' + email; cache.put(key, String(Number(cache.get(key) || 0) + 1), 300); }
function clearLoginFailures_(email) { CacheService.getScriptCache().remove('login:' + email); }
