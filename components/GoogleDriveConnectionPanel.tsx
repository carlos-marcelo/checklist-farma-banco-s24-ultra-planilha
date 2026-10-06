import React, { useEffect, useState } from 'react';
import { CheckCircle, Cloud, ExternalLink, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import {
    googleWorkspaceService,
    GoogleWorkspaceConnection,
} from '../src/googleWorkspace';
import { GoogleAuthorizationRequiredError } from '../src/googleWorkspace/auth';

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Não foi possível conectar ao Google Drive.';

export const GoogleDriveConnectionPanel: React.FC = () => {
    const [connection, setConnection] = useState<GoogleWorkspaceConnection | null>(
        googleWorkspaceService.getConnection()
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const status = googleWorkspaceService.getStatus();

    useEffect(() => {
        if (!status.configured || connection) return;
        let active = true;
        setLoading(true);
        googleWorkspaceService.connectAndInitialize(false)
            .then(result => { if (active) setConnection(result); })
            .catch(cause => {
                if (active && !(cause instanceof GoogleAuthorizationRequiredError)) {
                    setError(errorMessage(cause));
                }
            })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    const handleConnect = async () => {
        setLoading(true);
        setError(null);
        try {
            setConnection(await googleWorkspaceService.connectAndInitialize());
        } catch (cause) {
            setConnection(null);
            setError(errorMessage(cause));
        } finally {
            setLoading(false);
        }
    };

    const handleDisconnect = async () => {
        await googleWorkspaceService.disconnect();
        setConnection(null);
        setError(null);
    };

    return (
        <section className="bg-white/80 backdrop-blur-2xl rounded-[40px] shadow-card border border-white/60 p-8 md:p-10">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8">
                <div className="flex items-start gap-5">
                    <div className="p-4 rounded-2xl bg-green-50 text-green-600">
                        <Cloud size={30} strokeWidth={2.5} />
                    </div>
                    <div>
                        <div className="flex flex-wrap items-center gap-3">
                            <h2 className="text-xl font-black text-gray-900">Google Drive e Planilhas</h2>
                            {connection && (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-green-700">
                                    <CheckCircle size={13} /> Conectado
                                </span>
                            )}
                        </div>
                        <p className="mt-2 max-w-2xl text-sm font-semibold text-gray-500">
                            Autorize sua conta para preparar a planilha gerenciada desta cópia de migração.
                            Nenhum dado legado é enviado automaticamente.
                        </p>
                        <div className="mt-3 flex items-center gap-2 text-xs font-bold text-gray-400">
                            <ShieldCheck size={15} /> O token de acesso permanece somente na memória desta aba.
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    {connection ? (
                        <>
                            <a
                                href={connection.spreadsheetUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 rounded-2xl bg-green-600 px-6 py-3 text-sm font-black text-white shadow-lg transition hover:bg-green-700"
                            >
                                Abrir planilha <ExternalLink size={17} />
                            </a>
                            <button
                                type="button"
                                onClick={handleDisconnect}
                                className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-3 text-sm font-black text-gray-600 transition hover:bg-gray-50"
                            >
                                <LogOut size={17} /> Desconectar
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={handleConnect}
                            disabled={!status.configured || loading}
                            className="inline-flex items-center gap-2 rounded-2xl bg-green-600 px-6 py-3 text-sm font-black text-white shadow-lg transition hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:shadow-none"
                        >
                            {loading ? <Loader2 size={18} className="animate-spin" /> : <Cloud size={18} />}
                            {loading ? 'Preparando...' : 'Conectar ao Google'}
                        </button>
                    )}
                </div>
            </div>

            {!status.configured && (
                <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-bold text-amber-800">
                    Configure <code>VITE_GOOGLE_CLIENT_ID</code> no arquivo <code>.env.local</code> para habilitar a conexão.
                </p>
            )}
            {error && (
                <p role="alert" className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-700">
                    {error}
                </p>
            )}
            {connection && (
                <p className="mt-6 truncate rounded-2xl bg-gray-50 px-5 py-4 text-xs font-bold text-gray-500">
                    {connection.spreadsheetName} · ID {connection.spreadsheetId}
                </p>
            )}
        </section>
    );
};
