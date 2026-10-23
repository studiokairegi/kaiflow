Only changed/new files, at their repo-relative paths. Nothing here deletes or renames anything.

1. src/App.jsx is NOT included (it is large and you may have edited it since). Apply the patch instead:
     git apply --ignore-whitespace --check App.jsx.pay-now.patch   (then without --check)
   It touches 4 places: the Pay Now button in downloadInvoicePDF, the dashboard payments summary (live vs test),
   and the two "Pay now (test)" labels.
2. The other files are full replacements of the same-named files from the paystack.zip you uploaded
   (or new files). If you changed any of them since, diff before copying.
3. PAYMENTS_LIVE.md is the new setup doc (your existing PAYMENTS.md is left untouched).
4. Apply order: migration 20261025090000 after 20261021090000, then deploy the three Edge Functions.
