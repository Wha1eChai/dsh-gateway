#!/usr/bin/env node

import { startFakeCpa, DEFAULT_HOST } from './index.js';
import { pathToFileURL } from 'node:url';

function usage() {
  return [
    'Usage: fake-cpa [--host 127.0.0.1] [--port 0]',
    '',
    'Starts the deterministic private CPA fixture and prints one JSON ready record.',
    'The fixture accepts no runtime behavior/control flags; use the programmatic API for tests.',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version' || arg === '-v') return { version: true };
    if (arg === '--host' || arg === '--port') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      if (arg === '--host') options.host = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('--port must be an integer');
        options.port = Number(value);
      }
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    if (options.version) {
      const { DEFAULT_VERSION } = await import('./index.js');
      console.log(DEFAULT_VERSION);
      process.exit(0);
    }
    const server = await startFakeCpa(options);
    console.log(JSON.stringify({ event: 'ready', url: server.url, host: server.address.host, port: server.address.port, version: server.version }));
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
