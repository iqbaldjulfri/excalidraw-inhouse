import { MIME_TYPES } from "@excalidraw/common";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FOLDER_NAME = "Excalidraw";

// appProperties are private to this OAuth client, so they tag our files
// without relying on names the user can change.
const ROLE_KEY = "excalidrawRole";
const ROLE_FOLDER = "drawings-folder";
const ROLE_DRAWING = "drawing";

const DRAWING_FIELDS =
  "id,name,modifiedTime,version,thumbnailLink,capabilities(canEdit)";
const FOLDER_FIELDS = "id,name";

export type DriveDrawing = {
  id: string;
  name: string;
  modifiedTime: string;
  /** Drive bumps this on every change to the file, including our own writes. */
  version: string;
  /**
   * Expires within hours. Measured in Nov 2026: an <img> loads it without
   * cookies or auth, but fetch() can't, as it sends no CORS headers.
   */
  thumbnailLink?: string;
  capabilities?: { canEdit?: boolean };
};

export type DriveFolderItem = { id: string; name: string };

/** Drive serves thumbnails at the size named by the link's `=s<px>` suffix. */
export const sizeThumbnailLink = (link: string, longestSide: number) =>
  `${link.replace(/=s\d+$/, "")}=s${longestSide}`;

const toBase64Url = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

// Drive shows this only when it can't make its own thumbnail, which it can't
// for .excalidraw files. A content upload without it keeps the old one.
const thumbnailHint = async (thumbnail: Blob | undefined) =>
  thumbnail
    ? {
        contentHints: {
          thumbnail: {
            image: await toBase64Url(thumbnail),
            mimeType: thumbnail.type,
          },
        },
      }
    : null;

const multipartBody = (metadata: object, content: string) => {
  const boundary = `excalidraw-${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${MIME_TYPES.excalidraw}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
};

export class DriveApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DriveApiError";
  }
}

export const isDriveAuthError = (error: unknown) =>
  error instanceof DriveApiError && error.status === 401;

export const isDriveNotFoundError = (error: unknown) =>
  error instanceof DriveApiError && error.status === 404;

export const toDriveFileName = (name: string) =>
  name.endsWith(".excalidraw") ? name : `${name}.excalidraw`;

export const toDrawingName = (fileName: string) =>
  fileName.replace(/\.excalidraw$/, "");

export class DriveClient {
  constructor(
    private readonly getAccessToken: (opts: {
      forceRefresh: boolean;
    }) => Promise<string>,
  ) {}

  private async send(url: string, init: RequestInit, forceRefresh: boolean) {
    const token = await this.getAccessToken({ forceRefresh });
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }

  private async request(url: string, init: RequestInit = {}) {
    let response = await this.send(url, init, false);
    if (response.status === 401) {
      response = await this.send(url, init, true);
    }
    if (!response.ok) {
      let message = `Google Drive request failed (${response.status})`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch {
        // non-JSON error body: keep the status-based message
      }
      throw new DriveApiError(message, response.status);
    }
    return response;
  }

  private async requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.request(url, init);
    return response.json() as Promise<T>;
  }

  async ensureFolder(): Promise<string> {
    const query = [
      `mimeType='${FOLDER_MIME_TYPE}'`,
      `appProperties has { key='${ROLE_KEY}' and value='${ROLE_FOLDER}' }`,
      "trashed=false",
    ].join(" and ");
    const { files } = await this.requestJSON<{ files: { id: string }[] }>(
      `${DRIVE_API}/files?${new URLSearchParams({
        q: query,
        fields: "files(id)",
        pageSize: "1",
      })}`,
    );
    if (files.length) {
      return files[0].id;
    }
    const folder = await this.requestJSON<{ id: string }>(
      `${DRIVE_API}/files?fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: FOLDER_MIME_TYPE,
          appProperties: { [ROLE_KEY]: ROLE_FOLDER },
        }),
      },
    );
    return folder.id;
  }

  /** Every drawing the app created or opened, in whichever folder it lives. */
  async listDrawings(): Promise<DriveDrawing[]> {
    const query = [
      `appProperties has { key='${ROLE_KEY}' and value='${ROLE_DRAWING}' }`,
      "trashed=false",
    ].join(" and ");
    const drawings: DriveDrawing[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${DRAWING_FIELDS})`,
        orderBy: "modifiedTime desc",
        pageSize: "100",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const page = await this.requestJSON<{
        files: DriveDrawing[];
        nextPageToken?: string;
      }>(`${DRIVE_API}/files?${params}`);
      drawings.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return drawings;
  }

  async createDrawing(opts: {
    folderId: string;
    name: string;
    content: string;
    thumbnail?: Blob;
  }): Promise<DriveDrawing> {
    const { body, contentType } = multipartBody(
      {
        name: toDriveFileName(opts.name),
        mimeType: MIME_TYPES.excalidraw,
        parents: [opts.folderId],
        appProperties: { [ROLE_KEY]: ROLE_DRAWING },
        ...(await thumbnailHint(opts.thumbnail)),
      },
      opts.content,
    );
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${DRAWING_FIELDS}`,
      { method: "POST", headers: { "Content-Type": contentType }, body },
    );
  }

  getDrawingMetadata(fileId: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
    );
  }

  async downloadDrawing(fileId: string): Promise<string> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    return response.text();
  }

  async updateDrawingContent(
    fileId: string,
    content: string,
    thumbnail?: Blob,
  ): Promise<DriveDrawing> {
    const url = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}`;
    if (!thumbnail) {
      return this.requestJSON<DriveDrawing>(
        `${url}?uploadType=media&fields=${DRAWING_FIELDS}`,
        {
          method: "PATCH",
          headers: { "Content-Type": MIME_TYPES.excalidraw },
          body: content,
        },
      );
    }
    const { body, contentType } = multipartBody(
      (await thumbnailHint(thumbnail))!,
      content,
    );
    return this.requestJSON<DriveDrawing>(
      `${url}?uploadType=multipart&fields=${DRAWING_FIELDS}`,
      { method: "PATCH", headers: { "Content-Type": contentType }, body },
    );
  }

  async setThumbnail(fileId: string, thumbnail: Blob): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await thumbnailHint(thumbnail)),
      },
    );
  }

  /**
   * With the drive.file scope this returns only folders the app made or the
   * user picked in Google's picker, not the whole Drive.
   */
  async listFolders(): Promise<DriveFolderItem[]> {
    const folders: DriveFolderItem[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `mimeType='${FOLDER_MIME_TYPE}' and trashed=false`,
        fields: `nextPageToken,files(${FOLDER_FIELDS})`,
        orderBy: "name",
        pageSize: "100",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const page = await this.requestJSON<{
        files: DriveFolderItem[];
        nextPageToken?: string;
      }>(`${DRIVE_API}/files?${params}`);
      folders.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return folders;
  }

  createFolder(name: string): Promise<DriveFolderItem> {
    return this.requestJSON<DriveFolderItem>(
      `${DRIVE_API}/files?fields=${FOLDER_FIELDS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE }),
      },
    );
  }

  renameDrawing(fileId: string, name: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: toDriveFileName(name) }),
      },
    );
  }

  /** Marks a file the user picked, so it shows in the drawings list. */
  tagAsDrawing(fileId: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties: { [ROLE_KEY]: ROLE_DRAWING } }),
      },
    );
  }

  async trashDrawing(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }
}
