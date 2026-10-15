# docm

macOS arm64 Markdown-to-PDF application. Preview displays the generated PDF bytes, not a second HTML layout. Version 0.1.0; private unsigned distribution.

## Usage

```sh
docm notes.md
docm r notes.md
docm r notes.md -o report.pdf
docm r notes.md -o -
docm notes.md --config shared-report.toml
docm -- r
```

Preview owns a terminal-attached window until it closes; Ctrl-C quits with exit 130. Separate invocations own separate windows. Rendering writes beside the source by default, or to the invocation-relative `-o` path; `-o -` emits only PDF bytes. Existing output is replaced atomically after success. The destination parent must exist, and source/config/assets cannot be overwritten. CLI syntax errors exit 2; render/config/asset/write errors exit 1.

Preview offers continuous pages, selectable text and links, zoom, fit-width/fit-page, and Export PDF (also Cmd-S). It watches the source, automatic/explicit themes, and referenced images/fonts/logos. Failed edits retain the last good PDF with a stale diagnostic; repairs recover automatically. Export waits for the newest successful dependency snapshot and refuses stale output. Cancel does not write anything. Finder launch opens a Markdown picker and discovers the selected document's parent-directory theme.

## Configuration

Settings merge recursively: defaults → `~/Library/Application Support/docm/theme.toml` → invocation-directory `theme.toml` → `--config` → document TOML frontmatter. Every layer is strictly validated, including values subsequently overridden. Relative font/logo paths belong to the file declaring them. Automatic themes are optional; an explicit config is required.

```markdown
+++
[body]
font_size = "11pt"
[header]
center = "{{title}}"
[footer]
center = "{{page}} / {{pages}}"
+++
# Technical notes
```

A4 portrait, 20 mm margins, Source Sans 3 prose, Source Code Pro code, and New Computer Modern math are defaults. Raw HTML and arbitrary CSS are not supported. Theme discovery never searches document or parent directories unless they are the invocation directory. Frontmatter changes only declared keys; `enabled = false`, empty slot strings, and `logo = false` explicitly suppress inherited decorations.

Reusable user-global theme example; logo paths are relative to the theme file:

```toml
[header]
left = "Engineering"
center = "{{title}}"
right = "{{filename}}"
font_size = "9pt"

[header.logo]
path = "assets/logo.png"
position = "left"
width = "18mm"
height = "8mm"

[footer]
left = "Internal"
center = "{{page}} / {{pages}}"
```

Header and footer logos preserve their aspect ratio inside the configured `width` × `height` box. `position = "left"`, `"center"`, or `"right"` controls both the page slot and horizontal artwork alignment within that box; artwork stays vertically centered. Whitespace embedded in the image is preserved.

Frontmatter `[header] center = ""` clears only the center, retaining other slots/logo. User-global discovery is read-only; create the theme yourself if desired.

### Mermaid sizing and chart overrides

Set shared diagram settings in `theme.toml` (or document TOML frontmatter), then override individual diagrams by their one-based Mermaid-only order in the Markdown source, top to bottom. Other code fences do not count.

```toml
[mermaid]
width = "120mm"
theme = "neutral"
font_size = "11pt"

[mermaid.charts.1]
width = "80mm"

[mermaid.charts.2]
width = "150mm"
height = "70mm"
theme = "forest"
font = "mono"
font_size = "13pt"
padding = "2mm"
space_before = "12pt"
```

`width` and `height` are optional positive lengths in `px`, `pt`, `mm`, `cm`, or `in`. One dimension sets the requested size with uniform scaling; both dimensions fit the diagram inside that bounding box without stretching. Explicit sizes may enlarge or shrink a diagram, but the printable area (after padding, borders, and spacing) remains the upper limit. With neither dimension, diagrams retain their natural size and only shrink to fit the page. Dimensions describe the diagram SVG, excluding the wrapper's padding and border.

Each chart can override every supported Mermaid setting: `width`, `height`, `theme` (`default`, `neutral`, `dark`, `forest`), `font`, `font_size`, `font_weight`, `font_style`, `text_align`, `line_height`, `color`, `background`, `space_before`, `space_after`, `padding`, `border_color`, `border_width`, and `border_radius`. Chart entries merge across the normal configuration layers, then inherit the final global Mermaid settings; explicit chart fields take precedence. An omitted dimension still inherits its global value, so a chart-specific height plus an inherited width forms a bounding box.

Chart numbers must be positive integers without leading zeros. Entries for charts absent from a document are allowed, so shared themes can include sparse overrides. Charts cannot contain another `charts` table. Mermaid inline configuration directives/frontmatter remain disabled; use these TOML settings.

## Development

Use the versions pinned by `mise.toml` and pnpm. Project-local dependency and runtime downloads require approval. `mise exec -- pnpm install` installs JavaScript dependencies. `mise run` exposes build, typecheck, test, smoke, app assembly and source-formula tasks. No TeX installation or runtime download is required.

## Authoring

CommonMark, GFM tables/tasks/endnotes, Shiki-highlighted fenced code, `$...$` inline math, display math between separate `$$` lines, and fences labeled exactly `mermaid`. Unknown code languages render as plain escaped code. A standalone `:::pagebreak` line interrupts prose without a blank line; fenced, indented, inline-code and math literals remain literal. Leading/trailing/repeated breaks do not create empty pages.

Images must be local PNG, JPEG, WebP, GIF or self-contained sanitized SVG. Relative paths belong to the Markdown file; percent escapes and spaces work. External HTTP/HTTPS/mailto links remain links but their targets are not fetched while rendering. Heading IDs are unique; optional `[document] toc = true` and `number_headings = true` add a linked contents block and heading numbering without changing heading levels.

## Offline math and printing

MathJax 4.1.3 converts math to vector SVG in the main process using locally bundled New Computer Modern glyph data. All font ranges are bundled; there is no CDN, network loader, host-font fallback, native TeX engine, TeX distribution, or executable-math subprocess.

Supported packages are `base`, `ams`, `mathtools`, `newcommand`, `textmacros`, `boldsymbol`, and `color`. `[math]` retains `font_size`, `color`, display spacing and `[math.macros.NAME]` declarations with `args` (0–9) and a TeX `body`. Configured macros cannot replace built-in commands; expression-local definitions do not leak into other equations. The math font is fixed to New Computer Modern.

This is MathJax's mathematical TeX syntax, not a full LaTeX document processor. Arbitrary packages, preambles, document classes, file input, shell execution, `\require`, and HTML/link extensions are unsupported. Unknown commands, malformed input, unsupported glyphs and excessive macro expansion produce source-position diagnostics rather than placeholder output. Input is limited to 64 KiB per expression, with bounded expansion and a bounded SVG cache; canceled revisions do not publish output.

Chromium CSS `@page` owns physical size, margins and repeated decorations. Unknown decoration tokens error; supported tokens are `{{filename}}`, `{{title}}`, `{{page}}`, `{{pages}}`; quadruple braces escape literal double braces. Decoration text wraps. Overflow is rejected with a required margin adjustment rather than clipped or automatically resized. Outline generation uses tagged printing; PDF/UA compliance is not promised. Prose/code are selectable; vector math is not promised to be copyable/searchable.

PDF.js is pinned to 5.4.394: it retains `isEvalSupported:false` and supports replacement without the shared-page-map reset in 5.4.624. The preview renders only application-generated PDFs, not arbitrary imported PDFs.

The smoke task launches the actual Electron window and exercises PDF output, watches, reading controls, export IPC, and 200-page updates. Export checks control only the native dialog's response; macOS Save-panel automation is deliberately not attempted and requires no Automation/Accessibility permission. Screenshots and machine-readable evidence are written under `.build/smoke`.

## Source-building Homebrew distribution

Native arm64, macOS 13 (Ventura) or newer. Homebrew builds docm from its TypeScript sources in a fresh staged directory, then installs the resulting `Docm.app` under the formula's Cellar `libexec` and links its terminal-attached launcher as `docm`. It does not download or install a prebuilt docm app, use the checkout's `out`/`dist`, or copy an app into `/Applications`.

Electron/Chromium remains a prebuilt upstream runtime dependency; npm dependencies and New Computer Modern glyph data are locked build inputs, not rebuilt from their upstream source repositories. The source-building claim applies to docm. The installed app bundles its runtime, fonts/viewer assets and third-party licenses, needs no developer Node/pnpm on PATH, and renders offline.

```sh
mise run formula:prepare
mise run formula:install
mise run formula:smoke
```

The existing Homebrew `mise` and exact Node/pnpm versions from `mise.toml` must already be available. These tasks refuse to install missing developer tooling, upgrade dependencies, use sudo, request OS permissions, or disable security protections. Preparation creates checksummed source, frozen pnpm-store and existing Electron-runtime archives under `.build/formula-inputs`. The source archive excludes compiled outputs, dependency directories and generated caches. The formula stages its inputs and runs `mise run formula:build` to install project dependencies with offline/frozen pnpm, typecheck, compile and assemble the app. No network loader or old-app fallback is used during the build.

Toolchain preflight and staged formula builds use an empty global mise config and stop parent-config discovery at the checkout/build directory's parent. They reuse the existing mise tool installations without loading ancestor or user-global configs, or changing your normal config trust records.

Generated formula: `.build/homebrew-tap/Formula/docm.rb`; dedicated tap: `docm/local`; install command after preparation: `brew install --formula --build-from-source docm/local/docm`. Inputs use absolute local `file://` URLs and actual SHA-256 digests, so this private distribution is specific to the checkout. Public distribution requires hosting those source/resource archives and updating their URLs; an official Homebrew listing is not implied.

The first install migrates only the previously recorded owned cask after checking its content, directory identities, tap and launcher. Unrelated products or modified owned installations are never overwritten. Homebrew auto-update is disabled for these project tasks. Ordinary prepare/install are idempotent for unchanged inputs; use `mise run formula:refresh` after source changes to explicitly rebuild the owned formula. Interrupted migrations or replacements retain a failure stage and refuse automatic adoption.

`formula:smoke` checks the source-build receipt (not poured from a bottle), input checksums, installed provenance, native arm64 code, deep ad-hoc signature and launcher link, then exercises the actual Homebrew-installed CLI and desktop preview with developer tools absent from the runtime PATH. It covers PDF outputs, vector math, themes/assets, watches, latest-revision export, Ctrl-C, and 200-page rendering. Evidence is under `.build/formula-smoke` and `.build/formula-verification.json`.

No Apple Developer ID certificate or notarization is used; local ad-hoc signing preserves the Apple Silicon execution signature. Gatekeeper, quarantine and the Electron/Homebrew sandboxes are not bypassed. The former prebuilt quarantined cask was denied by Gatekeeper; it is never launched during migration. The source-built app must pass actual launch verification without removing quarantine attributes.

The installed CLI/preview is verified with `formula:smoke`, not by treating Homebrew's developer test sandbox as a desktop session. On this host, `brew test docm/local/docm` aborts in AppKit's `NSApplication` registration before application JavaScript runs; the same installed app passes the real desktop/CLI smoke. Do not disable Homebrew's sandbox to force that test through. `brew test` can also bootstrap Homebrew's own Ruby developer-test dependencies; the project formula tasks do not invoke it.

For standalone local assembly, `mise run package` produces `dist/mac-arm64/Docm.app`, not a distribution ZIP. `package:smoke` exercises that bundle separately. `notices:prepare` preserves dependency/font licenses, New Computer Modern attribution and DOMPurify corresponding source. Native Save-panel interaction remains unautomated: export smoke controls only the dialog response while exercising the real IPC/session/atomic writer.
