import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(root, 'provenance', 'cli-proxy-api', 'assets.json');
const cachePath = path.join(root, 'packages', 'platform', '.cache');
const downloadPath = path.join(cachePath, 'downloads');
const extractPath = path.join(cachePath, 'extracted');
const offline = process.argv.includes('--offline');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

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

async function ensureDownload(name, url, expectedSha256) {
  const destination = path.join(downloadPath, name);
  await fs.mkdir(downloadPath, { recursive: true });

  let exists = false;
  try {
    await fs.access(destination);
    exists = true;
  } catch {
    // The cache is optional; fetch it below unless offline mode was requested.
  }

  if (!exists) {
    assert(!offline, `offline mode requires cached asset: ${name}`);
    const response = await fetch(url, { redirect: 'follow' });
    assert(response.ok, `download failed for ${url}: HTTP ${response.status}`);
    const temporary = `${destination}.part`;
    await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    await fs.rename(temporary, destination);
  }

  const actualSha256 = await hashFile(destination);
  assert(
    actualSha256 === expectedSha256,
    `SHA-256 mismatch for ${name}: expected ${expectedSha256}, got ${actualSha256}`,
  );
  return destination;
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) result.set(match[2].trim(), match[1].toLowerCase());
  }
  return result;
}

function archiveEntries(archivePath, format) {
  const args = format === 'zip' ? ['-tf', archivePath] : ['-tzf', archivePath];
  try {
    return execFileSync('tar', args, { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    fail(`cannot inspect ${archivePath}: ${detail}`);
  }
}

function assertSafeArchiveEntries(entries, archivePath) {
  for (const entry of entries) {
    const normalizedEntry = entry.replaceAll('\\', '/');
    const normalized = path.posix.normalize(normalizedEntry);
    assert(
      !normalizedEntry.startsWith('/') && !/^[a-z]:\//i.test(normalizedEntry),
      `unsafe absolute archive entry in ${archivePath}: ${entry}`,
    );
    assert(
      normalized !== '..' && !normalized.startsWith('../'),
      `unsafe parent archive entry in ${archivePath}: ${entry}`,
    );
  }
}

async function extractArchive(archivePath, format, destination) {
  const entries = archiveEntries(archivePath, format);
  assertSafeArchiveEntries(entries, archivePath);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  const args = format === 'zip'
    ? ['-xf', archivePath, '-C', destination]
    : ['-xzf', archivePath, '-C', destination];
  try {
    execFileSync('tar', args, { stdio: 'pipe', windowsHide: true });
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    fail(`cannot extract ${archivePath}: ${detail}`);
  }
  return destination;
}

async function regularFiles(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      assert(!stat.isSymbolicLink(), `symbolic link is not allowed in archive: ${entryPath}`);
      if (stat.isDirectory()) await visit(entryPath);
      else if (stat.isFile()) result.push(entryPath);
      else fail(`unsupported archive entry type: ${entryPath}`);
    }
  }
  await visit(directory);
  return result;
}

async function buildAsset(asset, checksums) {
  const assetUrl = `${manifest.upstream.releaseUrl}/${asset.asset}`;
  assert(
    assetUrl === `https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.131/${asset.asset}`,
    `asset URL is not a pinned v7.2.131 GitHub release URL: ${assetUrl}`,
  );
  assert(checksums.get(asset.asset) === asset.sha256, `checksums.txt does not match manifest for ${asset.asset}`);

  const archivePath = await ensureDownload(asset.asset, assetUrl, asset.sha256);
  const extracted = await extractArchive(
    archivePath,
    asset.format,
    path.join(extractPath, asset.directory.replaceAll('/', '_')),
  );
  const files = await regularFiles(extracted);
  const expectedUpstreamBinary = asset.os === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
  const binaries = files.filter((filePath) => path.basename(filePath).toLowerCase() === expectedUpstreamBinary);
  assert(binaries.length === 1, `expected exactly one ${expectedUpstreamBinary} in ${asset.asset}`);
  const licenseFiles = files.filter((filePath) => path.basename(filePath).toLowerCase() === 'license');
  assert(licenseFiles.length === 1, `expected exactly one upstream LICENSE in ${asset.asset}`);

  const packageDirectory = path.join(root, asset.directory);
  const packageManifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  assert(packageManifest.name === asset.packageName, `package name mismatch in ${asset.directory}`);
  assert(packageManifest.version === '0.1.0', `package version mismatch in ${asset.directory}`);
  assert(packageManifest.private === true, `platform package must remain private: ${asset.packageName}`);
  const config = await fs.readFile(path.join(packageDirectory, 'config', 'managed.yaml'), 'utf8');
  assert(/(^|\n)plugins:\s*\n\s+enabled:\s+false\s*(\n|$)/.test(config), `plugins.enabled must be false in ${asset.packageName}`);

  const vendorPath = path.join(packageDirectory, asset.binaryPath);
  await fs.mkdir(path.dirname(vendorPath), { recursive: true });
  const legacyBinaryName = asset.os === 'win32' ? 'CLIProxyAPI.exe' : 'CLIProxyAPI';
  const legacyBinaryPath = path.join(packageDirectory, 'vendor', legacyBinaryName);
  if (path.resolve(legacyBinaryPath) !== path.resolve(vendorPath)) {
    try {
      await fs.access(legacyBinaryPath);
      const stalePath = path.join(cachePath, 'stale', asset.directory.replaceAll('/', '_'), legacyBinaryName);
      await fs.mkdir(path.dirname(stalePath), { recursive: true });
      await fs.rename(legacyBinaryPath, stalePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await fs.copyFile(binaries[0], vendorPath);
  if (asset.os !== 'win32') await fs.chmod(vendorPath, 0o755);

  const licensePath = path.join(packageDirectory, 'LICENSE');
  await fs.copyFile(licenseFiles[0], licensePath);
  const executableSha256 = await hashFile(vendorPath);
  const provenance = {
    schemaVersion: 1,
    package: {
      name: asset.packageName,
      version: packageManifest.version,
    },
    upstream: {
      repository: manifest.upstream.repository,
      tag: manifest.upstream.tag,
      releaseUrl: manifest.upstream.releaseUrl,
      asset: asset.asset,
      assetUrl,
      sourceCommit: asset.sourceCommit ?? null,
      sourceCommitSuppliedByRelease: asset.sourceCommit !== undefined,
      assetSha256: asset.sha256,
    },
    target: {
      os: asset.os,
      cpu: asset.cpu,
    },
    executable: {
      path: asset.binaryPath,
      upstreamName: expectedUpstreamBinary,
      sha256: executableSha256,
    },
    managedConfiguration: {
      'plugins.enabled': false,
    },
    platformPolicy: asset.os === 'linux'
      ? 'Linux uses only the literal upstream no-plugin release asset.'
      : 'Windows and macOS use the literal standard upstream release asset with dynamic plugins disabled by configuration.',
    licenseFiles: ['LICENSE'],
  };
  const provenancePath = path.join(packageDirectory, 'provenance', 'cli-proxy-api.json');
  await fs.mkdir(path.dirname(provenancePath), { recursive: true });
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  return {
    packageName: asset.packageName,
    archive: asset.asset,
    archiveBytes: (await fs.stat(archivePath)).size,
    executableBytes: (await fs.stat(vendorPath)).size,
    executableSha256,
  };
}

const checksumsPath = path.join(downloadPath, 'checksums.txt');
await fs.mkdir(downloadPath, { recursive: true });
try {
  await fs.access(checksumsPath);
} catch {
  assert(!offline, 'offline mode requires cached asset: checksums.txt');
  const response = await fetch(manifest.upstream.checksumsUrl, { redirect: 'follow' });
  assert(response.ok, `download failed for ${manifest.upstream.checksumsUrl}: HTTP ${response.status}`);
  const temporary = `${checksumsPath}.part`;
  await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await fs.rename(temporary, checksumsPath);
}
const checksums = parseChecksums(await fs.readFile(checksumsPath, 'utf8'));
const results = [];
for (const asset of manifest.assets) results.push(await buildAsset(asset, checksums));
console.log(JSON.stringify({ schemaVersion: 1, assets: results }, null, 2));
