# Original source

In the original `YonghoKwon/PixelStreamingFrontendLib` repository, commit
`2766b4b` and tag `upstream/ue5.3-1.0.9` preserve the unmodified npm package
`@epicgames-ps/lib-pixelstreamingfrontend-ue5.3@1.0.9` before any fork changes.

- Upstream gitHead: `feccfb1221ef67774326be2fdce053ed592db72b`
- npm SHA1: `1e30b904f3f3b9d757fef21b22796217f40e1dfd`
- npm integrity: `sha512-L/UcYWyHLygcj+hkGWv+4AaNf5hqeS54oV+DXnFydBLyrXRKqguUx0hworeq+O/dwLeyPpOMXZh7fgpujF0KkA==`

The internal npm release is `1.0.10`, based on official 1.0.9. This stable patch
version satisfies the UE5.3 UI library's existing peer range `^1.0.8`.
Built artifacts are distributed through the company's existing Nexus/npm
configuration. No direct GitHub source/tarball dependency is required.
The earlier `1.0.9+kwon.ime.1` Git snapshot remains preserved in history.

In addition to IME support, the fork includes same-streamer peer preservation
and missing-codec guards needed by the stock frontend with Cirrus v3.
The original npm snapshot currently fails source compilation with the latest
Node type declarations. The fork pins the Node 18 type package used for its
build and changes the interval declaration from `NodeJS.Timer` to
`ReturnType<typeof setInterval>` without changing its runtime behavior.

On 2026-11-02, the library was imported from
`YonghoKwon/PixelStreamingFrontendLib@535db96` into
`YonghoKwon/PixelStreamingInfrastructure` at `Frontend/library`. This directory
is now the library source location. The local F7b branch was not imported.
The stock TypeScript frontend still consumes the existing 1.0.10 tgz in
`Frontend/vendor`; its dependency and update procedure are unchanged.
