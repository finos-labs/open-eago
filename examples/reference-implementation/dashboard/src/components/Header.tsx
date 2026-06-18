export function Header({ connected }: { connected: boolean }) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
      <div>
        <h1 className="text-lg font-bold text-white tracking-tight">
          OpenEAGO <span className="text-indigo-400">Reference Implementation</span>
        </h1>
        <p className="text-xs text-slate-500">Six-phase governance pipeline · live</p>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className={`relative flex h-2.5 w-2.5`}>
          {connected && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
          )}
          <span
            className={`relative inline-flex rounded-full h-2.5 w-2.5 ${connected ? "bg-emerald-400" : "bg-rose-500"}`}
          />
        </span>
        <span className="text-slate-400">{connected ? "live feed connected" : "reconnecting..."}</span>
      </div>
    </header>
  );
}
