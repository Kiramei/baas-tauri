# Updates and Troubleshooting

## Updates

Settings supports stable and development channels. Update sources include GitHub, Gitee, GitCode, GitHub proxies, SevenCDN, GitHubFast, BAAS CDN, and MirrorC. MirrorC requires a valid CDK. SHA tests check source availability and latency.

Client updates and BAAS backend updates are separate flows, and the sidebar shows them separately when available.

## Common issues

- Heartbeat connecting: check backend service, port, firewall, and key.
- ADB failure: confirm emulator ADB is enabled and multi-instance ports are correct.
- Screenshot errors: confirm game window ratio, turn off HDR, and try another screenshot method.
- Recognition errors: check server, language, resolution, and script logs.
- Update failure: switch source, check MirrorC CDK, keep logs, and retry.

When reporting an issue, include logs, configuration notes, server, emulator version, screenshots, and reproduction steps.
