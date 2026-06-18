import type { ReactNode } from "react";
import clsx from "clsx";

export function Card({
  title,
  subtitle,
  children,
  className,
  right,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm shadow-lg shadow-black/20",
        "flex flex-col min-h-0",
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-slate-800/80">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-200 uppercase">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="flex-1 min-h-0 p-4">{children}</div>
    </div>
  );
}
