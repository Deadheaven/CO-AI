import { useEffect, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import type { ThreadStatus } from "../types";

export const cn = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

/* ---------- Button ---------- */
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
}
export function Button({ variant = "ghost", size = "md", className, ...rest }: BtnProps) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer select-none items-center justify-center gap-1.5 rounded-lg font-medium transition duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[11px]" : "h-9 px-3.5 text-xs",
        variant === "primary" && "bg-accent text-black hover:brightness-110",
        variant === "ghost" && "text-foreground/75 hover:bg-muted hover:text-foreground",
        variant === "outline" && "border border-border hover:border-foreground/40 hover:bg-muted",
        variant === "danger" && "bg-destructive/12 text-destructive hover:bg-destructive/25",
        className
      )}
      {...rest}
    />
  );
}

/* ---------- Status pill ---------- */
const STATUS_META: Record<ThreadStatus, { label: string; cls: string }> = {
  draft: { label: "draft", cls: "bg-foreground/10 text-foreground/70 border-foreground/15" },
  planning: { label: "planning", cls: "bg-info/10 text-info border-info/30" },
  in_progress: { label: "in progress", cls: "bg-warning/10 text-warning border-warning/30" },
  review: { label: "review", cls: "bg-agent/10 text-agent border-agent/30" },
  shipped: { label: "shipped", cls: "bg-success/10 text-success border-success/30" },
  blocked: { label: "blocked", cls: "bg-destructive/10 text-destructive border-destructive/30" },
};
export function StatusPill({ status }: { status: ThreadStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider",
        m.cls
      )}
    >
      {m.label}
    </span>
  );
}

/* ---------- Avatar ---------- */
interface AvatarProps {
  name: string;
  color: string;
  size?: number;
  online?: boolean;
}
export function Avatar({ name, color, size = 24, online }: AvatarProps) {
  return (
    <span
      className="relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold"
      style={{ width: size, height: size, background: `${color}2e`, color }}
      title={name}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
      {online && (
        <span
          className="pulse-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full text-success"
          style={{ background: "currentColor" }}
          title="online"
        />
      )}
    </span>
  );
}

export function AvatarStack({
  members,
  size = 22,
}: {
  members: Array<{ id: string; name: string; color: string; online?: boolean }>;
  size?: number;
}) {
  return (
    <div className="flex -space-x-2">
      {members.slice(0, 4).map((m) => (
        <Avatar key={m.id} name={m.name} color={m.color} size={size} online={m.online} />
      ))}
    </div>
  );
}

/* ---------- CopyButton ---------- */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setOk(true);
      window.setTimeout(() => setOk(false), 1400);
    } catch {
      setOk(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} aria-label={`Copy ${label ?? text}`}>
      {ok ? <Check size={13} /> : <Copy size={13} />}
      {ok ? "copied" : label}
    </Button>
  );
}

/* ---------- Modal ---------- */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="rise relative w-full max-w-md rounded-2xl border border-border bg-panel p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-sm font-bold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Empty state ---------- */
export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 p-6 text-center">
      <div className="text-foreground/35">{icon}</div>
      <p className="text-xs font-semibold">{title}</p>
      <p className="max-w-[30ch] text-[11px] leading-relaxed text-foreground/55">{hint}</p>
    </div>
  );
}

/* ---------- Field label ---------- */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-wider text-foreground/60">
        {label}
      </label>
      {children}
    </div>
  );
}

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-canvas px-3 text-xs text-foreground placeholder:text-foreground/35 focus:border-foreground/50 focus:outline-none";

export function LiveDot() {
  return <span className="pulse-dot relative inline-flex h-2 w-2 rounded-full bg-success text-success" style={{ background: "currentColor" }} />;
}