# Bundled UE 5.3 Korean IME SDK

`epicgames-ps-lib-pixelstreamingfrontend-ue5.3-1.0.10.tgz` is the built npm package
for `@epicgames-ps/lib-pixelstreamingfrontend-ue5.3@1.0.10`. The stock frontend
uses `file:../../vendor/epicgames-ps-lib-pixelstreamingfrontend-ue5.3-1.0.10.tgz`
from `Frontend/implementations/typescript`. Commit/copy the complete Frontend
directory so this relative path stays valid. The SDK is not fetched from Nexus,
GitHub or a public registry during installation. React is a separate repository
and is not changed by this vendoring step.

## Build in a new environment

With a compatible Node/npm installation, run from the repository root:

```sh
cd Frontend/implementations/typescript
npm ci
npm run build
npm ls @epicgames-ps/lib-pixelstreamingfrontend-ue5.3
```

The SDK should report version `1.0.10`. Build output goes to
`SignallingWebServer/Public`; deploy that generated directory using the existing
web-server procedure. Deploying it does not require the tgz or node_modules.
Webpack, TypeScript, the UI package and other dependencies still use the
existing npm registry configuration. A fully offline fresh installation also
needs a pre-populated npm cache for all those dependencies, using the same
registry configuration that populated that cache; then use
`npm ci --offline` and `npm --offline run build`. The SDK tgz alone is not a
complete offline build kit. No registry URL or credentials are committed here.

## Provenance and integrity

- Built from YonghoKwon/PixelStreamingFrontendLib at commit
  `ef262b045a8e6c10ba18769a34171d87bcd0df14`, based on official UE5.3 1.0.9.
- Size: 95,358 bytes. SHA-256:
  `d47f574f222372d833915efa98515b77fc240d0e31fce9ab8b928b103c391390`.
- The archive is unchanged from the tested Nexus release; its runtime preserves
  the accepted Korean IME, same-streamer and missing-codec fixes.
- Includes UMD/ESM JavaScript, declarations, MIT license and upstream notices.
  No source, development dependencies or installation/build hooks are included.
- `SHA256SUMS` records the archive digest; the consumer lockfile also pins its
  npm SHA-512 integrity. Internal archive docs describe its original Nexus
  distribution; this wrapper documents the repository-local distribution.

To update, build a new version with the library repository's
`npm run package:release`, review its license/content and copy its tgz here.
Update the file dependency, refresh the lock with `npm run lock:portable`,
update this digest/provenance, and verify a clean install/build. Do not silently
replace an archive under the same version/filename. `build-all` and
`build-dev-all` now alias the normal production/development frontend builds.
They use installed dependencies instead of linking/rebuilding the in-tree
upstream library, which does not contain this IME patch.
