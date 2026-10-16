# NDA signing for freelancers (Teams)

1. Run `migration_nda_signing.sql` in the Supabase SQL editor.
2. Copy `ndaApi.js`, `NdaTab.jsx`, `NdaSignPage.jsx` into `src/`.
3. Replace `src/App.jsx` with the patched copy here (or apply the diff: import, `nda` tab,
   `studioName` prop, roster badge).
4. In the file that already routes `?share=` links (main.jsx / wherever SharedViews is mounted), add before the app renders:

```jsx
import NdaSignPage from "./NdaSignPage.jsx";
const q = new URLSearchParams(window.location.search);
if (q.get("sign") === "nda" && q.get("token")) {
  // render <NdaSignPage token={q.get("token")} /> instead of <App />
}
```
