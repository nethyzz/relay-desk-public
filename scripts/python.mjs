import { command, python } from './deployment.mjs';
try { command(python(), process.argv.slice(2), { inherit: true }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
