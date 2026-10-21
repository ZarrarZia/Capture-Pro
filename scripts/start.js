// Launches Electron with a clean environment. Hosts like VS Code set ELECTRON_RUN_AS_NODE,
// which would make electron.exe behave as plain Node.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
