# Local Nexus verification

Run the relative commands below from `Frontend/library` in
`PixelStreamingInfrastructure`.

This lab is separate from the company's npm configuration. Start it with
`docker compose -f tools/nexus-lab/compose.yaml up -d` and run
`pwsh -File tools/nexus-lab/bootstrap.ps1`. The bootstrap uses only the generated
initial password of this local container and never accepts the Nexus EULA.
The operator must review and accept that agreement before publication.

Publish the output of `npm run package:release` to the local `psf-releases`
hosted repository using an external, test-only authenticated npm userconfig.
Consume it through `http://127.0.0.1:48081/repository/npm-all/`. Never commit
credentials or change a user's/company's registry to run this lab.

`loopback-forward.cjs` is for clients on the compose internal network. It maps
their loopback port 48081 only to `nexus:8081`. Windows and Linux clients then
use the same registry authority; cached Nexus metadata cannot mix loopback
and Docker service-name tarball URLs. Nexus alone has external proxy access.

The original PixelStreamingFrontendLib 2026-10-27 verification used Node 24.22.1 with glibc 2.28 in isolated Linux
clients and Node 22 on Windows. Empty-cache installs and production builds
passed for React and the stock TypeScript frontend. All 936 logged client
fetches went to Nexus; direct GitHub/public npm access was blocked. A changed
lockfile integrity was rejected with EINTEGRITY, and duplicate publication was
rejected by the hosted repository. The library passed 53 tests and React passed
8 tests on each platform. Normalized Windows/Linux package bytes matched.

These results cover the local registry and unchanged IME runtime. Company SSO,
TLS, repository routing and publication remain subject to the existing company
process. Stop with `docker compose -f tools/nexus-lab/compose.yaml stop`; this
retains the container, image and volume. Removal requires a separate request.
