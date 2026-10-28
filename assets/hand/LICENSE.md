# Hand model: source and licence

OpenGrip copy (2026-10-21): taken from the owner's hologram-workshop repo (`assets/hand/`), where the
notes below were written. Here each .glb is stored as base64 in `left-glb.js` / `right-glb.js`
(bytes unchanged; the hashes below are of the decoded bytes) and posed by `src/ui/hand3d.js`.

`left.glb` and `right.glb` are the **generic-hand** profile assets from the W3C Immersive Web
group's WebXR Input Profiles, unmodified.

- Package: `@webxr-input-profiles/assets` **1.0.20** (npm), files
  `dist/profiles/generic-hand/left.glb` and `right.glb`
- Downloaded 2026-10-01 from
  `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0.20/dist/profiles/generic-hand/`
- Upstream repo: https://github.com/immersive-web/webxr-input-profiles (packages/assets)
- The package README says: "Assets are available under MIT license in .glTF, or .glb formats."
  The package's own `LICENSE.md` is reproduced below.
- SHA-256: left.glb `bc67783144944ea1cda54d9247885825ea5fb9d4651469fe7d00be517a5c2b87`,
  right.glb `291790c14f7f88a7f9bd35330c47392ed8e8d395ae6728f4bb7089f1bc1f2b96`

Each file is one skinned mesh with 25 bones named after the WebXR hand joints (`wrist`,
`thumb-metacarpal` ... `pinky-finger-tip`), all direct children of `Armature`. `handModel.js`
poses those bones from MediaPipe landmarks; the material is replaced at load time.

---

MIT License

Copyright (c) 2019 Amazon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
