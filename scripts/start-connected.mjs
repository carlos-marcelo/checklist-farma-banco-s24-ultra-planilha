import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const children = [];
const start = (file, args) => {
    const child = spawn(process.execPath, [file, ...args], {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
    });
    children.push(child);
    return child;
};

const auth = start(path.join(root, 'server', 'googleOAuthServer.mjs'), []);
const vite = start(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), [
    '--host', '127.0.0.1',
    '--port', '3001',
    '--strictPort',
]);

let shuttingDown = false;
const shutdown = exitCode => {
    if (shuttingDown) return;
    shuttingDown = true;
    children.forEach(child => child.kill());
    setTimeout(() => process.exit(exitCode), 200).unref();
};

auth.on('exit', code => shutdown(code || 0));
vite.on('exit', code => shutdown(code || 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

