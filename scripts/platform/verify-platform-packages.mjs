import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXPECTED = [
  {
    packageName: '@dshapps/dsh-gateway-platform-win32-x64',
    directory: 'packages/platform/win32-x64',
    os: 'win32',
    cpu: 'x64',
    asset: 'CLIProxyAPI_7.2.131_windows_amd64.zip',
    sha256: '99cc6a185012f01396e2bad3f3ba902bf1455e82fa1630d652ab818b77ed2384',
    binaryPath: 'vendor/cli-proxy-api.exe',
  },
  {
    packageName: '@dshapps/dsh-gateway-platform-win32-arm64',
    directory: 'packages/platform/win32-arm64',
    os: 'win32',
    cpu: 'arm64',
    asset: 'CLIProxyAPI_7.2.131_windows_aarch64.zip',
    sha256: 'a1e0023009493218a202e3e17cb7c51ae836e44b5ae67d0041f835e869477bfe',
    binaryPath: 'vendor/cli-proxy-api.exe',
  },
  {
    packageName: '@dshapps/dsh-gateway-platform-darwin-x64',
    directory: 'packages/platform/darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    asset: 'CLIProxyAPI_7.2.131_darwin_amd64.tar.gz',
    sha256: '3626c427ba0526f6d25d83063195bc418f5b242b108de0778d887e0b8de3323f',
    binaryPath: 'vendor/cli-proxy-api',
  },
  {
    packageName: '@dshapps/dsh-gateway-platform-darwin-arm64',
    directory: 'packages/platform/darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    asset: 'CLIProxyAPI_7.2.131_darwin_aarch64.tar.gz',
    sha256: 'ec63a4f99da029ed04d8373c17152274d85f524c92c1b2da36b9c70cbadd0afe',
    binaryPath: 'vendor/cli-proxy-api',
  },
  {
    packageName: '@dshapps/dsh-gateway-platform-linux-x64',
    directory: 'packages/platform/linux-x64',
    os: 'linux',
    cpu: 'x64',
    asset: 'CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz',
    sha256: 'a7e1127d10e908f37fa7bb5f5f4a9aebb26e5baca17c7bd92987df3a0bda9043',
    binaryPath: 'vendor/cli-proxy-api',
  },
  {
    packageName: '@dshapps/dsh-gateway-platform-linux-arm64',
    directory: 'packages/platform/linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    asset: 'CLIProxyAPI_7.2.131_linux_aarch64_no-plugin.tar.gz',
    sha256: 'c82bd3dfb62da2ff567930d928c8aaf33f384917bdfc197f28ddbf7ff50509f3',
    binaryPath: 'vendor/cli-proxy-api',
  },
];

const ALLOWED_LIFECYCLE_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly',
  'publish', 'postpublish', 'prepack', 'postpack', 'dependencies',
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) result.set(match[2].trim(), match[1].toLowerCase());
  }
  return result;
}

async function listFiles(directory) {
  const result = [];
  async function visit(current, relative) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      assert(!stat.isSymbolicLink(), `symbolic link is not allowed in package payload: ${nextRelative}`);
      if (stat.isDirectory()) await visit(absolute, nextRelative);
      else if (stat.isFile()) result.push(nextRelative.replaceAll('\\', '/'));
      else fail(`unsupported package payload entry: ${nextRelative}`);
    }
  }
  await visit(directory, '');
  return result.sort();
}

function sorted(values) {
  return [...values].sort();
}

function sameArray(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function assertPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `path escapes package root: ${candidate}`);
}

async function verifyAsset(root, asset, checksums) {
  const packageRoot = path.join(root, asset.directory);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  assert(packageJson.name === asset.packageName, `package name mismatch: ${asset.directory}`);
  assert(packageJson.version === '0.1.0', `package version mismatch: ${asset.packageName}`);
  assert(packageJson.private === true, `package must be private: ${asset.packageName}`);
  assert(sameArray(packageJson.os, [asset.os]), `os filter mismatch: ${asset.packageName}`);
  assert(sameArray(packageJson.cpu, [asset.cpu]), `cpu filter mismatch: ${asset.packageName}`);
  assert(packageJson.dshappsPlatform?.binary === asset.binaryPath, `platform binary mapping mismatch: ${asset.packageName}`);
  assert(packageJson.dshappsPlatform?.provenance === 'provenance/cli-proxy-api.json', `platform provenance mapping mismatch: ${asset.packageName}`);
  assert(packageJson.dshappsPlatform?.managedConfig === 'config/managed.yaml', `platform config mapping mismatch: ${asset.packageName}`);
  assert(packageJson.dshappsPlatform?.upstreamAsset === asset.asset, `platform upstream asset mapping mismatch: ${asset.packageName}`);
  assert(Array.isArray(packageJson.files), `files allowlist missing: ${asset.packageName}`);
  assert(
    sameArray(packageJson.files, [asset.binaryPath, 'provenance/cli-proxy-api.json', 'config/managed.yaml', 'README.md', 'LICENSE']),
    `files allowlist mismatch: ${asset.packageName}`,
  );
  assert(!packageJson.dependencies && !packageJson.optionalDependencies && !packageJson.devDependencies, `dependencies are not allowed: ${asset.packageName}`);
  assert(!packageJson.scripts, `scripts are not allowed in data package: ${asset.packageName}`);
  for (const key of Object.keys(packageJson.scripts ?? {})) {
    assert(!ALLOWED_LIFECYCLE_SCRIPTS.has(key), `lifecycle script is not allowed: ${asset.packageName}#${key}`);
  }

  const expectedPayload = sorted(['package.json', ...packageJson.files]);
  const actualPayload = await listFiles(packageRoot);
  assert(sameArray(actualPayload, expectedPayload), `payload allowlist mismatch: ${asset.packageName}`);
  assert(actualPayload.every((file) => !file.endsWith('.js') && !file.endsWith('.mjs') && !file.endsWith('.ts')), `executable code entered data package: ${asset.packageName}`);

  const binaryPath = path.join(packageRoot, asset.binaryPath);
  assertPathWithin(packageRoot, binaryPath);
  const binaryStat = await fs.stat(binaryPath);
  assert(binaryStat.isFile() && binaryStat.size > 0, `binary is missing or empty: ${asset.packageName}`);
  const config = await fs.readFile(path.join(packageRoot, 'config/managed.yaml'), 'utf8');
  assert(/(^|\n)plugins:\s*\n\s+enabled:\s+false\s*(\n|$)/.test(config), `plugins.enabled must be false: ${asset.packageName}`);
  assert(!/enabled:\s*true/.test(config), `dynamic plugins are enabled: ${asset.packageName}`);
  const readme = await fs.readFile(path.join(packageRoot, 'README.md'), 'utf8');
  assert(readme.includes(asset.asset) && readme.includes('plugins.enabled') && readme.includes('no install lifecycle script'), `README policy statement missing: ${asset.packageName}`);

  const provenance = JSON.parse(await fs.readFile(path.join(packageRoot, 'provenance/cli-proxy-api.json'), 'utf8'));
  assert(provenance.schemaVersion === 1, `provenance schema mismatch: ${asset.packageName}`);
  assert(provenance.package?.name === asset.packageName && provenance.package?.version === '0.1.0', `provenance package identity mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.repository === 'router-for-me/CLIProxyAPI', `provenance repository mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.tag === 'v7.2.131', `provenance tag mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.releaseUrl === 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.131', `provenance release URL mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.asset === asset.asset, `provenance asset mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.assetUrl === `${provenance.upstream.releaseUrl}/${asset.asset}`, `provenance asset URL mismatch: ${asset.packageName}`);
  assert(provenance.upstream?.assetSha256 === asset.sha256, `provenance asset digest mismatch: ${asset.packageName}`);
  assert(provenance.target?.os === asset.os && provenance.target?.cpu === asset.cpu, `provenance target mismatch: ${asset.packageName}`);
  assert(provenance.executable?.path === asset.binaryPath, `provenance binary path mismatch: ${asset.packageName}`);
  assert(provenance.executable?.upstreamName === (asset.os === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'), `provenance upstream executable mismatch: ${asset.packageName}`);
  assert(provenance.executable?.sha256 === await hashFile(binaryPath), `provenance executable digest mismatch: ${asset.packageName}`);
  assert(provenance.managedConfiguration?.['plugins.enabled'] === false, `provenance plugin policy mismatch: ${asset.packageName}`);
  assert(typeof provenance.platformPolicy === 'string' && provenance.platformPolicy.length > 0, `provenance platform policy missing: ${asset.packageName}`);
  assert(sameArray(provenance.licenseFiles, ['LICENSE']), `provenance license list mismatch: ${asset.packageName}`);
  const licenseStat = await fs.stat(path.join(packageRoot, 'LICENSE'));
  assert(licenseStat.isFile() && licenseStat.size > 0, `upstream LICENSE missing: ${asset.packageName}`);

  const cacheArchive = path.join(root, 'packages/platform/.cache/downloads', asset.asset);
  assert((await hashFile(cacheArchive)) === asset.sha256, `cached archive digest mismatch: ${asset.asset}`);
  assert(checksums.get(asset.asset) === asset.sha256, `checksums.txt digest mismatch: ${asset.asset}`);
  assert(asset.os !== 'linux' || asset.asset.endsWith('_no-plugin.tar.gz'), `Linux asset is not no-plugin: ${asset.asset}`);
  assert(asset.os === 'linux' || !asset.asset.includes('_no-plugin'), `Windows/macOS asset must be standard: ${asset.asset}`);

  return {
    packageName: asset.packageName,
    asset: asset.asset,
    binaryBytes: binaryStat.size,
    binarySha256: provenance.executable.sha256,
  };
}

export async function verifyPlatformPackages(root = defaultRoot) {
  const manifestPath = path.join(root, 'provenance/cli-proxy-api/assets.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert(manifest.schemaVersion === 1, 'platform asset manifest schema mismatch');
  assert(manifest.upstream?.repository === 'router-for-me/CLIProxyAPI', 'platform repository mismatch');
  assert(manifest.upstream?.tag === 'v7.2.131', 'platform release tag is not frozen');
  assert(manifest.upstream?.releaseUrl === 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.131', 'platform release URL is not frozen');
  assert(manifest.assets.length === EXPECTED.length, 'platform asset count mismatch');
  for (const expected of EXPECTED) {
    const actual = manifest.assets.find((asset) => asset.packageName === expected.packageName);
    assert(actual, `missing platform asset manifest row: ${expected.packageName}`);
    for (const key of ['directory', 'os', 'cpu', 'asset', 'sha256', 'binaryPath']) {
      assert(actual[key] === expected[key], `frozen asset mapping mismatch for ${expected.packageName}: ${key}`);
    }
  }

  const checksumsPath = path.join(root, 'packages/platform/.cache/downloads/checksums.txt');
  const checksums = parseChecksums(await fs.readFile(checksumsPath, 'utf8'));
  const results = [];
  for (const asset of EXPECTED) results.push(await verifyAsset(root, asset, checksums));
  return { schemaVersion: 1, verified: results.length, assets: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyPlatformPackages(), null, 2));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
