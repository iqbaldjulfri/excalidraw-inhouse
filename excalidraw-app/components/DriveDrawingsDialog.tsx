import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  LoadIcon,
  PlusIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { useAtomValue } from "../app-jotai";
import { toDrawingName } from "../data/googleDrive/driveApi";
import { driveStateAtom, driveSync } from "../data/googleDrive/DriveSync";

import { DriveThumbnail } from "./DriveThumbnail";
import { formatRelativeTime, useNow } from "./driveTime";

import "./DriveDialogs.scss";

const CARD_THUMBNAIL_PX = 480;

export const DriveDrawingsDialog = ({
  canImport,
  onClose,
  onNewDrawing,
}: {
  canImport: boolean;
  onClose: () => void;
  onNewDrawing: () => void;
}) => {
  const { t, langCode } = useI18n();
  const { drawings, current, busy } = useAtomValue(driveStateAtom);
  const [query, setQuery] = useState("");
  const now = useNow(60 * 1000);

  useEffect(() => {
    // thumbnail links expire within hours, and other devices may have added
    // drawings since the list was loaded
    driveSync.refreshDrawings();
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? drawings.filter((drawing) =>
          toDrawingName(drawing.name).toLocaleLowerCase().includes(needle),
        )
      : drawings;
  }, [drawings, query]);

  const open = (fileId: string) => {
    onClose();
    if (fileId !== current?.fileId) {
      driveSync.openDrawing(fileId);
    }
  };

  return (
    <Dialog
      size="wide"
      title={t("googleDrive.browser.title")}
      onCloseRequest={onClose}
      className="drive-dialog drive-drawings"
    >
      <div className="drive-drawings__search">
        <TextField
          type="search"
          icon={searchIcon}
          placeholder={t("googleDrive.browser.search")}
          value={query}
          onChange={setQuery}
          // canvas shortcuts would otherwise fire while typing
          onKeyDown={(event) => event.stopPropagation()}
          fullWidth
        />
      </div>

      {visible.length ? (
        <ul className="drive-drawings__grid">
          {visible.map((drawing) => {
            const isCurrent = drawing.id === current?.fileId;
            const name = toDrawingName(drawing.name);
            return (
              <li key={drawing.id}>
                <button
                  type="button"
                  className={clsx("drive-drawings__card", {
                    "drive-drawings__card--current": isCurrent,
                  })}
                  disabled={busy}
                  aria-current={isCurrent || undefined}
                  title={name}
                  onClick={() => open(drawing.id)}
                >
                  <DriveThumbnail
                    drawing={drawing}
                    longestSide={CARD_THUMBNAIL_PX}
                    className="drive-drawings__thumbnail"
                  />
                  <span className="drive-drawings__name">{name}</span>
                  <span className="drive-drawings__time">
                    {isCurrent
                      ? t("googleDrive.browser.openNow")
                      : formatRelativeTime(
                          new Date(drawing.modifiedTime).getTime(),
                          now,
                          langCode,
                        )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="drive-drawings__empty">
          {drawings.length
            ? t("googleDrive.browser.noMatches", { query: query.trim() })
            : t("googleDrive.list.empty")}
        </p>
      )}

      <div className="drive-dialog__footer">
        <FilledButton
          variant="outlined"
          icon={PlusIcon}
          label={t("googleDrive.actions.newDrawing")}
          disabled={busy}
          onClick={() => {
            onClose();
            onNewDrawing();
          }}
        />
        {canImport && (
          <button
            type="button"
            className="drive-dialog__link"
            disabled={busy}
            onClick={() => {
              onClose();
              driveSync.openFromDrive();
            }}
          >
            {LoadIcon}
            {t("googleDrive.actions.importFromDrive")}
          </button>
        )}
      </div>
    </Dialog>
  );
};
