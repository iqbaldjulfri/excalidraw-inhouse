import { useEffect, useState } from "react";
import clsx from "clsx";

import { ImageIcon } from "@excalidraw/excalidraw/components/icons";

import { useAtomValue } from "../app-jotai";
import { sizeThumbnailLink } from "../data/googleDrive/driveApi";
import { driveStateAtom } from "../data/googleDrive/DriveSync";

import type { DriveDrawing } from "../data/googleDrive/driveApi";

const useThumbnailSrc = (drawing: DriveDrawing, longestSide: number) => {
  const { localThumbnails, current } = useAtomValue(driveStateAtom);
  const local = localThumbnails[drawing.id];
  // Drive takes a while to process an upload, so this tab's own render is
  // newer for the open drawing. For the rest, another device may have edited
  // since, and Drive's copy wins.
  if (local && (drawing.id === current?.fileId || !drawing.thumbnailLink)) {
    return local;
  }
  return drawing.thumbnailLink
    ? sizeThumbnailLink(drawing.thumbnailLink, longestSide)
    : null;
};

export const DriveThumbnail = ({
  drawing,
  longestSide,
  className,
}: {
  drawing: DriveDrawing;
  /** Pixels Drive should scale its copy to; ignored for local renders. */
  longestSide: number;
  className?: string;
}) => {
  const src = useThumbnailSrc(drawing, longestSide);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => setFailedSrc(null), [src]);

  return (
    <span className={clsx("drive-thumbnail", className)} aria-hidden="true">
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          // Drive's links expire within hours; a stale one shows the
          // placeholder until the list refreshes
          onError={() => setFailedSrc(src)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="drive-thumbnail__empty">{ImageIcon}</span>
      )}
    </span>
  );
};
