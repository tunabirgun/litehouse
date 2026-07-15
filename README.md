# Litehouse

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/png/litehouse-wordmark-dark.png">
    <img src="assets/brand/png/litehouse-wordmark-light.png" width="600" alt="Litehouse">
  </picture>
</p>

Litehouse is a local-first research application for recurring literature discovery,
careful reading, and evidence-locked reporting. It is designed for the humanities,
arts, social sciences, natural and life sciences, engineering, medicine, law, and
interdisciplinary work.

> **Alpha:** `0.1.0-alpha.1` is an early public build. Verify important findings in
> the original works. Litehouse supports literature review; it does not certify that
> a study or generated conclusion is scientifically true.

## What Litehouse does

- Creates one-time reviews or scheduled watches through a guided research brief.
- Searches OpenAlex, Crossref, Europe PMC, Semantic Scholar, DataCite, and the
  Library of Congress through fixed official endpoints.
- Reconciles identifiers and metadata across sources while keeping disagreements
  visible instead of silently choosing one value.
- Ranks discovery results with inspectable relevance, recency, age-and-kind cohort,
  methodological, access, and corroboration signals. Ranking is never presented as
  a truth or quality score.
- Uses an install-on-demand local open-source Qwen3 model by default, with
  hardware-aware minimum, balanced, and quality suggestions. Users can select another
  llama.cpp-compatible local model or explicitly configure OpenAI-, Anthropic-, or
  Gemini-compatible APIs.
- Opens local and legally acquired PDFs in a full reader with search, outline,
  thumbnails, zoom, selectable text, reading progress, highlights, and anchored notes.
- Stores articles, reports, notes, and exports in a changeable local vault with
  SHA-256 verification.
- Produces plain text, Markdown, or an A4 monochrome LaTeX/PDF report. PDF reports
  use the Litehouse identity, proper references, and automated layout checks for
  stranded headings, clipped content, and unstable tables.
- Exports CSL JSON, RIS, BibTeX, BibLaTeX, and EndNote XML for Zotero, EndNote,
  Mendeley, and other reference managers.
- Supports light, dark, and system themes; reduced or disabled motion; English and
  Turkish interfaces; touch alternatives; and Command shortcuts on macOS or Control
  shortcuts on Windows and Linux.

## Evidence and safety defaults

Litehouse keeps every generated claim linked to a known evidence segment and refuses
unknown evidence identifiers. Numeric values and source hashes are checked again after
model generation. Open-access full text is the default; paywalled metadata or abstracts
are included only when the user opts in, and Litehouse does not bypass access controls.

Web requests use fixed HTTPS providers, pre-connect DNS checks, peer-address matching,
response limits, strict content types, no uncontrolled redirects, and SHA-256 receipts.
Model downloads are pinned to an exact repository revision, byte size, Apache-2.0
license, and SHA-256 digest. The PDF reader itself performs no network requests.

The local API binds to loopback with a per-launch session token. Research content and
telemetry are not sent to a paid model provider unless the user selects and configures
that provider.

## Install

Alpha installers, updater signatures, and SHA-256 records are published on the
[GitHub Releases page](https://github.com/tunabirgun/litehouse/releases). Litehouse
targets Apple Silicon and Intel macOS, x64 Windows, and x64/ARM64 Linux. Windows ARM64
is treated as preview support while its runner and WebView toolchain mature.

The in-app updater checks GitHub Releases for a newer signed artifact, shows its version
and release notes, and asks before installing or restarting. An update is rejected if
its mandatory updater signature cannot be verified. Platform code-signing and macOS
notarization status are stated in each release; an unsigned alpha may still trigger an
operating-system trust warning even when its updater signature and published SHA-256
record are valid.

## Run from source

The source build uses Python `3.13.13`, Rust `1.96.1`, Node.js `>=22.12.0`, and exact
dependency lockfiles.

```sh
UV_PYTHON_INSTALL_DIR="$PWD/.python" uv python install 3.13.13
UV_PYTHON_INSTALL_DIR="$PWD/.python" uv sync --python 3.13.13 --frozen --all-groups
npm ci --ignore-scripts
```

Run the local API and web interface in separate terminals:

```sh
uv run litehouse serve
npm run dev
```

Build the native application for the current platform:

```sh
npm run desktop:build
```

Run the source-build gates included in the public tree:

```sh
uv run ruff check src migrations scripts
uv run mypy src/litehouse scripts
npm run typecheck
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

## License

Litehouse is released under the [Apache License 2.0](LICENSE). Bundled fonts and model
artifacts retain their own included license and provenance records.
