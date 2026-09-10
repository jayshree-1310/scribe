import { useRef, useState } from "react";
import {
  ACCEPTED_AVATAR_TYPES,
  MAX_AVATAR_BYTES,
} from "../../data/account-api";
import { useObjectUrl } from "../../lib/object-url";
import { Avatar } from "../ui/Avatar";
import { AvatarCropper } from "./AvatarCropper";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Lightbox } from "../ui/Lightbox";
import type { User } from "../../types/domain";

/**
 * A picture change the reader has made but not yet saved: a new file to
 * upload, or the removal of the one the account has. `null` means the saved
 * picture stands.
 */
export type PendingAvatar =
  { kind: "file"; file: File } | { kind: "remove" } | null;

interface AvatarFieldProps {
  user: User;
  /** The staged change, owned by the form so it saves with everything else. */
  pending: PendingAvatar;
  onPendingChange: (pending: PendingAvatar) => void;
  /** Set while the form is saving, so the picture cannot be changed mid-save. */
  disabled?: boolean;
}

function readableSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Profile picture: preview, choose, remove.
 *
 * Nothing is uploaded here. A chosen picture is cropped and then held as a
 * `PendingAvatar` for the profile form to save alongside the text fields, so
 * "Save changes" means the whole panel and a picture picked by mistake is
 * undone by leaving without saving — rather than the picture being the one
 * field on the page that committed itself the moment it was touched.
 */
export function AvatarField({
  user,
  pending,
  onPendingChange,
  disabled = false,
}: AvatarFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [cropping, setCropping] = useState<File | null>(null);

  // The staged file has no URL of its own — the pending change carries the
  // file, and the preview URL is made and revoked alongside this component.
  const previewUrl = useObjectUrl(
    pending?.kind === "file" ? pending.file : null,
  );

  const shown =
    pending?.kind === "file"
      ? previewUrl
      : pending?.kind === "remove"
        ? null
        : user.avatarUrl;

  function onPick(file: File | undefined) {
    // Reset the input, or picking the same file twice fires no change event.
    if (inputRef.current) inputRef.current.value = "";
    if (!file || disabled) return;

    setError(null);

    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setError("Use a PNG, JPEG, WebP or GIF image.");
      return;
    }

    if (file.size > MAX_AVATAR_BYTES) {
      setError(
        `That image is too large. Pick one under ${readableSize(MAX_AVATAR_BYTES)}.`,
      );
      return;
    }

    // A GIF redrawn to a canvas keeps only its first frame, so an animated
    // picture is staged whole rather than silently flattened.
    if (file.type === "image/gif") {
      stage(file);
      return;
    }

    setCropping(file);
  }

  function stage(file: File) {
    onPendingChange({ kind: "file", file });
    setCropping(null);
  }

  return (
    <div className="avatar-field">
      {shown ? (
        <button
          type="button"
          className="avatar-field__preview"
          onClick={() => setViewing(true)}
          aria-label="View your profile picture"
        >
          <Avatar user={{ ...user, avatarUrl: shown }} size="xl" />
        </button>
      ) : (
        <Avatar user={{ ...user, avatarUrl: null }} size="xl" />
      )}

      <div className="avatar-field__body">
        <p className="avatar-field__hint">
          A square image works best. PNG, JPEG, WebP or GIF, up to{" "}
          {readableSize(MAX_AVATAR_BYTES)}.
        </p>

        <div className="avatar-field__actions">
          <Button
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            startIcon={<Icon name="upload" size="1em" />}
          >
            {shown ? "Change" : "Upload"}
          </Button>

          {shown ? (
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                onPendingChange({ kind: "remove" });
              }}
              disabled={disabled}
              startIcon={<Icon name="trash" size="1em" />}
            >
              Remove
            </Button>
          ) : null}

          {pending ? (
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                onPendingChange(null);
              }}
              disabled={disabled}
              startIcon={<Icon name="retry" size="1em" />}
            >
              Undo
            </Button>
          ) : null}
        </div>

        {error ? (
          <p className="avatar-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        accept={ACCEPTED_AVATAR_TYPES.join(",")}
        // Labelled by the button that opens it; the input itself is never seen.
        aria-label="Choose a profile picture"
        onChange={(event) => onPick(event.target.files?.[0])}
      />

      {cropping ? (
        <AvatarCropper
          key={`${cropping.name}:${cropping.lastModified}`}
          file={cropping}
          onCancel={() => setCropping(null)}
          onConfirm={stage}
        />
      ) : null}

      {shown ? (
        <Lightbox
          open={viewing}
          onClose={() => setViewing(false)}
          src={shown}
          alt="Your profile picture"
        />
      ) : null}
    </div>
  );
}
