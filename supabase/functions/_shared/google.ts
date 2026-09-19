// Thin wrappers around Google's OAuth token endpoint and the Drive v3 REST
// API. Plain fetch calls, no googleapis package needed in Deno.

export async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  return json.access_token as string;
}

export async function createDriveFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<{ id: string; url: string }> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive folder creation failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  return { id: json.id, url: `https://drive.google.com/drive/folders/${json.id}` };
}

export async function uploadFileToDrive(
  accessToken: string,
  folderId: string,
  fileName: string,
  fileData: Uint8Array | Blob,
  mimeType: string
): Promise<{ id: string; url: string }> {
  // Randomized per upload rather than a fixed constant: a hardcoded
  // boundary that happens to appear inside the uploaded file's own bytes
  // would corrupt the multipart framing and produce a truncated or
  // rejected upload. Vanishingly unlikely with this string, but the fix
  // costs nothing and removes the class of bug entirely.
  const boundary = `kairil-drive-${crypto.randomUUID()}`;
  const metadata = { name: fileName, parents: [folderId] };

  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`;
  const filePartHeader =
    `--${boundary}\r\n` + `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const encoder = new TextEncoder();
  // fileData is accepted as a Blob/File directly (not just Uint8Array) so
  // callers can hand over the uploaded File as-is. Passing the File means
  // Blob references its existing backing data rather than the caller first
  // materialising the whole thing via arrayBuffer() and this then copying
  // it again - which was costing roughly 2x the file size in resident
  // memory for every upload, against an Edge Function memory ceiling far
  // below what the old 200MB cap implied was safe.
  const body = new Blob([
    encoder.encode(metadataPart),
    encoder.encode(filePartHeader),
    fileData,
    encoder.encode(closing),
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Drive upload failed: ${res.status} ${errBody}`);
  }
  const json = await res.json();
  // New Drive files are private to the uploading account by default. The
  // studio's account is the only one that ever authenticates to Drive here
  // - the freelancer/client only ever get a stored file URL - so without
  // this, every attachment/deliverable link 404s with Google's "you need
  // access" screen for anyone who isn't signed into that exact account,
  // including the freelancer who just uploaded it. Applied here rather than
  // in each caller so both the studio attachment path and the freelancer
  // deliverable path get it automatically.
  await shareFileWithAnyone(accessToken, json.id);
  return { id: json.id, url: `https://drive.google.com/file/d/${json.id}/view` };
}

// Best-effort: a sharing hiccup shouldn't fail an upload that otherwise
// succeeded - the file is still safely in Drive, just needs a manual share
// (Drive > right-click > Share > Anyone with the link) - so this logs and
// returns false rather than throwing.
export async function shareFileWithAnyone(accessToken: string, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    if (!res.ok) {
      console.error(`Sharing Drive file ${fileId} failed: ${res.status} ${await res.text()}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`Sharing Drive file ${fileId} failed:`, err);
    return false;
  }
}

// Moves a Drive file to the owner's trash (not a permanent delete) so a
// mistaken removal in Kairil is still recoverable from Drive itself for
// the usual 30 days. Returns false rather than throwing on failure - a
// file that's already gone, or was manually deleted in Drive, shouldn't
// block removing the attachment record from the shot.
export async function trashDriveFile(accessToken: string, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
