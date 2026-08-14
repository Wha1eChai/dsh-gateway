import path from 'node:path'

export const version = '0.1.0'
export const releaseTag = `v${version}`
export const releaseBaseUrl = `https://github.com/Wha1eChai/dsh-gateway/releases/download/${releaseTag}`

export const webpage = Object.freeze({
  name: '@wha1echai/dsh-webpage',
  version: '0.1.0',
  filename: 'wha1echai-dsh-webpage-0.1.0.tgz',
  url: 'https://github.com/Wha1eChai/dsh-webpage/releases/download/v0.1.0/wha1echai-dsh-webpage-0.1.0.tgz',
  sha256: 'd7ebdd1ce65b456492eafc59b2775594dc117d263e5a1b1c0cbbe503cdcda421',
})

export const packageSpecs = Object.freeze([
  { key: 'gateway', directory: 'packages/gateway', name: '@wha1echai/dsh-gateway' },
  { key: 'runtime', directory: 'packages/runtime', name: '@wha1echai/dsh-gateway-runtime' },
  { key: 'analytics', directory: 'packages/analytics', name: '@wha1echai/dsh-gateway-analytics' },
  { key: 'pack', directory: 'packages/pack', name: '@wha1echai/dsh-gateway-pack' },
  { key: 'platform-win32-x64', directory: 'packages/platform/win32-x64', name: '@wha1echai/dsh-gateway-platform-win32-x64' },
  { key: 'platform-win32-arm64', directory: 'packages/platform/win32-arm64', name: '@wha1echai/dsh-gateway-platform-win32-arm64' },
  { key: 'platform-darwin-x64', directory: 'packages/platform/darwin-x64', name: '@wha1echai/dsh-gateway-platform-darwin-x64' },
  { key: 'platform-darwin-arm64', directory: 'packages/platform/darwin-arm64', name: '@wha1echai/dsh-gateway-platform-darwin-arm64' },
  { key: 'platform-linux-x64', directory: 'packages/platform/linux-x64', name: '@wha1echai/dsh-gateway-platform-linux-x64' },
  { key: 'platform-linux-arm64', directory: 'packages/platform/linux-arm64', name: '@wha1echai/dsh-gateway-platform-linux-arm64' },
])

export function packageFilename(name) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}

export function packageUrl(name) {
  return `${releaseBaseUrl}/${packageFilename(name)}`
}

export function portableFileSpecifier(filePath) {
  return `file:${path.resolve(filePath).replaceAll('\\', '/')}`
}
