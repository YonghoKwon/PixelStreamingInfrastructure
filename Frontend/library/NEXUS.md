# Nexus npm artifact distribution

This internal release is `@epicgames-ps/lib-pixelstreamingfrontend-ue5.3@1.0.10`,
based on official 1.0.9 with the Korean IME fixes. It is not a public npm release.
Existing company npm/Nexus configuration is used as-is. Do not replace registry
addresses or put credentials in these repositories.

## Build the distributable

Run from `Frontend/library` in `PixelStreamingInfrastructure`.

```sh
npm ci
npm test -- --runInBand --coverage=false
npm run package:release
```

The supported release is `artifacts/epicgames-ps-lib-pixelstreamingfrontend-ue5.3-1.0.10.tgz`.
`artifacts/release-manifest.json` records its file list, SHA-256 and npm integrity.
The package contains built UMD/ESM JavaScript, declarations, license and docs.
It does not contain src, tests, node_modules, build hooks or registry credentials.
The source repository remains private-marked to prevent publishing the source
snapshot; the generated release manifest is publishable.

Upload/publish the generated tgz using the company's existing Nexus process.
For npm publishing, the destination must support npm deployment (normally a
hosted repository). A group is generally used for consumption. Follow the
existing company publication configuration rather than editing consumer URLs.
Do not overwrite an already released version. Allocate another patch version
and update both consumers if 1.0.10 is already used in the company registry.

## Consumption

The stock Infrastructure frontend continues to use
`file:../../vendor/epicgames-ps-lib-pixelstreamingfrontend-ue5.3-1.0.10.tgz`
from `Frontend/implementations/typescript`. Its installation and release-update
procedure are documented in `../vendor/README.md` and are unchanged here.
React is maintained separately; its consumption is outside this import.
Library lockfiles keep exact versions and integrity but omit registry tarball
URLs. Use `npm run lock:portable` when updating them. No .npmrc registry override
is committed. The UI package's existing ^1.0.8 peer range accepts this release.

## Local Nexus lab

```sh
docker compose -f tools/nexus-lab/compose.yaml up -d
```

The lab uses pinned Sonatype Nexus, persistent storage, loopback port 48081 and
an internal client network. It is independent of the company registry.
On first startup Nexus CE blocks artifact publication until its operator has
reviewed and accepted its EULA. The bootstrap script never accepts it for you.
Create npm hosted/proxy/group repositories; publish the tgz to hosted and
install through the group using test-only command-line registry overrides.
Keep the hosted member before the public proxy. The verification clients use
the internal network, an empty npm cache, and cannot connect directly to GitHub
or public npm. Only Nexus has proxy egress. Company SSO, TLS and permissions are
not certified by this lab. Stop the lab after testing and retain its data;
removal is a separate operation.
