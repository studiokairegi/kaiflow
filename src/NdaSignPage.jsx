import React from "react";
import SignDocumentPage from "./SignDocumentPage.jsx";
import { publicGetNda, publicSignNda, publicDeclineNda, downloadNdaPdf, NDA_CONSENT_TEXT } from "./ndaApi";

// Public NDA signing page, rendered when the URL is ?share=nda&token=...
// No account needed: it talks to the nda_public_* RPCs only.
const api = { get: publicGetNda, sign: publicSignNda, decline: publicDeclineNda };

export default function NdaSignPage({ token }) {
  return (
    <SignDocumentPage token={token} docLabel="NDA" api={api} downloadPdf={downloadNdaPdf} consentText={NDA_CONSENT_TEXT} />
  );
}
