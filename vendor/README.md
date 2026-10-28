# vendor/: third-party code kept in the repo

OpenGrip makes no network requests, so nothing here is loaded from a CDN. Files are byte-for-byte
upstream; hashes are recorded here (not in the files) so anyone can re-check them with
`shasum -a 256 <file>`.

## three.js 0.161.0 (r161), `vendor/three/`

| | |
| --- | --- |
| Source | official npm tarball https://registry.npmjs.org/three/-/three-0.161.0.tgz (sha1 `38aafaa82fe5467fde2e33933515d1b6beb17d91`, equal to the registry's `dist` record), fetched 2026-10-21 |
| Licence | MIT, `vendor/three/LICENSE` (the package's own copy) |
| `build/three.module.min.js` | sha256 `8da856fd9ddfe38fdb286da04bc1d85f3bf108bf083e0eac71cd276ec6674030` (the same hash the owner's music-trainer repo recorded for this file) |
| `examples/jsm/loaders/GLTFLoader.js` | sha256 `d073b438e6a07e1359741dd5d6c76c953420cc0d4fd84eb1bdde94315540e6a3` |
| `examples/jsm/utils/BufferGeometryUtils.js` | sha256 `b0c64fe6f3b9907262921b73fafc4ade874c07ba6b4876e164c87a830c2c2113` (GLTFLoader imports it) |
| `examples/jsm/utils/SkeletonUtils.js` | sha256 `83748c5072a5ce96e9d68d8efda908a1f1a06c0b5fd2618edc3e54a361a8fd5b` (clones the skinned hand for the "truth" ghost) |
| Used by | `src/ui/hand3d.js` only, through a dynamic `import('three')`, so pages that never show the hand never load it |

The minified build is vendored instead of `three.module.js` (same code, 675 KB instead of 1.28 MB).
GLTFLoader imports the bare name `three`, so a page that mounts the hand needs this import map
before its first module script (paths relative to the page):

    <script type="importmap">{ "imports": { "three": "./vendor/three/build/three.module.min.js",
      "three/addons/": "./vendor/three/examples/jsm/" } }</script>

GLTFLoader is only used through `parse()` on bytes already in memory (see `assets/hand/`), so it
never fetches anything.

## Hand model, `assets/hand/`

WebXR Input Profiles `generic-hand` left/right .glb (MIT, Amazon 2019), copied from the owner's
hologram-workshop repo. Source, licence text and hashes: `assets/hand/LICENSE.md`.
