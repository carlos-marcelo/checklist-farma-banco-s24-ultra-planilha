export const MANAGED_SHEET_HEADERS = [
    'id',
    'record_key',
    'revision',
    'updated_at',
    'payload_json',
] as const;

export const GOOGLE_WORKSPACE_SCHEMA_VERSION = 1;

export const GOOGLE_WORKSPACE_TABLES = [
    'cf_metadata',
    'cf_users',
    'cf_companies',
    'cf_app_config',
    'cf_access_matrix',
    'cf_checklist_definitions',
    'cf_checklist_reports',
    'cf_stock_sessions',
    'cf_stock_reports',
    'cf_pv_sessions',
    'cf_audit_sessions',
    'cf_pv_active_sales_reports',
    'cf_pv_branch_records',
    'cf_pv_sales_history',
    'cf_pv_sales_uploads',
    'cf_pv_sales_analysis_reports',
    'cf_pv_branch_record_events',
    'cf_app_event_logs',
    'cf_global_base_files',
    'cf_pv_dashboard_reports',
    'cf_pv_inventory_reports',
    'cf_pv_reports',
    'cf_drafts',
    'cf_tickets',
    'cf_active_sessions',
] as const;

export type GoogleWorkspaceTable = typeof GOOGLE_WORKSPACE_TABLES[number];

export const GOOGLE_SOURCE_TABLE_MAP = {
    checklist_definitions: 'cf_checklist_definitions',
    users: 'cf_users',
    companies: 'cf_companies',
    access_matrix: 'cf_access_matrix',
    configs: 'cf_app_config',
    reports: 'cf_checklist_reports',
    stock_conference_sessions: 'cf_stock_sessions',
    stock_conference_reports: 'cf_stock_reports',
    pv_sessions: 'cf_pv_sessions',
    audit_sessions: 'cf_audit_sessions',
    pv_active_sales_reports: 'cf_pv_active_sales_reports',
    pv_branch_records: 'cf_pv_branch_records',
    pv_sales_history: 'cf_pv_sales_history',
    pv_sales_uploads: 'cf_pv_sales_uploads',
    pv_sales_analysis_reports: 'cf_pv_sales_analysis_reports',
    pv_branch_record_events: 'cf_pv_branch_record_events',
    app_event_logs: 'cf_app_event_logs',
    global_base_files: 'cf_global_base_files',
    pv_dashboard_reports: 'cf_pv_dashboard_reports',
    pv_inventory_reports: 'cf_pv_inventory_reports',
    pv_reports: 'cf_pv_reports',
    drafts: 'cf_drafts',
    tickets: 'cf_tickets',
    active_sessions: 'cf_active_sessions',
} as const satisfies Record<string, GoogleWorkspaceTable>;

export type GoogleSourceTable = keyof typeof GOOGLE_SOURCE_TABLE_MAP;

export const GOOGLE_SOURCE_KEY_FIELDS: Record<GoogleSourceTable, readonly string[]> = {
    checklist_definitions: ['id'],
    users: ['email'],
    companies: ['id'],
    access_matrix: ['level'],
    configs: ['id'],
    reports: ['id'],
    stock_conference_sessions: ['user_email'],
    stock_conference_reports: ['id'],
    pv_sessions: ['user_email'],
    audit_sessions: ['branch', 'audit_number'],
    pv_active_sales_reports: ['company_id', 'branch'],
    pv_branch_records: ['id'],
    pv_sales_history: ['id'],
    pv_sales_uploads: ['id'],
    pv_sales_analysis_reports: ['company_id', 'branch', 'period_label'],
    pv_branch_record_events: ['id'],
    app_event_logs: ['id'],
    global_base_files: ['company_id', 'module_key'],
    pv_dashboard_reports: ['id'],
    pv_inventory_reports: ['company_id', 'branch'],
    pv_reports: ['user_email', 'report_type'],
    drafts: ['user_email'],
    tickets: ['id'],
    active_sessions: ['client_id'],
};

export const isGoogleWorkspaceTable = (value: string): value is GoogleWorkspaceTable =>
    (GOOGLE_WORKSPACE_TABLES as readonly string[]).includes(value);

export const quoteSheetTitle = (title: string): string =>
    `'${title.replace(/'/g, "''")}'`;
