# Low-performance loading spinner design

## Goal

Keep loading spinners visibly rotating in low-performance mode so asynchronous work does not
appear frozen, while continuing to suppress decorative and nonessential animation.

## Scope

- Restore animation only for elements using the existing `animate-spin` utility.
- Keep `animate-pulse`, page transitions, hover motion, background effects, shadows, filters, and
  smooth scrolling disabled in low-performance mode.
- Apply the behavior consistently to desktop and Android without editing individual loading
  components.

## Design

Add a targeted CSS override after the existing low-performance animation suppression rule in
`src/styles/index.css`. The override will restore a lightweight linear infinite rotation for
`.animate-spin` elements with sufficient specificity and `!important` to win over the global
low-performance rule.

No component or settings-state changes are required. Existing components continue to express
loading state through the `animate-spin` class.

## Verification

- In a real browser, enable `low-performance-mode` and confirm an `animate-spin` element retains a
  running rotation animation.
- Confirm a non-spinner animated element still reports no animation.
- Run frontend tests, lint, formatting checks, and the Tauri frontend build.
