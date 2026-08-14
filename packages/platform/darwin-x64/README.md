# dsh-gateway platform: darwin x64

This private, data-only package carries the pinned CLIProxyAPI `v7.2.131`
macOS x64 executable under `vendor/cli-proxy-api`.

The package uses the literal upstream standard asset
`CLIProxyAPI_7.2.131_darwin_amd64.tar.gz`. Dynamic plugins are disabled by the
managed configuration fragment at `config/managed.yaml` (`plugins.enabled:
false`). The upstream asset digest, target platform, executable digest, and
license attribution are recorded in `provenance/cli-proxy-api.json`.

This package has no install lifecycle script and performs no network or
runtime download. It is selected only on `darwin`/`x64` hosts.
