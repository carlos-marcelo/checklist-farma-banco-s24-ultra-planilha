import localforage from 'localforage';
import * as SupabaseService from '../../supabaseService';
import type { DbGlobalBaseFile } from '../../supabaseService';
import { decodeStoredFilePayloadToBlob } from '../filePayload';

// Configura o banco de dados IndexedDB via localforage
localforage.config({
  name: 'ChecklistFarma',
  storeName: 'cadastros_base', // Name of the object store
  description: 'Cache local para arquivos base globais pesados'
});

// Cache em memória para acesso ultrarrápido durante a sessão
const inMemoryCache = new Map<string, DbGlobalBaseFile>();

// Controle de requisições em andamento para evitar downloads duplicados simultâneos
const pendingRequests = new Map<string, Promise<DbGlobalBaseFile | null>>();
const lastValidationAt = new Map<string, number>();
const BACKGROUND_VALIDATION_INTERVAL_MS = 60_000;
const CADASTROS_DEBUG = import.meta.env.DEV && Boolean((globalThis as any).__CADASTROS_DEBUG);
let baseCacheGeneration = 0;
const cadastrosDebugLog = (...args: any[]) => {
  if (CADASTROS_DEBUG) console.log(...args);
};

const persistBaseCache = (cacheKey: string, data: unknown) => {
  const scheduledGeneration = baseCacheGeneration;
  const persist = () => {
    if (scheduledGeneration !== baseCacheGeneration) return;
    void localforage.setItem(cacheKey, data).catch(error => {
      console.warn(`[CadastrosBaseService] Falha ao persistir cache ${cacheKey}:`, error);
    });
  };
  const requestIdleCallback = typeof window !== 'undefined'
    ? (window as any).requestIdleCallback as undefined | ((callback: () => void, options?: { timeout?: number }) => number)
    : undefined;
  if (requestIdleCallback) {
    requestIdleCallback(persist, { timeout: 1800 });
  } else {
    globalThis.setTimeout(persist, 0);
  }
};

async function attachParsedFile(data: DbGlobalBaseFile & { _blob?: Blob, _parsedFile?: File }): Promise<DbGlobalBaseFile> {
  if (data._parsedFile) return data as DbGlobalBaseFile;

  try {
    let blob = data._blob;
    if (!blob && data.file_data_base64) {
      blob = await decodeStoredFilePayloadToBlob(data.file_data_base64, data.mime_type);
      if (blob) data._blob = blob;
    }

    if (blob) {
      data._parsedFile = new File([blob], data.file_name || `${data.module_key || 'base'}.xlsx`, {
        type: blob.type || data.mime_type || 'application/octet-stream'
      });
    }
  } catch (err) {
    console.error('Erro ao fazer parse assíncrono do arquivo:', err);
  }
  return data as DbGlobalBaseFile;
}

export const CadastrosBaseService = {
  /**
   * Obtém um arquivo base global do cache em memória, do cache local (se atualizado), 
   * ou baixa do Supabase (e salva nos caches).
   * Segue o padrão Cache-First: retorna do local imediatamente e valida em background.
   */
  async getGlobalBaseFileCached(
    companyId: string,
    moduleKey: string,
    options?: { forceFresh?: boolean; preferRemote?: boolean }
  ): Promise<DbGlobalBaseFile | null> {
    const cacheKey = `global_base_${companyId}_${moduleKey}`;
    const forceFresh = !!options?.forceFresh;
    const preferRemote = !!options?.preferRemote;

    // Se já existe uma promessa idêntica em andamento, retorna ela
    if (pendingRequests.has(cacheKey)) {
      cadastrosDebugLog(`[CadastrosBaseService] Reuso de request em andamento para ${moduleKey}`);
      return pendingRequests.get(cacheKey)!;
    }

    const fetchPromise = (async () => {
      cadastrosDebugLog(`[CadastrosBaseService] Início de getGlobalBaseFileCached para ${moduleKey} (Cache-First)`);
      const startTime = performance.now();

      try {
        // 1. Verifica cache em memória primeiro (Instantâneo)
        let localData = inMemoryCache.get(cacheKey) || null;

        // 2. Se não está em memória, verifica IndexedDB
        if (!localData) {
          const cachedItem: any = await localforage.getItem(cacheKey);
          if (cachedItem && (cachedItem.file_data_base64 || cachedItem._blob || cachedItem._parsedFile)) {
            cadastrosDebugLog(`[CadastrosBaseService] IndexedDB HIT para ${moduleKey}`);
            localData = await attachParsedFile(cachedItem);
            inMemoryCache.set(cacheKey, localData);
          }
        }

        // Se já temos a base local (em memória ou no IndexedDB):
        if (localData) {
          // Se foi solicitado preferRemote ou forceFresh: valida apenas metadados (< 300 bytes, instantâneo, sem 404)
          if (preferRemote || forceFresh) {
            try {
              const remoteMeta = await SupabaseService.fetchGlobalBaseFileMeta(companyId, moduleKey);
              const remoteUpdated = remoteMeta?.updated_at || remoteMeta?.uploaded_at || '';
              const currentUpdated = localData.updated_at || localData.uploaded_at || '';

              // Se o servidor tem uma versão estritamente mais nova, baixa o arquivo atualizado
              if (remoteMeta && remoteUpdated && remoteUpdated !== currentUpdated) {
                cadastrosDebugLog(`[CadastrosBaseService] Nova versão remota detectada para ${moduleKey}, atualizando...`);
                const fullRemoteData = await SupabaseService.fetchGlobalBaseFileFull(companyId, moduleKey);
                if (fullRemoteData) {
                  const preparedData = await attachParsedFile(fullRemoteData);
                  const dataToSave = { ...preparedData, file_data_base64: null };
                  inMemoryCache.set(cacheKey, preparedData);
                  lastValidationAt.set(cacheKey, Date.now());
                  persistBaseCache(cacheKey, dataToSave);
                  return preparedData;
                }
              }
            } catch (metaErr) {
              cadastrosDebugLog(`[CadastrosBaseService] Validação de versão remota adiada para ${moduleKey}:`, metaErr);
            }
            lastValidationAt.set(cacheKey, Date.now());
            return localData;
          }

          // Se não exige checagem imediata, agenda background sync e entrega instantaneamente
          this.syncInBackground(companyId, moduleKey, cacheKey, localData);
          return localData;
        }

        // 3. Cache MISS absoluto: nunca foi baixado nesta máquina. Baixa do servidor:
        cadastrosDebugLog(`[CadastrosBaseService] Cache MISS para ${moduleKey}, baixando...`);
        const fullRemoteData = await SupabaseService.fetchGlobalBaseFileFull(companyId, moduleKey);

        if (fullRemoteData) {
          const preparedData = await attachParsedFile(fullRemoteData);
          const dataToSave = { ...preparedData, file_data_base64: null };
          inMemoryCache.set(cacheKey, preparedData);
          lastValidationAt.set(cacheKey, Date.now());
          persistBaseCache(cacheKey, dataToSave);
          return preparedData;
        }

        return null;
      } catch (error) {
        console.error('Erro na rotina de cache do CadastrosBase:', error);
        return null;
      } finally {
        pendingRequests.delete(cacheKey);
      }
    })();

    pendingRequests.set(cacheKey, fetchPromise);
    return fetchPromise;
  },

  /**
   * Sincroniza o arquivo em background se houver nova versão no servidor.
   */
  async syncInBackground(companyId: string, moduleKey: string, cacheKey: string, localData: DbGlobalBaseFile) {
    const lastValidation = lastValidationAt.get(cacheKey) || 0;
    if (Date.now() - lastValidation < BACKGROUND_VALIDATION_INTERVAL_MS) return;
    lastValidationAt.set(cacheKey, Date.now());
    try {
      const remoteMeta = await SupabaseService.fetchGlobalBaseFileMeta(companyId, moduleKey);
      if (remoteMeta) {
        const remoteUpdated = remoteMeta.updated_at || remoteMeta.uploaded_at || '';
        const localUpdated = localData.updated_at || localData.uploaded_at || '';

        if (remoteUpdated !== localUpdated) {
          cadastrosDebugLog(`[CadastrosBaseService] Nova versão detectada para ${moduleKey}, atualizando em background...`);
          const fullRemoteData = await SupabaseService.fetchGlobalBaseFileFull(companyId, moduleKey);
          if (fullRemoteData) {
            const preparedData = await attachParsedFile(fullRemoteData);
            const dataToSave = { ...preparedData, file_data_base64: null };
            inMemoryCache.set(cacheKey, preparedData);
            persistBaseCache(cacheKey, dataToSave);
            cadastrosDebugLog(`[CadastrosBaseService] Cache atualizado com sucesso: ${moduleKey}`);
          }
        }
      }
    } catch (err) {
      console.error(`[CadastrosBaseService] Erro no sync em background (${moduleKey}):`, err);
    }
  },

  /** Remove somente a base alterada, preservando os demais arquivos já aquecidos. */
  async invalidateGlobalBaseFile(companyId: string, moduleKey: string) {
    const cacheKey = `global_base_${companyId}_${moduleKey}`;
    inMemoryCache.delete(cacheKey);
    lastValidationAt.delete(cacheKey);
    pendingRequests.delete(cacheKey);
    await localforage.removeItem(cacheKey);
  },

  /**
   * Limpa todo o cache (útil para logout ou reset)
   */
  async clearCache() {
    try {
      baseCacheGeneration += 1;
      inMemoryCache.clear();
      lastValidationAt.clear();
      await localforage.clear();
      cadastrosDebugLog('Cache de Cadastros Base limpado.');
    } catch (error) {
      console.error('Erro ao limpar cache:', error);
    }
  }
};
