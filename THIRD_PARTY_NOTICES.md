# Third-Party Notices

EZNess is an Electron application distributed for Windows x64. It includes the
third-party components listed below. Each component remains under its own
license; the MIT license of EZNess itself does not replace those terms.

This file is part of the distribution. If you redistribute EZNess or a modified
build, keep this file, the `LICENSE` file and the license files of the bundled
packages.

## Bundled components

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| Electron | 45.1.0 | MIT | Bundles Chromium, Node.js, V8, ffmpeg and other components under their own licenses. See `LICENSE.electron.txt` and `LICENSES.chromium.html` in the application directory. |
| React | 19.3.1 | MIT | |
| React DOM | 19.3.1 | MIT | |
| Material Icon Theme (vendored SVG icons) | — | MIT | Copyright (c) 2025 Material Extensions. See `src/assets/material-icons/LICENSE`. |
| react-markdown | 10.1.0 | MIT | |
| remark-gfm | 4.0.1 | MIT | |
| highlight.js | 11.12.0 | BSD-3-Clause | |
| JSZip | 3.10.2 | MIT | Dual-licensed `MIT OR GPL-3.0-or-later`; this project uses the MIT option. |
| Mammoth | 1.13.0 | BSD-2-Clause | |
| ExcelJS | 4.4.0 | MIT | |
| PDF.js (`pdfjs-dist`) | 6.4.299 | Apache-2.0 | Includes CMaps, ICC profiles, standard fonts and WASM decoders under their own licenses; see `node_modules/pdfjs-dist/**/LICENSE*`. |
| `@napi-rs/canvas` | 1.1.0 | MIT | The Windows x64 binary package `@napi-rs/canvas-win32-x64-msvc` is also MIT. |
| ONNX Runtime (`onnxruntime-node`) | 1.31.1 | MIT | |
| `paddleocr` | 1.2.0 | MIT | JavaScript wrapper; model weights are covered separately below. |
| `pdfmarkdown-ppocrv5-models` | 1.0.0 | Apache-2.0 | PP-OCRv5 mobile detection and recognition weights plus the character dictionary. See the `LICENSE` inside the package. |
| `sharp` | 0.34.4 | Apache-2.0 | JavaScript wrapper. |
| `@img/sharp-win32-x64` | 0.34.4 | Apache-2.0 AND LGPL-3.0-or-later | Prebuilt sharp/libvips for Windows x64. See the LGPL note below. |
| `sherpa-onnx-node` | 2.0.1 | Apache-2.0 | |
| `sherpa-onnx-win-x64` | 2.0.1 | Apache-2.0 | Windows x64 native runtime used by the voice path. |

The installed application also contains the transitive npm dependencies of
these packages. Their license files, where supplied, are kept under
`resources/app/node_modules/<package>/`. The exact dependency tree and upstream
repositories are recorded in `package-lock.json`.

## Model files

### Bundled OCR models

The PP-OCRv5 mobile detection and recognition models are from
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), licensed under
Apache-2.0. They are redistributed as ONNX/ORT data files through the
`pdfmarkdown-ppocrv5-models` package. The package ships its own Apache-2.0
`LICENSE` file.

### Models downloaded at runtime

Voice models are **not** bundled with the application. On first use, the app
downloads Silero VAD and SenseVoiceSmall into the user's data directory. They
remain subject to their upstream licenses and terms:

- Silero VAD: <https://github.com/snakers4/silero-vad>
- SenseVoice: <https://github.com/FunAudioLLM/SenseVoice>
- sherpa-onnx model conversion and runtime: <https://github.com/k2-fsa/sherpa-onnx>

## LGPL components

`@img/sharp-win32-x64` includes prebuilt libvips shared libraries under
LGPL-3.0-or-later. EZNess does not modify these libraries. The application is
packaged with `asar: false`, so the DLLs under
`resources/app/node_modules/@img/sharp-win32-x64/lib/` are ordinary files and
can be replaced with an interface-compatible build.

Upstream source:

- sharp: <https://github.com/lovell/sharp>
- libvips: <https://github.com/libvips/libvips>

The canonical LGPL-3.0 and GPL-3.0 texts are available at:

- <https://www.gnu.org/licenses/lgpl-3.0.txt>
- <https://www.gnu.org/licenses/gpl-3.0.txt>

Electron's `LICENSES.chromium.html` also contains copies of the license texts
used by Chromium and its third-party components.

## Full license texts

- EZNess itself: `LICENSE` in the repository root.
- Electron and Chromium: `LICENSE.electron.txt` and `LICENSES.chromium.html`
  in the application directory.
- npm packages: `resources/app/node_modules/<package>/LICENSE*`.
- Material Icon Theme: `src/assets/material-icons/LICENSE`.
- OCR model package: `resources/app/node_modules/pdfmarkdown-ppocrv5-models/LICENSE`.
- Apache-2.0: <https://www.apache.org/licenses/LICENSE-2.0>.
- LGPL-3.0 and GPL-3.0: links above.

## Trademarks

Electron, Chromium, PaddleOCR, SenseVoice, ONNX Runtime, sharp, libvips,
React and the other names above are trademarks or registered trademarks of
their respective owners. Their use here is for attribution only.
