
# 🏗️ Frontend-Entwicklungsleitfaden

Dieses Dokument beschreibt, wie die **BAAS Desktop-Applikation** strukturiert ist, wie Daten zwischen Client-Modulen und dem Backend fließen, und was bei Erweiterung der Plattform erwartet wird.
Es richtet sich an **Engineering- und Delivery-Teams**, die eine kanonische Referenz beim Onboarding oder der Implementierung neuer Features benötigen.

---

## 🧩 Anwendungsschale

Die React-Applikation wird über `App.tsx` gerendert. Sie verbindet den **ThemeProvider**, den **AppProvider** und das persistente Layout-Gerüst (`MainLayout`).
Seiten werden über einen leichten **framer-motion Router** gewechselt, der inaktive Seiten gemountet hält, sodass sie ihren Zustand beim Tab-Wechsel behalten.

* **Einstiegspunkt:** `main.tsx` initialisiert i18n, das Theme und rendert `<App />`.
* **Provider:** `AppProvider` lädt UI-Präferenzen, stellt WebSocket-Verbindungen her, injiziert das Profilkatalog und stellt Setter über Context zur Verfügung.
* **Layout:** `MainLayout` enthält die persistente Seitenleiste (`Sidebar.tsx`) und den Header (`Header.tsx`).

---

## 🧱 Schlüsselmodule

| Modul               | Verantwortung                                                                                           | Wichtige Dateien                                                            |
| :------------------ | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------- |
| **Context**         | Teilt UI-Einstellungen, aktives Profil und Profilkatalog in der App.                                    | `contexts/AppContext.tsx`                                                   |
| **State Stores**    | Zustand-Stores normalisieren Remote-State (Konfig, Events, Status, Logs).                               | `store/WebsocketStore.ts`, `store/GlobalLogStore.ts`                        |
| **Remote Services** | Kapselt Backend-Verträge wie Hotkey-Persistenz und verschlüsselte WebSocket-Sessions.                   | `services/hotkeyService.ts`, `lib/SecureWebSocket.ts`                       |
| **Pages**           | Container auf Routenebene für `Home`, `Scheduler`, `Configuration`, `Settings`, `Wiki`.                 | `pages/*.tsx`                                                               |
| **Feature Forms**   | Modulare Konfigurationspanel, das auf einem Ausschnitt von `DynamicConfig` arbeitet.                    | `features/*Config.tsx`, `features/DailySweep.tsx`                           |
| **Shared UI**       | Wiederverwendbare visuelle Primitiven und Komponenten für Publikum (Inputs, Selectors, Modals, Logger). | `components/ui`, `components/AssetsDisplay.tsx`, `components/Particles.tsx` |
| **Hooks**           | Business-Logic Hooks, etwa Hotkey-Orchestrierung und Theme-Handling.                                    | `hooks/useHotkeys.ts`, `hooks/ThemeProvider.tsx`                                 |

---

## 🔄 Datenflussübersicht

### 🔌 WebSocket-Initialisierung

1. `AppProvider` ruft `useWebSocketStore.getState().init()` beim Start auf.
2. `init()` verbindet sich nacheinander mit **Heartbeat**, **Provider** und **Sync** Channels via `SecureWebSocket`.
3. Sobald verbunden, lädt der Store statische Daten, Konfigurationsmanifeste und Live-Event-Queues.
4. Store-Setter senden Updates an abonnierte Komponenten via Zustand-Selektoren.

---

### ⚙️ Konfigurations-Update-Zyklus

1. Feature-Forms arbeiten auf einer lokalen Entwurfs-Kopie von `DynamicConfig`.
2. Beim Speichern erzeugt das Formular ein minimalen `patch`-Objekt und ruft `modify(path, patch, showToast)` auf.
3. Der Store sendet einen `sync` Befehl mit JSON-Patch-Semantik und registriert einen Callback in `pendingCallbacks`.
4. Wenn das Backend den Befehl bestätigt, leert der Callback den Pending-Status und zeigt optional einen Toast via `sonner` an.
5. Eingehende `config` Nachrichten synchronisieren den lokalen Store, sodass alle Abonnenten automatisch aktualisiert werden.

---

### 📡 Scheduler-Telemetry

* **Home**- und **Scheduler**-Seiten abonnieren `statusStore` und `logStore`, um Laufzeitkennzahlen anzuzeigen.
* Die Log-Pipeline dedupliziert Einträge und spiegelt globale Logs in `globalLogStore` für das Terminal des Ladescreens.
* Alle ausgehenden Befehle (Start/Stop Trigger, Patches) werden mit Zeitstempeln versehen, um Konsistenz bei der Reconciliation zu erleichtern.

---

## ⚙️ Querschnittliche Anliegen

### 🌐 Internationalisierung

Übersetzungen werden in `assets/locales/*.json` gespeichert und über `react-i18next` geladen.
Die Standardsprache ist **Chinesisch (`zh`)**, mit **Englisch** als Fallback.
UI-Texte sind nach Domänen (Scheduler, Artifact etc.) organisiert, um Lokalisierungsupdates zu vereinfachen.

---

### ⚡ Leistung & UX

* **Mount Preservation** (siehe `App.tsx`) verhindert, dass teure Komponenten bei Tabwechseln neu initialisiert werden.
* Feature-Forms verwenden `useMemo` und `useCallback`, um unnötige Re-Renders zu vermeiden.
* Scroll-Bereiche nutzen `scroll-embedded` Utility-Klassen für konsistentes Styling.
* Echtzeit-Updates verwenden **gebündelte Zustand-Setter**; große Updates (z. B. Logs) werden unveränderlich angehängt, um Referenz-Churn zu minimieren.

---

### 🧰 Tooling

* **Build:** Vite + React 19 + TypeScript 5
* **Styling:** Tailwind CSS mit benutzerdefinierten Token und wiederverwendbaren UI-Komponenten
* **Animationen:** `framer-motion` für Übergänge, `ogl` für Partikeleffekte

---

## 🚀 Erweiterbarkeitscheckliste

1. Erstelle oder aktualisiere eine Feature-Komponente unter `features/` und binde sie in die `featureMap` (Konfigurationsseite) ein.
2. Erweitere die Übersetzungswörterbücher mit neuen Labels sowohl in `en.json` als auch `zh.json`.
3. Persistiere Server-Kommunikation über `modify`, `patch` oder `trigger`, um konsistentes Acknowledgement-Handling zu gewährleisten.
4. Exponiere UI-Einstellungen über `AppContext`, falls sie vom Anwender konfigurierbar sein sollen.

---

Das Einhalten dieses Kontrakts stellt sicher, dass:

* Die Anwendung konsistent und erweiterbar bleibt.
* **Tastatursteuerung** und **Telemetry-Synchronisation** korrekt funktionieren.
* Der **WebSocket-State** über alle Seiten hinweg kohärent bleibt.
