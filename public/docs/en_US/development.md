# Development and Documentation Maintenance

BAAS Tauri uses React, Vite, Tailwind CSS, Zustand, i18next, and Tauri 2. The client synchronizes status, config, logs, and trigger commands with the backend through WebSocket channels.

## Documentation maintenance

- In-app docs maintain Chinese and English only.
- Other languages fall back to English.
- The web documentation site lives in `baas-tauri/docs`, using Fumadocs and Next.js static export.
- Installation, usage, development, script, log, and service mode notes from `baas-dev/docs` are being migrated to the web docs.

When adding a feature, update configuration docs, scheduler docs, troubleshooting, and README.
