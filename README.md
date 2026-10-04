# Checklist Farma - Migracao para Google Drive e Planilhas

Esta e uma copia independente do projeto original. O backend legado baseado em
Termux, PostgreSQL, PostgREST e Cloudflare esta intencionalmente desativado.

## Estado atual

- Nenhuma URL, proxy ou credencial do backend legado e usada em runtime.
- O cliente de dados antigo responde localmente com `LEGACY_BACKEND_DISABLED`.
- O servidor de desenvolvimento aceita conexoes apenas em `127.0.0.1`.
- A publicacao automatica esta pausada durante a migracao.
- A nova camada de Google Drive/Planilhas sera implementada nesta copia.

## Desenvolvimento local

```bash
npm install
npm run check:offline
npm run dev
```

Enquanto a migracao nao estiver concluida, operacoes que dependiam do banco
remoto podem usar apenas caches locais ou exibir indisponibilidade.

## Seguranca

Nao adicione variaveis `VITE_SUPABASE_*`, URLs do tunel antigo, dumps, tokens ou
arquivos `.env` ao repositorio. O projeto original permanece separado.
