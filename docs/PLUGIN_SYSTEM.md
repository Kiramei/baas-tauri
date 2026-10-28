# Plugins in desktop, Android and WebUI

The Plugins navigation entry uses the same authenticated backend API on every platform. The host owns page layout, typography, settings controls, tables, dialogs and theme. Plugin packages provide a versioned manifest and JSON data; they cannot load frontend scripts, HTML, CSS or Qt widgets.

## Use a plugin

1. On desktop, open **Plugins** in the left navigation. On phones, open **Settings → General → Plugins**. You can browse the catalog or install a local ZIP before choosing a configuration.
2. Choose the configuration that owns its settings and enable the plugin for that configuration. An external Python package requires explicit code trust before enabling.
3. Edit the declared settings and save. A concurrent edit reports a revision conflict instead of silently replacing another client's changes.
4. Fill an action's inputs and run it. Computations show job state, structured results and cancellation. Device tasks use the selected configuration's existing stages, teams and device settings.
5. An enabled plugin can contribute home shortcuts. A shortcut opens the plugin; it does not start an action automatically. Disable or uninstall removes the shortcut.

Switching configurations keeps their settings and jobs separate. Installed packages are shared by the backend, while enablement, trust decisions and values belong to a configuration. Importing a configuration preserves values but clears external code trust and enablement.

Five bundled tools use the current host controls:

- **AP hoarding** computes a time-zone-aware timeline for character AP, cafe storage, daily income and expiring mail. Plans clearly separate expected AP at the target from the balance after spending. Verified, non-overflow steps can run under exclusive profile ownership. Premium purchases, overflow into mail and selective mail collection remain manual: a plan needing these steps is marked non-executable instead of claiming that it can run automatically. Restarting the backend requires replanning.
- **Auto push** has its own mission, story and team settings, supports current-screen entry points, and restores the original profile after cancellation or failure. Unsupported pages stop explicitly.
- **Equipment planner** uses the bundled CN drop tables, stock deficits, two farming strategies, sweep-string recalculation and Eleph planning. It does not claim that CN drops apply to other servers.
- **Inventory calculator** is the Schale stock-management event's 9×5 search puzzle. Mark empty cells and found rectangles, then calculate exact placement probabilities. A resource-limit result shows no estimated probabilities.
- **Home editor** saves each profile's asset, task and shortcut visibility and section order. Drag or use the move buttons. The run controls, Android game panel and log remain available.

The former budget and single-task starter examples now live under `baas-dev/examples/plugins/`; they are no longer additional built-in tools. Existing stored example settings are retained on disk. Lists are edited as ordinary repeatable controls, and date-time fields display device-local time while saving an explicit instant. AP daily resets use the separately configured game time zone.

## Develop an extension

The authoritative backend contract and its compatibility rules live in [baas-dev's Plugin API v1 guide](https://github.com/Kiramei/baas-dev/blob/master/docs/PLUGIN_SYSTEM.md). That repository also includes an installable `examples/plugins/example.notes` template.

The client renders the host-supported JSON Schema subset and rejects an incompatible catalog API version. Settings and computation inputs use the same schema validation rules as the service. Results are displayed as host-rendered values and tables, with raw JSON available for inspection and copying.

Keep `schema_version`, `api_version` and the package `version` distinct. Use stable action and field IDs. New permissions, execution kinds or contributions need a negotiated host capability; they cannot be introduced by sending arbitrary frontend source. The client helper is `src/shared/Plugins.ts` and the backend transport is the existing authenticated trigger channel, including the encrypted binary upload for ZIP installation.

External Python code executes with the backend user's operating-system privileges. Separate workers provide timeout, cancellation and failure isolation; they are not a security sandbox. Packages must be trusted before enabling, and modifying installed bytes invalidates previous trust. No dependency installer or automatic plugin update runs in v1.

Android uses private native service processes for embedded Python. The bridge and lifecycle contract are documented in [Android plugin workers](ANDROID_PLUGIN_WORKERS.md).

An older backend can still run the application; the Plugins page explains that the backend needs updating. On narrow screens the four primary navigation entries remain visible; Plugins is reached through Settings. Forms, the puzzle board and result tables keep any necessary horizontal scrolling inside their own panels.
