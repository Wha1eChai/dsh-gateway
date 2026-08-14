# dsh-gateway platform: win32 x64

This private, data-only package carries the pinned CLIProxyAPI `v7.2.131`
Windows x64 executable under `vendor/cli-proxy-api.exe`.

The package uses the literal upstream standard asset
`CLIProxyAPI_7.2.131_windows_amd64.zip`. Dynamic plugins are disabled by the
managed configuration fragment at `config/managed.yaml` (`plugins.enabled:
false`). The upstream asset digest, target platform, executable digest, and
license attribution are recorded in `provenance/cli-proxy-api.json`.

This package has no install lifecycle script and performs no network or
runtime download. It is selected only on `win32`/`x64` hosts.
