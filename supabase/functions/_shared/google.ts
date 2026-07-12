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
  fileBytes: Uint8Array,
  mimeType: string
): Promise<{ id: string; url: string }> {
  const boundary = "kaiflow-drive-upload-boundary";
  const metadata = { name: fileName, parents: [folderId] };

  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`;
  const filePartHeader =
    `--${boundary}\r\n` + `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const encoder = new TextEncoder();
  const body = new Blob([
    encoder.encode(metadataPart),
    encoder.encode(filePartHeader),
    fileBytes,
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
  return { id: json.id, url: `https://drive.google.com/file/d/${json.id}/view` };
}
