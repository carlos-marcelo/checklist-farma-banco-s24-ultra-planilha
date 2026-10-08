export const GOOGLE_WORKSPACE_SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
].join(' ');

export interface GoogleWorkspaceConfig {
    clientId: string;
    authServerUrl?: string;
    appsScriptUrl?: string;
    spreadsheetId?: string;
    folderId?: string;
    spreadsheetName: string;
}

const optionalEnv = (value: unknown): string | undefined => {
    const normalized = String(value ?? '').trim();
    return normalized || undefined;
};

export const getGoogleWorkspaceConfig = (): GoogleWorkspaceConfig => ({
    clientId: optionalEnv(import.meta.env.VITE_GOOGLE_CLIENT_ID) || '',
    authServerUrl: optionalEnv(import.meta.env.VITE_GOOGLE_AUTH_SERVER_URL),
    appsScriptUrl: optionalEnv(import.meta.env.VITE_GOOGLE_APPS_SCRIPT_URL),
    spreadsheetId: optionalEnv(import.meta.env.VITE_GOOGLE_SPREADSHEET_ID),
    folderId: optionalEnv(import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID),
    spreadsheetName: optionalEnv(import.meta.env.VITE_GOOGLE_SPREADSHEET_NAME)
        || 'Checklist Farma - Dados',
});

export const isGoogleWorkspaceConfigured = (): boolean =>
    Boolean(
        getGoogleWorkspaceConfig().appsScriptUrl ||
        getGoogleWorkspaceConfig().clientId ||
        getGoogleWorkspaceConfig().authServerUrl
    );

export const isGoogleAppsScriptConfigured = (): boolean =>
    Boolean(getGoogleWorkspaceConfig().appsScriptUrl);
