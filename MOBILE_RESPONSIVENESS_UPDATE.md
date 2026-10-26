# Mobile responsiveness update

This patch improves small-screen layout and touch usability while keeping the payment, notification, and data logic unchanged.

## Included changes

- Added `src/responsive.css` and imported it from `src/main.jsx`.
- Made primary workspace tabs, project tabs, and the pipeline editor's tabs horizontally scrollable on narrow screens.
- Tightened the app header and content gutters for tablets and phones.
- Adapted project cards, settings grids, and other auto-fit grids to a single-column layout when needed.
- Stacked form field rows on narrow screens and constrained fixed-width controls.
- Made app modals and settings dialogs fit within the visible mobile viewport, respecting safe-area insets.
- Made wide data tables scroll within their container rather than widening the whole page.
- Improved touch targets and mobile input font sizing to reduce accidental taps and iOS input zoom.
- Made public Paywise checkout, portfolio, and client/freelancer pages adapt to phone widths.
- Added `viewport-fit=cover` for safe-area-aware mobile layouts.
- Preserved the existing Apple Pay `public/_headers` rule.

## Apply

Extract this ZIP into the root of your existing `shot-tracker-app` repository, allowing the listed files to overwrite their counterparts. It is a patch ZIP: it does not include `.env`, `.git`, `node_modules`, or generated build output.

Then run:

```bat
npm run build
npm test
```

If your repo tracks generated `dist/index.html` and the build modifies it, restore that generated file unless your deployment setup explicitly requires committing `dist`:

```bat
git restore dist/index.html
```

Review and push only the intended source changes:

```bat
git status --short
git add index.html src/main.jsx src/responsive.css src/App.jsx src/SharedViews.jsx src/payments/PayCheckoutPage.jsx src/portfolio/PortfolioPage.jsx public/_headers
git diff --cached --check
git commit -m "Improve mobile responsiveness across Paywise"
git push origin main
```

## Validation performed for this patch

- Babel JSX parsing passed for all edited JSX modules.
- PostCSS parsing passed for `src/responsive.css`.
- The repository test command reported 234 passing tests and 9 failing test files. The failing tests include direct Node imports of Supabase Edge Function `.ts` modules, which Node 22 rejects with `ERR_UNKNOWN_FILE_EXTENSION` in this test environment; this patch does not change those modules or business logic.
- A full production build could not be completed in this Linux environment because the repository archive's `node_modules` came from Windows and lacks the Linux-native Rollup optional dependency. Run the build in your existing Windows checkout before committing.

Please check the dashboard, Finance, Teams, Planner, Settings, modals, and client payment link on a phone-sized viewport after deployment. Responsive improvements are broad layout fixes; any individual module may still need a specific follow-up adjustment if its content is unusually wide.
