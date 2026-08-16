import assert from 'node:assert/strict';
import { verifyPlatformPackages } from '../../scripts/platform/verify-platform-packages.mjs';

const report = await verifyPlatformPackages();

assert.equal(report.schemaVersion, 1);
assert.equal(report.verified, 6);
assert.deepEqual(
  report.assets.map(({ packageName }) => packageName),
  [
    '@dshapps/dsh-gateway-platform-win32-x64',
    '@dshapps/dsh-gateway-platform-win32-arm64',
    '@dshapps/dsh-gateway-platform-darwin-x64',
    '@dshapps/dsh-gateway-platform-darwin-arm64',
    '@dshapps/dsh-gateway-platform-linux-x64',
    '@dshapps/dsh-gateway-platform-linux-arm64',
  ],
);

console.log(`platform supply-chain verification passed: ${report.verified} packages`);
