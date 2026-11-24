import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { syncInvalidIndices } from "@excalidraw/element";
import { vi } from "vitest";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { SignedOutError } from "../data/session";
import {
  DriveNotGrantedError,
  getDriveAccessToken,
} from "../data/googleDrive/auth";
import { DriveApiError, DriveClient } from "../data/googleDrive/driveApi";
import { DriveSync, driveStateAtom } from "../data/googleDrive/DriveSync";
import {
  mergeDriveScene,
  parseDriveScene,
  serializeDriveScene,
} from "../data/googleDrive/mergeScene";

import type { DriveDrawing } from "../data/googleDrive/driveApi";

// jsdom has no object URLs; thumbnails only need a unique string each
let objectUrlCount = 0;
URL.createObjectURL = vi.fn(() => `blob:thumbnail-${++objectUrlCount}`);
URL.revokeObjectURL = vi.fn();

vi.mock("../data/googleDrive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/googleDrive/auth")>()),
  isGoogleDriveEnabled: () => true,
}));

type ElementSpec = { id: string; version: number; isDeleted: boolean };

const rect = (id: string, version: number, isDeleted = false): ElementSpec => ({
  id,
  version,
  isDeleted,
});

// syncInvalidIndices bumps versions, so pin them after indices are assigned
const scene = (...specs: ElementSpec[]) =>
  syncInvalidIndices(
    specs.map((spec) =>
      API.createElement({
        type: "rectangle",
        id: spec.id,
        isDeleted: spec.isDeleted,
      }),
    ),
  ).map((element, i) => ({
    ...element,
    version: specs[i].version,
    versionNonce: specs[i].version * 1000 + specs[i].id.charCodeAt(0),
    updated: Date.now(),
  })) as OrderedExcalidrawElement[];

const ids = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.map((element) => `${element.id}@${element.version}`).sort();

const drawingMeta = (version: string): DriveDrawing => ({
  id: "file-1",
  name: "Plan.excalidraw",
  modifiedTime: new Date().toISOString(),
  version,
});

const createFakeClient = (remote: { content: string; version: string }) => {
  const client = {
    ensureFolder: vi.fn(async () => "folder-1"),
    listDrawings: vi.fn(async () => [drawingMeta(remote.version)]),
    getDrawingMetadata: vi.fn(async () => drawingMeta(remote.version)),
    downloadDrawing: vi.fn(async () => remote.content),
    updateDrawingContent: vi.fn(
      async (_id: string, content: string, _thumbnail?: Blob) => {
        remote.content = content;
        remote.version = String(Number(remote.version) + 1);
        return drawingMeta(remote.version);
      },
    ),
    createDrawing: vi.fn(
      async (opts: {
        folderId: string;
        name: string;
        content: string;
        thumbnail?: Blob;
      }) => ({
        ...drawingMeta("1"),
        id: `new-in-${opts.folderId}`,
        name: `${opts.name}.excalidraw`,
      }),
    ),
    tagAsDrawing: vi.fn(async () => drawingMeta(remote.version)),
    renameDrawing: vi.fn(),
    trashDrawing: vi.fn(),
    setThumbnail: vi.fn(async (id: string, _thumbnail: Blob) => ({
      ...drawingMeta(remote.version),
      id,
    })),
    listFolders: vi.fn(async () => [{ id: "folder-1", name: "Excalidraw" }]),
    createFolder: vi.fn(async (name: string) => ({ id: "made-1", name })),
  };
  return client;
};

const createFakeApi = (initial: OrderedExcalidrawElement[]) => {
  let elements = initial;
  const files: BinaryFiles = {};
  const appState = { ...getDefaultAppState(), isLoading: false } as AppState;
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getAppState: () => appState,
    getFiles: () => files,
    getName: () => "Untitled",
    updateScene: vi.fn(
      (data: { elements?: readonly OrderedExcalidrawElement[] }) => {
        if (data.elements) {
          elements = [...data.elements];
        }
      },
    ),
    addFiles: vi.fn(),
    setToast: vi.fn(),
    setViewport: vi.fn(),
    resetScene: vi.fn(() => {
      elements = [];
    }),
    history: { clear: vi.fn() },
  };
  return {
    api,
    setElements: (next: OrderedExcalidrawElement[]) => {
      elements = next;
    },
  };
};

const LINK_KEY = "excalidraw-gdrive-link";

const setUpSync = async (opts: {
  local: OrderedExcalidrawElement[];
  remote: OrderedExcalidrawElement[];
  linkedVersion: string;
  remoteVersion: string;
  confirmReplaceCanvas?: () => Promise<boolean>;
  pickers?: {
    pickDrawingFile: () => Promise<{ id: string; name: string } | null>;
    pickFolder: () => Promise<{ id: string; name: string } | null>;
  };
  failConnect?: boolean;
  renderThumbnail?: () => Promise<Blob>;
}) => {
  localStorage.setItem(
    LINK_KEY,
    JSON.stringify({
      fileId: "file-1",
      name: "Plan",
      version: opts.linkedVersion,
    }),
  );
  const remote = {
    content: serializeDriveScene(opts.remote, {}, {}),
    version: opts.remoteVersion,
  };
  const client = createFakeClient(remote);
  if (opts.failConnect) {
    client.ensureFolder.mockRejectedValueOnce(new Error("offline"));
  }
  const fakeApi = createFakeApi(opts.local);
  const sync = new DriveSync({
    client: client as unknown as DriveClient,
    confirmReplaceCanvas: opts.confirmReplaceCanvas,
    pickers: opts.pickers,
    renderThumbnail:
      opts.renderThumbnail ??
      (async () => new Blob(["thumb"], { type: "image/webp" })),
  });
  await sync.init(fakeApi.api as unknown as ExcalidrawImperativeAPI, {
    isExternalScene: false,
  });
  return { sync, client, remote, ...fakeApi };
};

describe("mergeDriveScene", () => {
  it("keeps the newer version of each element and elements only one side has", () => {
    const local = scene(rect("a", 4), rect("b", 2), rect("c", 1));
    const remote = scene(rect("a", 3), rect("b", 5), rect("d", 1));

    const merged = mergeDriveScene(
      { elements: local, files: {} },
      parseDriveScene(serializeDriveScene(remote, {}, {}), null),
      getDefaultAppState() as AppState,
    );

    // c and d share an index, so reconcile re-indexes one and bumps its version
    expect(merged.elements.map((element) => element.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    const versions = new Map(
      merged.elements.map((element) => [element.id, element.version]),
    );
    expect(versions.get("a")).toBe(4);
    expect(versions.get("b")).toBe(5);
  });

  it("applies a newer remote deletion", () => {
    const local = scene(rect("a", 2));
    const remote = scene(rect("a", 3, true));

    const merged = mergeDriveScene(
      { elements: local, files: {} },
      parseDriveScene(serializeDriveScene(remote, {}, {}), null),
      getDefaultAppState() as AppState,
    );

    expect(merged.elements).toHaveLength(1);
    expect(merged.elements[0].isDeleted).toBe(true);
  });

  it("rejects files that aren't Excalidraw drawings", () => {
    expect(() => parseDriveScene("not json", null)).toThrow();
    expect(() =>
      parseDriveScene(JSON.stringify({ type: "x" }), null),
    ).toThrow();
  });
});

describe("DriveSync", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uploads local changes when Drive hasn't changed", async () => {
    const { sync, client, remote } = await setUpSync({
      local: scene(rect("a", 2)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.syncNow();

    expect(client.updateDrawingContent).toHaveBeenCalledTimes(1);
    expect(ids(parseDriveScene(remote.content, null).elements)).toEqual([
      "a@2",
    ]);
    expect(appJotaiStore.get(driveStateAtom).current?.version).toBe("8");
    expect(appJotaiStore.get(driveStateAtom).syncStatus).toBe("synced");
  });

  it("merges remote edits into the canvas before uploading", async () => {
    const { sync, api, remote } = await setUpSync({
      local: scene(rect("a", 4), rect("b", 1)),
      remote: scene(rect("a", 3), rect("b", 6)),
      linkedVersion: "7",
      remoteVersion: "9",
    });

    await sync.syncNow();

    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["a@4", "b@6"]);
    expect(ids(parseDriveScene(remote.content, null).elements)).toEqual([
      "a@4",
      "b@6",
    ]);
  });

  it("skips the upload when nothing changed since the last sync", async () => {
    const { sync, client } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.syncNow();
    await sync.syncNow();

    expect(client.updateDrawingContent).not.toHaveBeenCalled();
  });

  it("stops syncing when the canvas is replaced by an unrelated scene", async () => {
    const { sync, client, api, setElements } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });
    await sync.syncNow();

    setElements(scene(rect("z", 1)));
    await sync.syncNow();

    expect(client.updateDrawingContent).not.toHaveBeenCalled();
    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
    expect(localStorage.getItem(LINK_KEY)).toBeNull();
    expect(api.setToast).toHaveBeenCalled();
  });

  it("keeps the linked drawing when the app session ends", async () => {
    const { sync, client } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });
    client.getDrawingMetadata.mockRejectedValueOnce(new SignedOutError());

    await sync.syncNow();

    expect(appJotaiStore.get(driveStateAtom).connection).toBe("signedOut");
    expect(appJotaiStore.get(driveStateAtom).current?.fileId).toBe("file-1");
  });

  it("leaves no link to this user's Drive after sign-out", async () => {
    const { sync, client } = await setUpSync({
      local: scene(rect("a", 2)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.prepareForSignOut();

    expect(client.updateDrawingContent).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LINK_KEY)).toBeNull();
    expect(appJotaiStore.get(driveStateAtom).drawings).toEqual([]);
  });

  it("connects on startup without any user action", async () => {
    const { client } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    expect(client.ensureFolder).toHaveBeenCalledTimes(1);
    expect(appJotaiStore.get(driveStateAtom).connection).toBe("connected");
  });

  it("explains when Drive access wasn't granted at sign-in", async () => {
    const client = createFakeClient({
      content: serializeDriveScene([], {}, {}),
      version: "1",
    });
    client.ensureFolder.mockRejectedValueOnce(new DriveNotGrantedError());
    const sync = new DriveSync({ client: client as unknown as DriveClient });

    await sync.init(
      createFakeApi([]).api as unknown as ExcalidrawImperativeAPI,
      { isExternalScene: false },
    );

    expect(appJotaiStore.get(driveStateAtom).connection).toBe(
      "driveNotGranted",
    );
  });

  it("doesn't replace an unsaved canvas when the user cancels", async () => {
    const { sync, client, api } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("b", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
      confirmReplaceCanvas: async () => false,
    });
    sync.unlink();

    await sync.openDrawing("file-1");

    expect(client.downloadDrawing).not.toHaveBeenCalled();
    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["a@1"]);
  });

  it("forgets the linked drawing when the app opens an external scene", async () => {
    localStorage.setItem(
      LINK_KEY,
      JSON.stringify({ fileId: "file-1", name: "Plan", version: "1" }),
    );
    const sync = new DriveSync({
      client: createFakeClient({
        content: serializeDriveScene([], {}, {}),
        version: "1",
      }) as unknown as DriveClient,
    });

    await sync.init(
      createFakeApi([]).api as unknown as ExcalidrawImperativeAPI,
      { isExternalScene: true },
    );

    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
  });
});

describe("DriveClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once with a freshly refreshed token when Drive rejects one", async () => {
    const tokens = ["stale", "fresh"];
    const getAccessToken = vi.fn(async () => tokens.shift()!);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("Authorization") === "Bearer fresh"
        ? Response.json(drawingMeta("3"))
        : new Response("{}", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const meta = await new DriveClient(getAccessToken).getDrawingMetadata(
      "file-1",
    );

    expect(meta.version).toBe("3");
    expect(getAccessToken.mock.calls).toEqual([
      [{ forceRefresh: false }],
      [{ forceRefresh: true }],
    ]);
  });
});

describe("getDriveAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("doesn't hand a forced refresh the result of a normal fetch already in flight", async () => {
    let releaseNormal!: () => void;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("refresh=1")) {
        return Response.json({
          accessToken: "fresh",
          expiresAt: Date.now() + 3e6,
        });
      }
      await new Promise<void>((resolve) => {
        releaseNormal = resolve;
      });
      return Response.json({
        accessToken: "stale",
        expiresAt: Date.now() + 1e6,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const normal = getDriveAccessToken();
    const forced = getDriveAccessToken({ forceRefresh: true });
    expect(await forced).toBe("fresh");
    releaseNormal();
    await normal;

    // the slower normal fetch must not replace the newer cached token
    expect(await getDriveAccessToken()).toBe("fresh");
  });
});

describe("DriveSync picker and save folder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const base = {
    local: scene(rect("a", 1)),
    remote: scene(rect("b", 1)),
    linkedVersion: "7",
    remoteVersion: "7",
  };

  it("saves new drawings to the default Excalidraw folder until another is chosen", async () => {
    const { sync, client } = await setUpSync({
      ...base,
      pickers: {
        pickDrawingFile: async () => null,
        pickFolder: async () => ({ id: "team-folder", name: "Team" }),
      },
    });
    expect(appJotaiStore.get(driveStateAtom).saveFolder).toEqual({
      id: "folder-1",
      name: "Excalidraw",
    });

    await sync.chooseSaveFolder();
    await sync.createDrawing({ fromCanvas: true });

    expect(client.createDrawing.mock.calls[0][0].folderId).toBe("team-folder");
    expect(
      JSON.parse(localStorage.getItem("excalidraw-gdrive-save-folder")!),
    ).toEqual({ id: "team-folder", name: "Team" });
  });

  it("falls back to the default folder when the chosen one is gone", async () => {
    localStorage.setItem(
      "excalidraw-gdrive-save-folder",
      JSON.stringify({ id: "deleted", name: "Old" }),
    );
    const { sync, client } = await setUpSync(base);
    client.createDrawing.mockRejectedValueOnce(
      new DriveApiError("File not found", 404),
    );

    await sync.createDrawing({ fromCanvas: true });

    expect(
      client.createDrawing.mock.calls.map(([opts]) => opts.folderId),
    ).toEqual(["deleted", "folder-1"]);
    expect(appJotaiStore.get(driveStateAtom).saveFolder?.id).toBe("folder-1");
  });

  it("opens a picked file and adds it to the drawings list", async () => {
    const { sync, client, api } = await setUpSync({
      ...base,
      confirmReplaceCanvas: async () => true,
      pickers: {
        pickDrawingFile: async () => ({
          id: "file-1",
          name: "Plan.excalidraw",
        }),
        pickFolder: async () => null,
      },
    });
    sync.unlink();

    await sync.openFromDrive();

    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["b@1"]);
    expect(client.tagAsDrawing).toHaveBeenCalledWith("file-1");
    expect(appJotaiStore.get(driveStateAtom).current?.fileId).toBe("file-1");
  });

  it("doesn't tag a picked file it couldn't open", async () => {
    const { sync, client } = await setUpSync({
      ...base,
      confirmReplaceCanvas: async () => true,
      pickers: {
        pickDrawingFile: async () => ({ id: "file-1", name: "notes.txt" }),
        pickFolder: async () => null,
      },
    });
    sync.unlink();
    client.downloadDrawing.mockResolvedValueOnce("just some text");

    await sync.openFromDrive();

    expect(client.tagAsDrawing).not.toHaveBeenCalled();
    expect(appJotaiStore.get(driveStateAtom).error).toBeTruthy();
  });

  it("forgets the chosen save folder on sign-out", async () => {
    localStorage.setItem(
      "excalidraw-gdrive-save-folder",
      JSON.stringify({ id: "team-folder", name: "Team" }),
    );
    const { sync } = await setUpSync(base);

    await sync.prepareForSignOut();

    expect(localStorage.getItem("excalidraw-gdrive-save-folder")).toBeNull();
  });
});

describe("DriveSync cold-review fixes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops a sync that started before another drawing was opened", async () => {
    const { sync, client, api } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("b", 1)),
      linkedVersion: "7",
      remoteVersion: "9",
      confirmReplaceCanvas: async () => true,
    });
    let release!: () => void;
    client.getDrawingMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(drawingMeta("9"));
        }),
    );

    const staleSync = sync.syncNow();
    await Promise.resolve();
    sync.unlink();
    await sync.openDrawing("file-2");
    release();
    await staleSync;

    // without the guard, the old sync merges "a" into the drawing just opened
    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["b@1"]);
    expect(appJotaiStore.get(driveStateAtom).current?.fileId).toBe("file-2");
  });

  it("clears the canvas on sign-out once it's saved to Drive", async () => {
    const { sync, api } = await setUpSync({
      local: scene(rect("a", 2)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.prepareForSignOut();

    expect(api.resetScene).toHaveBeenCalledTimes(1);
  });

  it("keeps an unlinked canvas on sign-out, as it may be the only copy", async () => {
    const { sync, api } = await setUpSync({
      local: scene(rect("a", 2)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });
    sync.unlink();

    await sync.prepareForSignOut();

    expect(api.resetScene).not.toHaveBeenCalled();
  });

  it("refuses to link a drawing the user can only view", async () => {
    const { sync, client, api } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("b", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
      confirmReplaceCanvas: async () => true,
    });
    sync.unlink();
    client.getDrawingMetadata.mockResolvedValueOnce({
      ...drawingMeta("7"),
      capabilities: { canEdit: false },
    });

    await sync.openDrawing("file-1");

    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
    expect(appJotaiStore.get(driveStateAtom).error).toContain("only view");
    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["a@1"]);
  });

  it("notices a file opened from disk before the first sync after reload", async () => {
    const { sync, client, setElements } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
      failConnect: true,
    });
    sync.onSceneChange(scene(rect("a", 1)));

    setElements(scene(rect("z", 1)));
    await sync.connect();

    expect(client.updateDrawingContent).not.toHaveBeenCalled();
    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
  });
});

describe("DriveSync drawing names", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const base = {
    local: scene(rect("a", 1)),
    remote: scene(rect("a", 1)),
    linkedVersion: "7",
    remoteVersion: "7",
  };

  it("names a new drawing Untitled, not after the drawing that was open", async () => {
    const { sync, client, api } = await setUpSync(base);
    // resetScene's state update lands after it returns, so getName still
    // reports the previous drawing; this is what produced "Plan (2)"
    api.getName = () => "Plan";

    await sync.createDrawing({ fromCanvas: false });

    expect(client.createDrawing.mock.calls[0][0].name).toBe("Untitled drawing");
    expect(appJotaiStore.get(driveStateAtom).current?.name).toBe(
      "Untitled drawing",
    );
  });

  it("numbers untitled drawings when the name is taken", async () => {
    const { sync, client } = await setUpSync(base);
    client.listDrawings.mockResolvedValueOnce([
      { ...drawingMeta("1"), id: "u1", name: "Untitled drawing.excalidraw" },
      { ...drawingMeta("1"), id: "u2", name: "Untitled drawing 2.excalidraw" },
    ]);
    await sync.refreshDrawings();

    await sync.createDrawing({ fromCanvas: true });

    expect(client.createDrawing.mock.calls[0][0].name).toBe(
      "Untitled drawing 3",
    );
  });

  it("keeps a typed name as typed, even if another drawing has it", async () => {
    const { sync, client } = await setUpSync(base);

    await sync.createDrawing({ fromCanvas: true, name: "  Plan  " });

    expect(client.createDrawing.mock.calls[0][0].name).toBe("Plan");
  });

  it("picks up a rename made in Drive on the next sync", async () => {
    const { sync, client, api } = await setUpSync(base);
    client.getDrawingMetadata.mockResolvedValueOnce({
      ...drawingMeta("7"),
      name: "Roadmap.excalidraw",
    });

    await sync.syncNow();

    expect(appJotaiStore.get(driveStateAtom).current?.name).toBe("Roadmap");
    expect(api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({ appState: { name: "Roadmap" } }),
    );
  });
});

describe("DriveSync thumbnails", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = {
    local: scene(rect("a", 1)),
    remote: scene(rect("a", 1)),
    linkedVersion: "7",
    remoteVersion: "7",
  };

  const thumbnailArgs = (client: ReturnType<typeof createFakeClient>) =>
    client.updateDrawingContent.mock.calls.map(([, , thumbnail]) =>
      thumbnail ? "thumbnail" : "none",
    );

  it("sends a thumbnail with an upload at most every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sync, client, setElements } = await setUpSync(base);

    setElements(scene(rect("a", 2)));
    await sync.syncNow();
    vi.setSystemTime(Date.now() + 10_000);
    setElements(scene(rect("a", 3)));
    await sync.syncNow();
    vi.setSystemTime(Date.now() + 25_000);
    setElements(scene(rect("a", 4)));
    await sync.syncNow();

    expect(thumbnailArgs(client)).toEqual(["thumbnail", "none", "thumbnail"]);
    expect(appJotaiStore.get(driveStateAtom).localThumbnails["file-1"]).toMatch(
      /^blob:/,
    );
  });

  it("sends a skipped thumbnail before another drawing replaces the canvas", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sync, client, setElements } = await setUpSync(base);
    setElements(scene(rect("a", 2)));
    await sync.syncNow();
    setElements(scene(rect("a", 3)));
    await sync.syncNow();
    expect(client.setThumbnail).not.toHaveBeenCalled();

    client.getDrawingMetadata.mockResolvedValueOnce(drawingMeta("8"));
    client.getDrawingMetadata.mockResolvedValueOnce(drawingMeta("8"));
    client.getDrawingMetadata.mockResolvedValueOnce({
      ...drawingMeta("1"),
      id: "file-2",
      thumbnailLink: "https://lh3.example/x=s220",
    });
    await sync.openDrawing("file-2");

    expect(client.setThumbnail).toHaveBeenCalledTimes(1);
    expect(client.setThumbnail.mock.calls[0][0]).toBe("file-1");
    expect(appJotaiStore.get(driveStateAtom).current?.fileId).toBe("file-2");
  });

  it("still saves when the thumbnail can't be rendered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sync, client, setElements } = await setUpSync({
      ...base,
      renderThumbnail: async () => {
        throw new Error("no canvas");
      },
    });

    setElements(scene(rect("a", 2)));
    await sync.syncNow();

    expect(thumbnailArgs(client)).toEqual(["none"]);
    expect(appJotaiStore.get(driveStateAtom).syncStatus).toBe("synced");
    // stops the retry timer so it can't fire into the next test
    sync.unlink();
    warn.mockRestore();
  });

  it("gives an opened drawing a thumbnail when Drive has none", async () => {
    const { sync, client } = await setUpSync({
      ...base,
      confirmReplaceCanvas: async () => true,
    });
    sync.unlink();

    await sync.openDrawing("file-1");
    await vi.waitFor(() => expect(client.setThumbnail).toHaveBeenCalled());

    expect(client.setThumbnail.mock.calls[0][0]).toBe("file-1");
  });

  it("sends the thumbnail with a drawing saved from the canvas", async () => {
    const { sync, client } = await setUpSync(base);

    await sync.createDrawing({ fromCanvas: true, name: "Sketch" });

    expect(client.createDrawing.mock.calls[0][0].thumbnail).toBeInstanceOf(
      Blob,
    );
  });
});
