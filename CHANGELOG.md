# Changelog

## 0.1.1 — 2026-10-15

- Restore Forge Cloud connectivity after its move to `app.useforge.design`. The CLI also reads a saved `https://useforge.design` as the app host, keeps the existing token, and preserves custom Cloud addresses.
- Publish through Cloud's staged-upload protocol: declare file sizes and hashes, upload bytes directly, then commit after every upload succeeds. Retry temporary upload failures; retain single-request publishing for servers that do not advertise staged uploads.
- Include the frozen tag's message when publishing and point PIN guidance to the Cloud app's Prototypes page.
- Keep reported CLI and generated-report versions aligned with the package version.

All three packages (`cli`, `format`, and `scenarios`) use 0.1.1. Existing library import paths and intake behavior remain compatible with 0.1.0. The Design Record format version remains 0.2.

## 0.1.0 — 2026-10-02

First npm release of the CLI, Design Record format, scenario runtime, and bundled agent skills.
