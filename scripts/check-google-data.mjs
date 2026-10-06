import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true },
});

const testId = `google-sheets-check-${Date.now()}`;
const largePayload = 'x'.repeat(90_000);

try {
  const { supabase } = await vite.ssrLoadModule('/supabaseClient.ts');
  const userService = await vite.ssrLoadModule('/supabaseService.ts');

  const users = await userService.fetchUsers();
  const loginCandidate = users.find(user => user.email && user.password && user.approved && !user.rejected);
  if (!loginCandidate) throw new Error('Nenhuma conta aprovada e completa foi encontrada no Google Sheets.');
  const loginResult = await userService.authenticateUser(loginCandidate.email, loginCandidate.password);
  if (loginResult.status !== 'success') {
    throw new Error(`Falha no contrato de login pelo Google Sheets: ${loginResult.status}`);
  }

  const inserted = await supabase
    .from('tickets')
    .insert({
      id: testId,
      title: 'Teste automático Google Sheets',
      description: largePayload,
      status: 'OPEN',
      user_email: 'integration-check@local.invalid',
      user_name: 'Integration Check',
    })
    .select()
    .single();
  if (inserted.error || inserted.data?.id !== testId) {
    throw new Error(`Falha no INSERT: ${inserted.error?.message || 'resposta inválida'}`);
  }

  const selected = await supabase.from('tickets').select('*').eq('id', testId).single();
  if (selected.error || selected.data?.status !== 'OPEN' || selected.data?.description?.length !== largePayload.length) {
    throw new Error(`Falha no SELECT: ${selected.error?.message || 'registro não encontrado'}`);
  }

  const updated = await supabase
    .from('tickets')
    .update({ status: 'CLOSED' })
    .eq('id', testId)
    .select('*')
    .single();
  if (updated.error || updated.data?.status !== 'CLOSED') {
    throw new Error(`Falha no UPDATE: ${updated.error?.message || 'registro não atualizado'}`);
  }

  const removed = await supabase.from('tickets').delete().eq('id', testId).select('id').single();
  if (removed.error || removed.data?.id !== testId) {
    throw new Error(`Falha no DELETE: ${removed.error?.message || 'registro não removido'}`);
  }

  const absent = await supabase.from('tickets').select('id').eq('id', testId).maybeSingle();
  if (absent.error || absent.data !== null) throw new Error('O registro temporário permaneceu na planilha.');

  console.log('Google Sheets login and CRUD check passed (insert/select/update/delete).');
} finally {
  try {
    const { supabase } = await vite.ssrLoadModule('/supabaseClient.ts');
    await supabase.from('tickets').delete().eq('id', testId);
  } catch {
    // A tentativa de limpeza não deve ocultar o erro original.
  }
  await vite.close();
}
