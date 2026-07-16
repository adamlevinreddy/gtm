"use client";

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

// Copy-to-clipboard button with a transient confirmation state. `text` may be
// a string or a lazy getter (e.g. "link at current time" reads the player).
export default function CopyButton({
  text,
  label,
  icon,
  title,
  className,
  style,
}: {
  text: string | (() => string);
  label?: string;
  icon?: ReactNode;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const value = typeof text === "function" ? text() : text;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API can fail on http/permissions — fall back to a prompt
      // so the user can still grab the link.
      window.prompt("Copy this link:", value);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className={
        className ??
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
      }
      style={style ?? { borderColor: "#E4DCE3" }}
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : icon}
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
