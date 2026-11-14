import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PromptImage } from "../shared/protocol.ts";

type ImageViewerProps = {
  images: PromptImage[];
  /** The index of the image to show first. */
  start: number;
  /** Called after the viewer closes. */
  onClose: () => void;
};

/** The images of a message at full size, over the page. The arrows move between the images. */
export function ImageViewer({ images, start, onClose }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(start);
  const image = images[index];
  const last = images.length - 1;

  useEffect(() => dialogRef.current?.showModal(), []);

  // The listener is on the document, so it gets the keys also when no element has the focus.
  // It runs before the listener of App on the window, so Esc closes the viewer and does not stop the run.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialogRef.current?.close();
      }
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(current - 1, 0));
      if (event.key === "ArrowRight") setIndex((current) => Math.min(current + 1, last));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [last]);

  // The dialog fills the screen. A click on the dialog itself, not on the image or an arrow, is a click on the backdrop.
  return (
    <dialog
      ref={dialogRef}
      className="image-viewer"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
      {last > 0 && (
        <>
          <button
            className="image-viewer-arrow previous"
            onClick={() => setIndex(index - 1)}
            disabled={index === 0}
            aria-label="Previous image"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            className="image-viewer-arrow next"
            onClick={() => setIndex(index + 1)}
            disabled={index === last}
            aria-label="Next image"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </dialog>
  );
}
