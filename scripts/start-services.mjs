import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');

console.log('Starting Local Auth Server on port 54321...');
const authProc = spawn('node', ['scripts/local-auth-server.mjs'], {
  cwd: backendDir,
  stdio: 'inherit',
});

// Wait 1 second before starting backend
setTimeout(() => {
  console.log('Starting NestJS Backend on port 3000...');
  const backendProc = spawn('npx', ['dotenv', '-e', '.env', '--', 'node', 'dist/main.js'], {
    cwd: backendDir,
    stdio: 'inherit',
  });

  const cleanup = () => {
    console.log('Shutting down services...');
    authProc.kill();
    backendProc.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}, 1000);
