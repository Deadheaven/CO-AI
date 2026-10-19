import { useEffect, useState } from "react";
import Home from "./components/Home";
import ThreadRoom from "./components/Thread";
import { initStore, useStore } from "./store";

type View = { name: "home" } | { name: "thread"; id: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const [startup, setStartup] = useState<"loading" | "ready" | "unavailable">("loading");
  const kickstartVotes = useStore((s) => s.kickstartVotes);

  useEffect(() => {
    let cancelled = false;
    initStore().then((mode) => {
      if (cancelled) return;
      console.info(`[co-ai] data layer: ${mode}`);
      setStartup(mode === "unavailable" ? "unavailable" : "ready");
    }).catch((error: unknown) => {
      console.error("[co-ai] startup failed", error);
      if (!cancelled) setStartup("unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view.name === "thread") kickstartVotes(view.id);
  }, [view, kickstartVotes]);

  if (startup !== "ready") {
    return <main className="flex min-h-screen items-center justify-center bg-canvas px-6 text-center">
      <div className="max-w-md rounded-2xl border border-border bg-panel p-6">
        <h1 className="font-heading text-xl font-bold">{startup === "loading" ? "Connecting to CO-AI…" : "CO-AI is temporarily unavailable"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-foreground/60">
          {startup === "loading" ? "Loading the shared workspace and checking the live agent." : "The live workspace could not be reached. Reload in a moment; this public demo does not switch to a simulated workspace."}
        </p>
        {startup === "unavailable" && <button className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white" onClick={() => window.location.reload()}>Reload</button>}
      </div>
    </main>;
  }

  return view.name === "home" ? (
    <Home onOpen={(id) => setView({ name: "thread", id })} />
  ) : (
    <ThreadRoom id={view.id} onBack={() => setView({ name: "home" })} />
  );
}
