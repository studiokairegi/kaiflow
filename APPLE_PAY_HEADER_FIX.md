Apple Pay verification response header fix

This Cloudflare Pages `_headers` rule tells Pages to return the Paystack Apple Pay domain-association file with the required Content-Type.

Install:
1. Copy `public/_headers` into the existing repository's `public` directory.
2. If `public/_headers` already exists, preserve all existing rules and append this new rule rather than replacing the file.
3. Run `npm run build` and verify `dist/_headers` contains the rule.
4. Commit and push `public/_headers`; wait for Cloudflare Pages to deploy.
5. Verify with:
   curl.exe -sS -L -o NUL -w "HTTP status: %{http_code}\nContent-Type: %{content_type}\nFinal URL: %{url_effective}\n" "https://app.studiokairegi.com/.well-known/apple-developer-merchantid-domain-association"

Expected: HTTP status 200 and Content-Type application/text.

This fixes the response header only. It does not activate Apple Pay in Paystack, verify the merchant domain in Paystack, or alter the verification file contents.
