"use client";

import { ImageIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  PROVIDER_INSTANCE_ICON_MAX_DECODED_BYTES,
  resolveProviderInstanceIcon,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const ICON_TOO_LARGE = "Use a PNG or SVG under 32KB.";
const ICON_TYPE = "Use a PNG or SVG file.";
const ICON_URI = "Paste an https URL or a base64 PNG or SVG data URI. Other schemes are ignored.";

function iconMime(bytes: Uint8Array): "image/png" | "image/svg+xml" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readIconFile(file: File): Promise<string> {
  if (file.size > PROVIDER_INSTANCE_ICON_MAX_DECODED_BYTES) {
    throw new Error(ICON_TOO_LARGE);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > PROVIDER_INSTANCE_ICON_MAX_DECODED_BYTES) {
    throw new Error(ICON_TOO_LARGE);
  }
  const mime = iconMime(bytes);
  if (mime === null) throw new Error(ICON_TYPE);
  const icon = resolveProviderInstanceIcon(`data:${mime};base64,${bytesToBase64(bytes)}`);
  if (icon === null) throw new Error(ICON_TOO_LARGE);
  return icon;
}

function IconPreview(props: { readonly icon: string | null }) {
  if (props.icon === null) {
    return (
      <span className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ImageIcon className="size-4" aria-hidden />
      </span>
    );
  }
  return (
    <img
      alt=""
      className="size-10 rounded-md bg-muted object-contain"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      src={props.icon}
    />
  );
}

export function ProviderInstanceIconPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
}) {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resolved = resolveProviderInstanceIcon(props.value);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftValue = draft ?? props.value ?? "";
  const draftIcon = resolveProviderInstanceIcon(draftValue);

  const commit = (value: string) => {
    const icon = resolveProviderInstanceIcon(value);
    if (value.trim().length > 0 && icon === null) {
      setError(ICON_URI);
      return;
    }
    setError(null);
    setDraft(null);
    props.onCommit(icon ?? "");
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`${resolved ? "Change" : "Add"} icon for ${props.displayName}`}
          >
            {resolved ? (
              <img
                alt=""
                className="size-4 object-contain"
                draggable={false}
                referrerPolicy="no-referrer"
                src={resolved}
              />
            ) : (
              <ImageIcon aria-hidden />
            )}
          </Button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        padding="compact"
        width="lg"
        aria-label="Provider icon"
      >
        {/* The shared popup clips overflow and sizes from its first measurement.
            A growing textarea of a data URI pushes Choose and Clear outside
            that box, so this stays a short, fixed stack. */}
        <div className="grid w-full min-w-0 gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <IconPreview icon={draftIcon} />
            <div className="grid min-w-0 gap-0.5">
              <p className="text-sm font-medium text-foreground">Icon</p>
              <p className="text-xs text-pretty text-muted-foreground">
                PNG or SVG. Shown in the picker, sidebar, and threads.
              </p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            id={fileInputId}
            className="sr-only"
            type="file"
            accept="image/png,image/svg+xml,.png,.svg"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void readIconFile(file).then(
                (icon) => {
                  setDraft(icon);
                  setError(null);
                  props.onCommit(icon);
                },
                (cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : ICON_TYPE);
                },
              );
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose image
            </Button>
            {resolved ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                onClick={() => {
                  setDraft(null);
                  setError(null);
                  props.onCommit("");
                }}
              >
                <XIcon aria-hidden />
                Clear icon
              </Button>
            ) : null}
          </div>
          <Input
            nativeInput
            size="sm"
            font="mono"
            value={draftValue}
            spellCheck={false}
            aria-label={`Icon URL for ${props.displayName}`}
            placeholder="https://… or data:image/png;base64,…"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
            onBlur={() => {
              if (draft === null) return;
              commit(draft);
            }}
          />
          {error ? (
            <p role="alert" className="text-xs text-pretty text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
