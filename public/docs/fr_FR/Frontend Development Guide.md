
# 🏗️ Guide de développement frontal

Ce document décrit la structure de l’application de bureau **BAAS**, le flux de données entre les modules clients et le serveur, ainsi que les exigences opérationnelles lors de l’extension de la plateforme.
Il s’adresse aux **équipes d’ingénierie et de déploiement** nécessitant une référence standard lors de l’intégration ou du développement de nouvelles fonctionnalités.

---

## 🧩 Structure de l’application

L’application React est rendue via `App.tsx`. Elle relie le **ThemeProvider**, **AppProvider** et la structure persistante (`MainLayout`).
Les pages sont commutées à l’aide d’un **routeur framer-motion** léger qui garde les pages inactives montées pour préserver leur état lors du changement d’onglet.

* **Point d’entrée :** `main.tsx` initialise i18n, le thème et rend `<App />`.
* **Providers :** `AppProvider` charge les préférences UI, établit la connexion WebSocket, injecte le catalogue de profils et expose les fonctions via le contexte.
* **Mise en page :** `MainLayout` contient la barre latérale persistante (`Sidebar.tsx`) et l’en-tête (`Header.tsx`).

---

## 🧱 Modules clés

| Module              | Responsabilité                                                                          | Fichiers principaux                                                         |
| :------------------ | :-------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| **Context**         | Partage les paramètres UI, le profil actif et le catalogue de profils.                  | `contexts/AppContext.tsx`                                                   |
| **State Stores**    | Les magasins Zustand normalisent l’état distant (config, événements, statut, journaux). | `store/WebsocketStore.ts`, `store/GlobalLogStore.ts`                        |
| **Remote Services** | Encapsulent les interactions serveur (raccourcis, WebSocket chiffré).                   | `services/hotkeyService.ts`, `lib/SecureWebSocket.ts`                       |
| **Pages**           | Conteneurs de niveau route : `Home`, `Scheduler`, `Configuration`, `Settings`, `Wiki`.  | `pages/*.tsx`                                                               |
| **Feature Forms**   | Panneaux modulaires opérant sur un fragment de `DynamicConfig`.                         | `features/*Config.tsx`, `features/DailySweep.tsx`                           |
| **Shared UI**       | Composants visuels réutilisables (entrées, sélecteurs, modales, journaux).              | `components/ui`, `components/AssetsDisplay.tsx`, `components/Particles.tsx` |
| **Hooks**           | Logique métier, incluant la gestion des raccourcis et du thème.                         | `hooks/useHotkeys.ts`, `hooks/ThemeProvider.tsx`                                 |

---

## 🔄 Vue d’ensemble du flux de données

### 🔌 Initialisation du WebSocket

1. `AppProvider` appelle `useWebSocketStore.getState().init()` au démarrage.
2. `init()` se connecte successivement aux canaux **heartbeat**, **provider** et **sync** via `SecureWebSocket`.
3. Une fois connecté, le store récupère les données statiques, les manifestes de configuration et les files d’événements.
4. Les setters diffusent les mises à jour aux composants abonnés via des sélecteurs Zustand.

---

### ⚙️ Cycle de mise à jour de configuration

1. Les formulaires fonctionnent sur une copie locale de `DynamicConfig`.
2. Lors de l’enregistrement, ils génèrent un objet `patch` minimal et appellent `modify(path, patch, showToast)`.
3. Le store envoie une commande `sync` avec sémantique JSON Patch et enregistre un callback.
4. Quand le backend confirme, le callback supprime l’état en attente et affiche une notification (`sonner`).
5. Les messages `config` entrants synchronisent le store local pour rafraîchir tous les abonnés.

---

### 📡 Télémétrie du planificateur

* Les pages **Home** et **Scheduler** s’abonnent à `statusStore` et `logStore` pour afficher les métriques d’exécution.
* Le pipeline de logs déduplique et copie les journaux dans `globalLogStore`.
* Toutes les commandes sortantes (démarrage, arrêt, patchs) sont horodatées pour faciliter la corrélation.

---

### 🌐 Internationalisation

Les traductions sont stockées dans `assets/locales/*.json` et chargées via `react-i18next`.
Langue par défaut : **chinois (`zh`)**, avec **anglais en secours**.
Le contenu est organisé par domaine (scheduler, artifact, etc.) pour simplifier la localisation.

---

### ⚡ Performance et UX

* **Préservation du montage** empêche la réinitialisation des composants lors du changement d’onglet.
* `useMemo` et `useCallback` limitent les re-rendus inutiles.
* Les zones de défilement utilisent des classes `scroll-embedded` pour un style uniforme.
* Les mises à jour en temps réel utilisent des setters Zustand groupés.

---

### 🧰 Outils

* **Build :** Vite + React 19 + TypeScript 5
* **Style :** Tailwind CSS + composants réutilisables
* **Animations :** `framer-motion` (transitions), `ogl` (effets de particules)

---

### 🚀 Extensibilité

1. Créez ou mettez à jour un composant dans `features/` et reliez-le à `featureMap`.
2. Ajoutez les nouvelles étiquettes dans `en.json` et `zh.json`.
3. Persistez les communications serveur via `modify`, `patch`, ou `trigger`.
4. Exposez les réglages UI via `AppContext` si nécessaires.

---

✅ *En suivant ce contrat, vous garantissez que :*

* L’application reste **cohérente et extensible**.
* La **navigation au clavier** et la **synchronisation télémétrique** fonctionnent correctement.
* L’état **WebSocket** reste cohérent sur toutes les pages.
