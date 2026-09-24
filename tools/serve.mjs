#!/usr/bin/env node
// Dev server: node tools/serve.mjs [port]  ->  http://localhost:8080
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;
await startStaticServer(root, port, '0.0.0.0');
console.log(`Stereo Sandbox dev server: http://localhost:${port}/  (single-file build: http://localhost:${port}/dist/)`);
