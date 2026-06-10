<div align="center">
<h1> 🌌 BAAS Tauri App </h1>

_Automation command app for multi-profile Blue Archive orchestration_

![Tauri](https://img.shields.io/badge/Tauri-2.0-38BD78.svg?logo=tauri&logoColor=white) [![React](https://img.shields.io/badge/React-19.1-61DAFB?logo=react&logoColor=white)](https://react.dev/) [![Tailwind](https://img.shields.io/badge/Tailwind-4.1-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/) [![License: GPL v3](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

</div>

|            ☀️ Light Mode            |           🌙 Dark Mode            |
| :---------------------------------: | :-------------------------------: |
| ![Light Mode](docs/cover-light.png) | ![Dark Mode](docs/cover-dark.png) |

---

## 🚀 Overview

BAAS Tauri App is a React-driven desktop dashboard that wraps the Blue Archive automation core with a
polished, responsive control surface. It keeps pilots in control of multi-instance farming by blending real-time
telemetry, drag-and-drop scheduling, and richly localized documentation in one place.

Under the hood the app binds secure WebSocket channels (`provider`, `sync`, `trigger`, `heartbeat`, ``) to a local
automation service, persists UI preferences, and renders fine-grained configuration panels for every daily activity —
from cafés and arenas to tactical drills and whitelist management.

```
✨ Multi-profile orchestration with drag-to-reorder tabs
⚡ Real-time task queue and log streaming over secure WebSockets
🧠 Built-in multilingual wiki (EN/JA/KO/ZH/RU/FR/DE) with syntax-highlighted guides
🧩 Modular configuration modals for every automation domain
```

---

<details open>
<summary><b>📑 Table of Contents</b></summary>

<div style="text-align: left">

| Section                                   | Description                             |
| :---------------------------------------- | :-------------------------------------- |
| [🚀 Overview](#-overview)                 | Project summary & key features          |
| [🏗️ Architecture](#-architecture)         | Structural design and workflow          |
| [⚙️ Installation](#-installation)         | Setup instructions and environment      |
| [🧩 Usage](#-usage)                       | How to run and interact with the system |
| [🛠️ Configuration](#-configuration)       | Customization and environment variables |
| [🧠 Tech Stack](#-tech-stack)             | Frameworks, libraries, and tools        |
| [🗂️ Folder Structure](#-folder-structure) | Directory layout and file roles         |
| [📸 Visuals](#-visuals)                   | UI previews and architecture diagrams   |
| [🤝 Contributing](#-contributing)         | Guidelines for contributors             |
| [📜 License](#-license)                   | Licensing details and credits           |

</div>

</details>

---

## 🧠 Architecture

| Layer                  | Technology                          | Description                                                                             |
| :--------------------- | :---------------------------------- | :-------------------------------------------------------------------------------------- |
| Interface              | React 19 + Tailwind CSS 4           | Componentized dashboard with motion-enhanced layouts                                    |
| State Sync             | Zustand + SecureWebSocket           | Multi-socket store that decrypts payloads and normalizes config/event/status streams    |
| Automation Core Bridge | Command & Trigger Channels          | Dispatches scheduler commands (`start`, `stop`, `patch`, `trigger`) to the BAAS runtime |
| Knowledge Surface      | i18next + Markdown + React Markdown | Localized wiki with syntax highlighting and offline docs                                |

- **Profile-centric workflow** — `src/components/layout/Header.tsx` handles tab creation, drag sorting, and
  storage-backed persistence.
- **Task engine** — `src/pages/SchedulerPage.tsx` manages the dual-column event queue with `FeatureSwitchModal` to edit
  task payloads.
- **Telemetry pipeline** — `src/components/ui/Logger.tsx` streams thousands of log lines using `react-window`
  virtualization while `HeartbeatIndicator.tsx` visualizes socket health.
- **Secure handshake** — `src/lib/SecureWebSocket.ts` performs negotiation before any payload is
  exchanged.

---

## 🛠️ Installation

> **Prerequisites:** Node.js 20+ and bun ≥ 9 are recommended for Vite 7 and React 19 compatibility.

```bash
# Clone repository
git clone https://github.com/Kiramei/baas-web.git
cd baas-web

# Install dependencies
bun install

# Start development server
bun dev
```

- The app expects the Blue Archive Auto Script backend to be reachable at `ws://localhost:8190`.
- Run `bun build` to produce a production bundle (output in `dist/`).

---

## ⚙️ Usage

1. Please prepare [BAAS](https://github.com/pur1fying/blue_archive_auto_script) done
   by [pur1fy](https://github.com/pur1fying) and switch to Branch `feature/service`.
2. Prepare the environment with `requirements.service.txt`.
3. Launch the local automation daemon (`main.service.py`) so WebSocket handshakes succeed.
4. Start the GUI with `bun dev` and open the served URL (default `http://127.0.0.1:5173`).
5. Use the top tab bar to create profiles per emulator/server; drag tabs to reorder and persist via `localStorage`.
6. Kick off automation from the **Home** page — watch `TaskStatus` chips, live asset snapshots, and stream logs.
7. Tune the lineup in **Scheduler**: search, sort, toggle tasks, edit run windows, and apply `FeatureSwitchModal`
   overrides.
8. Dive into **Configuration** to refine cafés, arenas, stages, artifacts, push notifications, whitelists, and more.
9. Visit **Settings** for theme, zoom, language (`i18next`), update channel checks, and SHA mirror diagnostics.
10. Consult **Wiki** for localized guides rendered via `react-markdown` with `rehype-highlight`.

---

## 📸 Visuals

<table style="table-layout: fixed; width: 100%; border-collapse: collapse;">
  <thead>
    <tr>
      <th style="text-align: center;">①</th>
      <th style="text-align: center;">②</th>
      <th style="text-align: center;">③</th>
    </tr>
  </thead>
  <tr>
    <td style="text-align: center; height: 300px;">
      <img src="docs/page-wiki.png" alt="Wiki Page" id="image1" width="100%" />
    </td>
    <td style="text-align: center; height: 300px;">
      <img src="docs/page-setting-2.png" alt="Settings Page 2" id="image2" width="100%" />
    </td>
    <td style="text-align: center; height: 300px;">
      <img src="docs/page-setting-1.png" alt="Settings Page 1" id="image3" width="100%" />
    </td>
  </tr>
  <thead>
    <tr>
      <th style="text-align: center;">④</th>
      <th style="text-align: center;">⑤</th>
      <th style="text-align: center;">⑥</th>
    </tr>
  </thead>
  <tr>
    <td style="text-align: center; height: 300px;">
      <img src="docs/page-config.png" alt="Configuration" id="image4" width="100%" />
    </td>
    <td style="text-align: center; height: 300px;">
      <img src="docs/page-scheduler.png" alt="Scheduler Page" id="image5" width="100%" />
    </td>
    <td style="text-align: center; height: 300px;">
      <img src="docs/feature-cafe.png" alt="Cafe Feature" id="image6" width="100%" />
    </td>
  </tr>
</table>

- **📖 Wiki Page**: This page serves as the documentation hub for the project, providing users with easy access to the
  project's instructions, API documentation, and general guidelines. See image ①.
- **⚙️ Settings Page 2**: Settings Page 2 allows users to configure additional options, such as advanced preferences,
  notifications, and more detailed system settings. See image ②.
- **⚙️ Settings Page 1**: Settings Page 1 focuses on user account settings, where users can modify their personal
  information, change their password, and set language preferences. See image ③.
- **🧩 Configuration**: The configuration page is used by system administrators to set up core system features, including
  managing database connections, API keys, and backend services. See image ④.
- **⏱ Scheduler**: The scheduler feature allows users to automate tasks such as running reports, sending notifications,
  or syncing data with other systems. Check image ⑤.
- **☕ Café Feature**: The café feature enables users to explore coffee options and place orders directly through the
  app, integrating the café's menu and ordering system into the user's interface. See image ⑥.

---

## 🔧 Configuration

- **WebSocket endpoints:** Adjust `BASE` or channel names in `src/store/WebsocketStore.ts:19` if your automation service
  runs elsewhere.
- **UI defaults:** Persisted via `StorageUtil` (`src/lib/StorageManager.ts`); initial values are injected in
  `AppContext.tsx`.
- **Localization:** Update `src/assets/locales/*.json` for new languages; wiki articles live in
  `src/assets/docs/<locale>`.
- **Hotkeys:** Extend `src/services/hotkeyService.ts` once the backend API is ready; UI bindings are powered by
  `useRemoteHotkeys`.
- **Themes & zoom:** Controlled in `src/pages/SettingsPage.tsx`, leveraging `useTheme` and global CSS variables.

> Need a new automation feature? Create a modal component under `src/features/` and register it in
> `ConfigurationPage.tsx`.

---

## 📦 Tech Stack

| Category          | Tools                                        | Notes                                                        |
| :---------------- | :------------------------------------------- | :----------------------------------------------------------- |
| Core Framework    | React 19, Vite 7                             | Fast dev server, modern JSX transforms                       |
| Styling           | Tailwind CSS 4, CSS variables                | Dark/light modes, custom cursor & scrollbar skins            |
| State & Data      | Zustand, React Context, localStorage         | Profile store, config snapshots, UI preferences              |
| Realtime & Crypto | SecureWebSocket                              | Authenticated sockets for `provider/sync/trigger/heartbeat`  |
| UX Enhancements   | Framer Motion, Radix UI, Sonner              | Animated layouts, accessible primitives, toast notifications |
| Content           | React Markdown, remark-gfm, rehype-highlight | Wiki rendering with fenced code highlighting                 |

---

## 📁 Folder Structure

```text
📦 Project Root
├─ 📂 src
│  ├─ 📂 assets        # 🎨 icons, fonts, locale bundles, wiki markdown
│  ├─ 📂 components    # 🧩 layout shell, UI kit, feature modals
│  ├─ 📂 contexts      # 🧠 global providers (AppContext)
│  ├─ 📂 features      # ⚙️ domain-specific configuration panels
│  ├─ 📂 hooks         # 🪝 reusable theme & hotkey hooks
│  ├─ 📂 lib           # 🧰 utilities (i18n, storage, SecureWebSocket, wiki data)
│  ├─ 📂 pages         # 📄 routed surfaces (Home, Scheduler, Configuration, Settings, Wiki)
│  ├─ 📂 services      # 🛰️ backend abstractions (hotkey service stubs)
│  ├─ 📂 store         # 💾 Zustand stores (WebSocket bridge, global logs)
│  └─ 📂 types         # 📘 shared TypeScript definitions for configs & events
│
├─ 📜 package.json
├─ 📜 tsconfig.json
├─ 📄 index.html
└─ 📄 README.md
```

---

## 🤝 Contributing

| Name    | Role         | Contact                                |
| :------ | :----------- | :------------------------------------- |
| Kiramei | Project Lead | [@Kiramei](https://github.com/Kiramei) |

1. Fork the repository and create a feature branch.
2. Follow the existing code style (Tailwind utility-first, TypeScript strict).
3. Add or update localized strings when introducing new UI copy.
4. Open a pull request with screenshots or clips for UI-facing changes.

---

## 📜 License

> Licensed under the **GNU General Public License v3.0 (GPLv3)** © 2025 BAAS Dev Team
>
> This project is open source and free to use, modify, and distribute under the terms of the GPLv3.  
> Contributions are always welcome 💡
