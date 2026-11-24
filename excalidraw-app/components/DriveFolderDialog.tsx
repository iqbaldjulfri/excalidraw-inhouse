import { useEffect, useState } from "react";
import clsx from "clsx";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { checkIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { useAtomValue } from "../app-jotai";
import { driveStateAtom, driveSync } from "../data/googleDrive/DriveSync";

import "./DriveDialogs.scss";

import type { DriveFolderItem } from "../data/googleDrive/driveApi";

const folderIcon = (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  </svg>
);

type Load =
  | { status: "loading" }
  | { status: "loaded"; folders: DriveFolderItem[] }
  | { status: "error"; message: string };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const DriveFolderDialog = ({
  canPickAnywhere,
  onClose,
}: {
  canPickAnywhere: boolean;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const { saveFolder } = useAtomValue(driveStateAtom);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    driveSync.listFolders().then(
      (folders) => !cancelled && setLoad({ status: "loaded", folders }),
      (error) =>
        !cancelled &&
        setLoad({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = (folder: DriveFolderItem) => {
    driveSync.setSaveFolder(folder);
    onClose();
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) {
      return;
    }
    setCreating(true);
    try {
      choose(await driveSync.createFolder(name));
    } catch (error) {
      setLoad({ status: "error", message: errorMessage(error) });
      setCreating(false);
    }
  };

  return (
    <Dialog
      size="small"
      title={t("googleDrive.folders.title")}
      onCloseRequest={onClose}
      className="drive-dialog drive-folders"
    >
      <p className="drive-dialog__hint">{t("googleDrive.folders.hint")}</p>

      {load.status === "loading" && (
        <p className="drive-dialog__hint">{t("googleDrive.folders.loading")}</p>
      )}
      {load.status === "error" && (
        <p className="drive-dialog__error" role="alert">
          {load.message}
        </p>
      )}
      {load.status === "loaded" && (
        <ul className="drive-folders__list">
          {load.folders.map((folder) => {
            const isSelected = folder.id === saveFolder?.id;
            return (
              <li key={folder.id}>
                <button
                  type="button"
                  className={clsx("drive-folders__item", {
                    "drive-folders__item--selected": isSelected,
                  })}
                  aria-current={isSelected || undefined}
                  onClick={() => choose(folder)}
                >
                  {folderIcon}
                  <span className="drive-folders__name">{folder.name}</span>
                  {isSelected && checkIcon}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="drive-folders__create"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <TextField
          value={newName}
          placeholder={t("googleDrive.folders.newPlaceholder")}
          onChange={setNewName}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
          fullWidth
        />
        <FilledButton
          variant="outlined"
          label={t("googleDrive.folders.create")}
          status={creating ? "loading" : null}
          disabled={!newName.trim()}
          onClick={create}
        />
      </form>

      {canPickAnywhere && (
        <div className="drive-dialog__footer">
          <button
            type="button"
            className="drive-dialog__link"
            onClick={() => {
              onClose();
              driveSync.chooseSaveFolder();
            }}
          >
            {t("googleDrive.folders.pickAnywhere")}
          </button>
        </div>
      )}
    </Dialog>
  );
};
