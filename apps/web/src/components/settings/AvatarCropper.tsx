import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useObjectUrl } from "../../lib/object-url";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";

/** Side of the square the cropped picture is written at. Larger than the
 * biggest place the avatar is shown, so it still holds up on dense screens. */
const OUTPUT_SIZE = 512;

/** How far past "just covering the frame" the picture can be pushed. */
const MAX_ZOOM = 4;

interface AvatarCropperProps {
  /** The picture being cropped; the dialog is mounted only when there is one. */
  file: File;
  onCancel: () => void;
  /** Called with the square crop, as a file ready to upload. */
  onConfirm: (cropped: File) => void;
}

interface Offset {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Square-crops a chosen picture before it is uploaded.
 *
 * The frame is fixed and the picture moves behind it — drag to pan, the slider
 * or the wheel to zoom — which keeps the result square by construction rather
 * than by asking the reader to draw an accurate box. The picture is always at
 * least as large as the frame, so no crop can contain empty space.
 *
 * The geometry lives in two numbers: `zoom`, a multiple of the scale at which
 * the picture exactly covers the frame, and `offset`, the top-left corner of
 * the scaled picture relative to the frame. The same two numbers drive the
 * preview transform and the canvas draw, so what is framed is what is saved.
 */
export function AvatarCropper({
  file,
  onCancel,
  onConfirm,
}: AvatarCropperProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const frameSizeRef = useRef(0);

  const src = useObjectUrl(file);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [frame, setFrame] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);

  // The frame is sized in CSS, so its pixel size has to be measured — and
  // re-measured, since it shrinks with the viewport on narrow screens.
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;

    // Re-framing keeps the same part of the picture framed: the offsets are
    // scaled with the frame rather than reset.
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      const previous = frameSizeRef.current;
      frameSizeRef.current = next;
      setFrame(next);
      if (previous && next && previous !== next) {
        const ratio = next / previous;
        setOffset((current) => ({
          x: current.x * ratio,
          y: current.y * ratio,
        }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src]);

  // Scale at which the picture exactly covers the frame; every other size is
  // a multiple of it.
  const cover =
    natural && frame
      ? Math.max(frame / natural.width, frame / natural.height)
      : 0;
  const scale = cover * zoom;
  const scaled = natural
    ? { width: natural.width * scale, height: natural.height * scale }
    : null;

  /** Keeps the frame covered: the picture can never be pulled off its edges. */
  function clampOffset(next: Offset, forZoom = zoom): Offset {
    if (!natural || !frame) return next;
    const width = natural.width * cover * forZoom;
    const height = natural.height * cover * forZoom;
    return {
      x: clamp(next.x, frame - width, 0),
      y: clamp(next.y, frame - height, 0),
    };
  }

  function onImageLoad() {
    const image = imageRef.current;
    if (!image) return;
    setNatural({ width: image.naturalWidth, height: image.naturalHeight });

    // Start centred, which is where a portrait's subject usually is.
    // offsetWidth, not a bounding rect: the dialog may still be mid-animation,
    // and a transformed rect would report a frame narrower than the layout's.
    const size = frameRef.current?.offsetWidth ?? 0;
    frameSizeRef.current = size;
    const start = Math.max(
      size / image.naturalWidth,
      size / image.naturalHeight,
    );
    setFrame(size);
    setZoom(1);
    setOffset({
      x: (size - image.naturalWidth * start) / 2,
      y: (size - image.naturalHeight * start) / 2,
    });
  }

  /** Zooms about the frame's centre, so the framed subject stays framed. */
  function zoomTo(next: number) {
    const target = clamp(next, 1, MAX_ZOOM);
    if (!natural || !frame || target === zoom) return;

    const ratio = target / zoom;
    const centred = {
      x: frame / 2 - (frame / 2 - offset.x) * ratio,
      y: frame / 2 - (frame / 2 - offset.y) * ratio,
    };
    setZoom(target);
    setOffset(clampOffset(centred, target));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!natural) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    setOffset((current) =>
      clampOffset({ x: current.x + dx, y: current.y + dy }),
    );
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!natural) return;
    zoomTo(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 20 : 6;
    const nudge: Record<string, Offset> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };

    const move = nudge[event.key];
    if (move) {
      event.preventDefault();
      setOffset((current) =>
        clampOffset({ x: current.x + move.x, y: current.y + move.y }),
      );
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(zoom + 0.2);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomTo(zoom - 0.2);
    }
  }

  async function onSave() {
    const image = imageRef.current;
    if (!image || !natural || !frame) return;

    setError(null);

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("We couldn't prepare that crop. Try a different picture.");
      return;
    }

    // The frame in the picture's own pixels — the inverse of the transform the
    // preview applies.
    const source = {
      x: -offset.x / scale,
      y: -offset.y / scale,
      size: frame / scale,
    };

    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      source.x,
      source.y,
      source.size,
      source.size,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE,
    );

    // PNG for pictures that may carry transparency, JPEG otherwise: a photo
    // re-encoded as PNG is several times the size for no visible gain.
    const transparent = file.type === "image/png" || file.type === "image/webp";
    const type = transparent ? "image/png" : "image/jpeg";

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, 0.92),
    );

    if (!blob) {
      setError("We couldn't prepare that crop. Try a different picture.");
      return;
    }

    const name = file.name.replace(/\.[^.]+$/, "") || "avatar";
    onConfirm(
      new File([blob], `${name}.${transparent ? "png" : "jpg"}`, { type }),
    );
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Crop your picture"
      description="Drag to reposition, and zoom to fill the circle."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void onSave()}
            disabled={!natural}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="cropper">
        <div
          ref={frameRef}
          className="cropper__frame"
          role="application"
          aria-label="Position your picture inside the circle. Arrow keys move it, plus and minus zoom."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          data-ready={natural ? "" : undefined}
        >
          {src ? (
            <img
              ref={imageRef}
              className="cropper__image"
              src={src}
              alt=""
              draggable={false}
              onLoad={onImageLoad}
              onError={() => setError("We couldn't read that image.")}
              style={
                scaled
                  ? {
                      width: `${scaled.width}px`,
                      height: `${scaled.height}px`,
                      transform: `translate(${offset.x}px, ${offset.y}px)`,
                    }
                  : undefined
              }
            />
          ) : null}
          <span className="cropper__mask" aria-hidden="true" />
        </div>

        <div className="cropper__zoom">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Zoom out"
            disabled={zoom <= 1}
            onClick={() => zoomTo(zoom - 0.2)}
            startIcon={<Icon name="minus" size="1em" />}
          />
          <input
            type="range"
            className="cropper__slider"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!natural}
            aria-label="Zoom"
            onChange={(event) => zoomTo(Number(event.target.value))}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom + 0.2)}
            startIcon={<Icon name="plus" size="1em" />}
          />
        </div>

        {error ? (
          <p className="avatar-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
