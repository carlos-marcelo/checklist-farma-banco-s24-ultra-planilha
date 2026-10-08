# API segura do Google Sheets

Esta pasta contem o backend usado pelo site publico. Ele executa na sua conta
Google, acessa somente a planilha configurada e nao possui conexao com Termux,
Supabase, PostgREST ou com o projeto original.

## Criacao e primeira implantacao

1. Abra <https://script.google.com/home/projects/create> e crie um projeto com
   o nome `Checklist Farma API`.
2. Substitua o conteudo de `Code.gs` pelo arquivo `apps-script/Code.gs` deste
   repositorio.
3. No inicio do `Code.gs`, substitua `COLE_AQUI_O_ID_DA_PLANILHA` pelo ID da
   planilha oficial. Faca isso apenas no editor privado do Apps Script; nao
   grave o ID no arquivo do GitHub.
4. Em **Configuracoes do projeto**, marque a exibicao do arquivo de manifesto e
   substitua `appsscript.json` pelo arquivo desta pasta.
5. No seletor de funcoes, escolha `setupChecklistFarmaApi`, clique em
   **Executar** e autorize o acesso a Planilhas Google. Essa funcao cria o
   segredo privado de senhas e a aba tecnica de sessoes.
6. Clique em **Implantar > Nova implantacao > Aplicativo da Web**.
7. Em **Executar como**, escolha **Eu**. Em **Quem pode acessar**, escolha
   **Qualquer pessoa**. O acesso aos dados continua protegido pelo login e
   pelas permissoes verificadas no servidor.
8. Implante e copie a URL terminada em `/exec`.
9. No GitHub, abra **Settings > Secrets and variables > Actions > Variables** e
   crie `VITE_GOOGLE_APPS_SCRIPT_URL` com essa URL completa.

O codigo do navegador recebe somente um token de sessao temporario. Ele nao
recebe token OAuth do Google, senha armazenada, segredo do servidor ou acesso
direto a planilha.

## Corte definitivo das senhas legadas

Depois de testar o login pelo Web App e imediatamente antes de publicar:

1. No editor do Apps Script, selecione `migrateAllLegacyPasswords`.
2. Clique em **Executar** uma unica vez.
3. Confira o registro de execucao, que informa quantas senhas foram migradas.

Essa operacao substitui as senhas em texto puro por hash com salt e segredo
privado do Apps Script. Depois dela, a autenticacao deve ser feita por esta API;
o projeto antigo que compara a senha diretamente deixa de autenticar esses
usuarios. Ela nao altera empresas, permissoes, historicos ou outros dados.

## Atualizacoes futuras

Ao alterar `Code.gs`, use **Implantar > Gerenciar implantacoes > Editar**, crie
uma nova versao e implante novamente. A URL `/exec` pode permanecer a mesma.
Nunca coloque o segredo `CF_PASSWORD_PEPPER` no GitHub; ele fica apenas nas
Propriedades do script.
