import { execSync } from 'child_process';

try {
  const netstat = execSync('netstat -ano | findstr :3000', { encoding: 'utf-8' });
  console.log('Netstat output:');
  console.log(netstat);
  const lines = netstat.trim().split('\n').filter(Boolean);
  const pids = new Set();
  lines.forEach(l => {
    const parts = l.trim().split(/\s+/);
    if (parts.length >= 5) pids.add(parts[parts.length - 1]);
  });
  console.log('PIDs on port 3000:', Array.from(pids));
  for (const pid of pids) {
    try {
      const output = execSync('powershell -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId = ' + pid + '\\").CommandLine"', { encoding: 'utf-8' });
      console.log('PID ' + pid + ' CommandLine:\n' + output);
    } catch (e) {
      console.log('Could not get info for PID ' + pid + ':', e.message);
    }
  }
} catch (err) {
  console.log('Nenhum processo ouvindo na porta 3000:', err.message);
}
