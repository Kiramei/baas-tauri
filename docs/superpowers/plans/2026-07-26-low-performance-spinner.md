# Low-performance Loading Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep existing `animate-spin` loading indicators rotating in low-performance mode while all other animations remain disabled.

**Architecture:** Add one high-specificity CSS exception after the global low-performance suppression rule. Verify the computed browser animation state with a temporary Vite fixture, then remove the fixture so production changes remain limited to the shared stylesheet.

**Tech Stack:** Tailwind CSS 4, Vite 8, React 19, Bun

## Global Constraints

- Restore animation only for elements using the existing `animate-spin` utility.
- Keep `animate-pulse`, page transitions, hover motion, background effects, shadows, filters, and smooth scrolling disabled in low-performance mode.
- Apply the behavior consistently to desktop and Android without editing individual loading components.
- Add no dependencies.

---

### Task 1: Restore spinner animation in low-performance mode

**Files:**

- Modify: `src/styles/index.css:155-174`
- Temporarily create and then delete: `spinner-repro.html`
- Temporarily create and then delete: `src/spinner-repro.tsx`
- Verify: existing `tests/frontend`

**Interfaces:**

- Consumes: the existing `html.low-performance-mode` root class and Tailwind `animate-spin`/`animate-pulse` utilities.
- Produces: CSS rule `html.low-performance-mode .animate-spin` with animation name `low-performance-spin`.

- [ ] **Step 1: Create the browser characterization fixture**

Create `spinner-repro.html`:

```html
<!doctype html>
<html lang="en" class="low-performance-mode">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Low-performance spinner repro</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/spinner-repro.tsx"></script>
  </body>
</html>
```

Create `src/spinner-repro.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import "@/styles/index.css";

const Repro = () => (
  <main>
    <div
      data-testid="spinner"
      className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-cyan-500"
    />
    <div data-testid="pulse" className="h-8 w-8 animate-pulse bg-cyan-500" />
  </main>
);

createRoot(document.getElementById("root")!).render(<Repro />);
```

- [ ] **Step 2: Run the fixture and verify the current behavior fails**

Run:

```powershell
bunx vite --mode webui --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/spinner-repro.html` and read computed styles for both test elements.

Expected before implementation:

```text
spinner.animationName = "none"
pulse.animationName = "none"
```

This proves the existing global low-performance rule suppresses the functional loading indicator.

- [ ] **Step 3: Add the minimal CSS exception**

Append directly after the global animation-suppression block in `src/styles/index.css`:

```css
@keyframes low-performance-spin {
  to {
    transform: rotate(360deg);
  }
}

html.low-performance-mode .animate-spin {
  animation: low-performance-spin 1s linear infinite !important;
}
```

Do not change the global `animation: none`, transition, filter, shadow, or scroll rules.

- [ ] **Step 4: Verify the browser behavior passes**

Reload the fixture and read computed styles again.

Expected after implementation:

```text
spinner.animationName = "low-performance-spin"
spinner.animationIterationCount = "infinite"
pulse.animationName = "none"
```

Read the spinner transform, wait 150–250 ms, and read it again. The two transform matrices must differ, proving the spinner is actively rotating rather than merely declaring an animation.

- [ ] **Step 5: Remove the temporary fixture**

Delete only:

```text
spinner-repro.html
src/spinner-repro.tsx
```

Confirm `git status --short` lists neither path.

- [ ] **Step 6: Run complete verification**

Run:

```powershell
bun test tests/frontend
bun run lint
bunx prettier --check src/styles/index.css
bun run build:tauri
git diff --check
```

Expected:

```text
6 tests pass, 0 fail
ESLint and i18n check pass
Prettier check passes
Tauri frontend build succeeds
git diff --check prints no errors
```

- [ ] **Step 7: Commit only the spinner change and implementation plan**

Run:

```powershell
git add -- src/styles/index.css docs/superpowers/plans/2026-07-26-low-performance-spinner.md
git commit -m "fix: keep loading spinners active in low-performance mode"
```

Do not stage the existing `src/App.tsx` or `src/pages/ConfigurationPage.tsx` changes.
