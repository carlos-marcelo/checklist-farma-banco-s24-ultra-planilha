# Checklist Farma - Migracao para Google Drive e Planilhas

Esta e uma copia independente do projeto original. O backend legado baseado em
Termux, PostgreSQL, PostgREST e Cloudflare esta intencionalmente desativado.

## Estado atual

- Nenhuma URL, proxy ou credencial do backend legado e usada em runtime.
- O servidor de desenvolvimento aceita conexoes apenas em `127.0.0.1`.
- Os fluxos de dados usam uma camada de compatibilidade apoiada exclusivamente
  nas abas gerenciadas do Google Sheets.
- O arquivo de ambiente legado foi removido depois da importacao unilateral.
- A dependencia do cliente Supabase foi removida do projeto.
- Nao existe proxy, URL ou cliente runtime para Termux/PostgREST nesta copia.

## Google Drive e Planilhas

1. No Google Cloud, habilite as APIs **Google Drive API** e **Google Sheets API**.
2. Configure a tela de consentimento OAuth e crie um Client ID do tipo
   **Aplicativo da Web**.
3. Cadastre `http://localhost:3000` como origem JavaScript autorizada. Ao
   publicar, cadastre tambem a origem HTTPS real.
4. Copie `.env.example` para `.env.local` e preencha apenas
   `VITE_GOOGLE_CLIENT_ID`. O frontend nunca deve receber um Client Secret.
5. Entre como usuario `MASTER`, abra **Configuracoes** e use
   **Conectar ao Google**. O app localiza ou cria a planilha e prepara as abas
   gerenciadas com prefixo `cf_`.

O acesso usa Google Identity Services no navegador. O token e curto, fica
somente em memoria e precisa ser renovado por uma acao do usuario quando
expirar. A integracao solicita os escopos `drive.file` e `spreadsheets`.

Para uso local persistente, `npm run dev:connected` inicia tambem o servidor
OAuth em `127.0.0.1:8787`. Depois do primeiro consentimento, o refresh token e
mantido fora do repositorio no caminho definido por `GOOGLE_OAUTH_TOKEN_PATH`;
o frontend recebe apenas tokens de acesso curtos. Nunca versionar o JSON OAuth
nem o arquivo de token.

Variaveis opcionais:

- `VITE_GOOGLE_SPREADSHEET_ID`: usa uma planilha especifica.
- `VITE_GOOGLE_DRIVE_FOLDER_ID`: pasta onde a nova planilha sera criada.
- `VITE_GOOGLE_SPREADSHEET_NAME`: nome usado ao criar a planilha.

As abas possuem chave estavel, revisao, data de atualizacao e payload JSON.
Payloads maiores que uma celula sao fragmentados e reconstruidos
automaticamente. Usuarios, empresas, permissoes, historicos e demais registros
sao lidos e gravados nas abas `cf_*` da planilha gerenciada.

`npm run check:google-data` executa um CRUD temporario (incluindo payload grande)
e remove o registro de teste ao final.

## Desenvolvimento local

```bash
npm install
npm run check:offline
npm run dev
```

O cache local e apenas uma copia de desempenho. Uma versao de cache e aplicada
apos importacoes completas para obrigar a interface a reler os dados do Sheets.

## Seguranca

Nao adicione variaveis `VITE_SUPABASE_*`, URLs do tunel antigo, dumps, tokens ou
arquivos `.env` ao repositorio. `npm run check:offline` bloqueia configuracoes e
dependencias legadas. O projeto original permanece separado.
