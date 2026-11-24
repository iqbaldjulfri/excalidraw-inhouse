import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

import DropdownMenu from "@excalidraw/excalidraw/components/dropdownMenu/DropdownMenu";
import {
  PlusIcon,
  TrashIcon,
  chevronDownIcon,
  gridIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { useAtomValue } from "../app-jotai";
import { currentUserAtom, signInUrl, signOut } from "../data/session";
import { toDrawingName } from "../data/googleDrive/driveApi";
import { driveStateAtom, driveSync } from "../data/googleDrive/DriveSync";

import { DriveDrawingsDialog } from "./DriveDrawingsDialog";
import { DriveFolderDialog } from "./DriveFolderDialog";
import { DriveThumbnail } from "./DriveThumbnail";
import { formatRelativeTime, useNow } from "./driveTime";

import "./DriveTitle.scss";

import type { DriveState } from "../data/googleDrive/DriveSync";

const RECENT_LIMIT = 8;
const RECENT_THUMBNAIL_PX = 160;

const cloudIcon = (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878" />
  </svg>
);

type DotStatus = "idle" | "syncing" | "synced" | "error";

const getDotStatus = (state: DriveState): DotStatus => {
  if (state.connection !== "connected") {
    return state.connection === "connecting" ? "idle" : "error";
  }
  if (!state.current) {
    return "idle";
  }
  return state.syncStatus === "synced" ? "synced" : state.syncStatus;
};

const useStatusText = (state: DriveState) => {
  const { t, langCode } = useI18n();
  const now = useNow(30 * 1000);

  if (state.connection === "connecting") {
    return { short: "", long: t("googleDrive.connecting") };
  }
  if (state.connection !== "connected") {
    return {
      short: t("googleDrive.status.short.disconnected"),
      long:
        state.connection === "signedOut"
          ? t("googleDrive.signedOut")
          : state.connection === "driveNotGranted"
          ? t("googleDrive.driveNotGranted")
          : state.error || t("googleDrive.errors.connectFailed"),
    };
  }
  if (!state.current) {
    return {
      short: t("googleDrive.notInDrive"),
      long: t("googleDrive.notInDriveHint"),
    };
  }
  if (state.syncStatus === "syncing") {
    return {
      short: t("googleDrive.status.short.syncing"),
      long: t("googleDrive.status.syncing"),
    };
  }
  if (state.syncStatus === "error") {
    return {
      short: t("googleDrive.status.short.error"),
      long: state.error || t("googleDrive.status.error"),
    };
  }
  if (state.lastSyncedAt) {
    return {
      short: t("googleDrive.status.short.synced"),
      long: t("googleDrive.status.synced", {
        time: formatRelativeTime(state.lastSyncedAt, now, langCode),
      }),
    };
  }
  return {
    short: t("googleDrive.status.short.waiting"),
    long: t("googleDrive.status.waiting"),
  };
};

/** Keeps the browser tab named after the open drawing. */
const useDocumentTitle = (name: string | null) => {
  const { t } = useI18n();
  const originalTitle = useRef(document.title);
  useEffect(() => {
    const original = originalTitle.current;
    document.title = name ? t("googleDrive.documentTitle", { name }) : original;
    return () => {
      document.title = original;
    };
  }, [name, t]);
};

type Editing = { mode: "rename" | "save"; value: string };

const NameField = ({
  editing,
  onCommit,
  onCancel,
}: {
  editing: Editing;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) => {
  const { t } = useI18n();
  const [value, setValue] = useState(editing.value);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Enter and blur both commit; whichever runs first wins
  const settle = (commit: boolean) => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    if (commit) {
      onCommit(value);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className="drive-title__input"
      value={value}
      placeholder={t("googleDrive.untitled")}
      aria-label={t("googleDrive.nameField")}
      spellCheck={false}
      autoComplete="off"
      size={Math.max(12, Math.min(value.length + 1, 40))}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        // keep canvas shortcuts from firing while typing a name
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          settle(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          settle(false);
        }
      }}
    />
  );
};

export const DriveTitle = ({ isMobile }: { isMobile: boolean }) => {
  const { t, langCode } = useI18n();
  const state = useAtomValue(driveStateAtom);
  const user = useAtomValue(currentUserAtom);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dialog, setDialog] = useState<"drawings" | "folders" | null>(null);
  const status = useStatusText(state);
  const now = useNow(60 * 1000);

  const current = state.current;
  useDocumentTitle(current?.name ?? null);

  if (state.connection === "disabled") {
    return null;
  }

  const isConnected = state.connection === "connected";
  const hasPicker = !!user?.picker;

  const startRename = () => {
    if (current) {
      setEditing({ mode: "rename", value: current.name });
    }
  };
  const startSave = () =>
    setEditing({ mode: "save", value: t("googleDrive.untitled") });

  const commitName = (value: string) => {
    const edit = editing;
    setEditing(null);
    if (!edit) {
      return;
    }
    const name = value.trim();
    if (edit.mode === "save") {
      driveSync.createDrawing({ fromCanvas: true, name });
    } else if (current && name && name !== current.name) {
      driveSync.renameDrawing(current.fileId, name);
    }
  };

  const newDrawing = async () => {
    await driveSync.createDrawing({ fromCanvas: false });
    const created = driveSync.getState().current;
    if (created) {
      setEditing({ mode: "rename", value: created.name });
    }
  };

  const select = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const recent = state.drawings.slice(0, RECENT_LIMIT);

  return (
    <div
      className={clsx("drive-title", { "drive-title--mobile": isMobile })}
      data-testid="drive-title"
    >
      <span
        className="drive-title__dot"
        data-status={getDotStatus(state)}
        title={status.long}
        role="img"
        aria-label={status.long}
      />
      {editing ? (
        <NameField
          editing={editing}
          onCommit={commitName}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className={clsx("drive-title__name", {
            "drive-title__name--empty": !current,
          })}
          title={current ? t("googleDrive.renameHint") : status.long}
          disabled={!isConnected || state.busy}
          onClick={current ? startRename : startSave}
        >
          {current?.name ?? t("googleDrive.notInDrive")}
        </button>
      )}
      {!editing && current && !isMobile && status.short && (
        <span className="drive-title__status" title={status.long}>
          {status.short}
        </span>
      )}
      <DropdownMenu open={menuOpen}>
        <DropdownMenu.Trigger
          className="drive-title__menu-button"
          onToggle={() => setMenuOpen(!menuOpen)}
          title={t("googleDrive.menu")}
          aria-label={t("googleDrive.menu")}
        >
          {chevronDownIcon}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="drive-title__menu"
          align="start"
          onClickOutside={() => setMenuOpen(false)}
        >
          <DropdownMenu.ItemCustom className="drive-title__menu-head">
            <strong>{current?.name ?? t("googleDrive.notInDrive")}</strong>
            <span
              className={clsx({
                "drive-title__menu-error": getDotStatus(state) === "error",
              })}
            >
              {status.long}
            </span>
          </DropdownMenu.ItemCustom>

          {!isConnected && state.connection !== "connecting" && (
            <DropdownMenu.Item
              onSelect={select(() =>
                state.connection === "error"
                  ? driveSync.connect()
                  : window.location.assign(signInUrl()),
              )}
            >
              {state.connection === "error"
                ? t("googleDrive.actions.retry")
                : t("googleDrive.actions.signInAgain")}
            </DropdownMenu.Item>
          )}

          {isConnected && (
            <>
              {current ? (
                <DropdownMenu.Item
                  icon={pencilIcon}
                  disabled={state.busy}
                  onSelect={select(startRename)}
                >
                  {t("googleDrive.actions.rename")}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  icon={cloudIcon}
                  disabled={state.busy}
                  onSelect={select(startSave)}
                >
                  {t("googleDrive.actions.saveToDrive")}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                icon={PlusIcon}
                disabled={state.busy}
                onSelect={select(newDrawing)}
              >
                {t("googleDrive.actions.newDrawing")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={gridIcon}
                onSelect={select(() => setDialog("drawings"))}
              >
                {t("googleDrive.actions.allDrawings")}
              </DropdownMenu.Item>

              <DropdownMenu.Separator />
              <DropdownMenu.Group title={t("googleDrive.recent")}>
                {recent.length ? (
                  recent.map((drawing) => {
                    const isCurrent = drawing.id === current?.fileId;
                    return (
                      <DropdownMenu.Item
                        key={drawing.id}
                        selected={isCurrent}
                        disabled={state.busy}
                        aria-current={isCurrent || undefined}
                        shortcut={formatRelativeTime(
                          new Date(drawing.modifiedTime).getTime(),
                          now,
                          langCode,
                        )}
                        onSelect={select(() => {
                          if (!isCurrent) {
                            driveSync.openDrawing(drawing.id);
                          }
                        })}
                      >
                        <span className="drive-title__recent">
                          <DriveThumbnail
                            drawing={drawing}
                            longestSide={RECENT_THUMBNAIL_PX}
                            className="drive-title__recent-thumbnail"
                          />
                          <span className="drive-title__recent-name">
                            {toDrawingName(drawing.name)}
                          </span>
                        </span>
                      </DropdownMenu.Item>
                    );
                  })
                ) : (
                  <DropdownMenu.ItemCustom className="drive-title__menu-note">
                    {t("googleDrive.list.empty")}
                  </DropdownMenu.ItemCustom>
                )}
              </DropdownMenu.Group>

              {current && (
                <>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    disabled={state.busy}
                    onSelect={select(() => driveSync.unlink())}
                  >
                    {t("googleDrive.actions.stopSyncing")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    icon={TrashIcon}
                    disabled={state.busy}
                    onSelect={select(() =>
                      driveSync.trashDrawing(current.fileId),
                    )}
                  >
                    {t("googleDrive.actions.trash")}
                  </DropdownMenu.Item>
                </>
              )}

              {state.saveFolder && (
                <DropdownMenu.ItemCustom className="drive-title__menu-note drive-title__menu-row">
                  <span title={state.saveFolder.name}>
                    {t("googleDrive.saveFolder", {
                      name: state.saveFolder.name,
                    })}
                  </span>
                  <button
                    type="button"
                    className="drive-title__link"
                    onClick={select(() => setDialog("folders"))}
                  >
                    {t("googleDrive.actions.changeFolder")}
                  </button>
                </DropdownMenu.ItemCustom>
              )}
            </>
          )}

          <DropdownMenu.Separator />
          <DropdownMenu.ItemCustom className="drive-title__menu-note drive-title__menu-row">
            {user && (
              <span title={user.email}>
                {t("googleDrive.signedInAs", { email: user.email })}
              </span>
            )}
            <button
              type="button"
              className="drive-title__link"
              onClick={select(async () => {
                await driveSync.prepareForSignOut();
                await signOut();
              })}
            >
              {t("googleDrive.actions.signOut")}
            </button>
          </DropdownMenu.ItemCustom>
        </DropdownMenu.Content>
      </DropdownMenu>
      {dialog === "drawings" && (
        <DriveDrawingsDialog
          canImport={hasPicker}
          onClose={() => setDialog(null)}
          onNewDrawing={newDrawing}
        />
      )}
      {dialog === "folders" && (
        <DriveFolderDialog
          canPickAnywhere={hasPicker}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
