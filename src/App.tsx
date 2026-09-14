import { useEffect, useState } from "react";
import Home from "./components/Home";
import ThreadRoom from "./components/Thread";
import { initStore, useStore } from "./store";

type View = { name: "home" } | { name: "thread"; id: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const kickstartVotes = useStore((s) => s.kickstartVotes);

  useEffect(() => {
    let cancelled = false;
    initStore().then((mode) => {
      if (cancelled) return;
      console.info(`[co-ai] data layer: ${mode}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view.name === "thread") kickstartVotes(view.id);
  }, [view, kickstartVotes]);

  return view.name === "home" ? (
    <Home onOpen={(id) => setView({ name: "thread", id })} />
  ) : (
    <ThreadRoom id={view.id} onBack={() => setView({ name: "home" })} />
  );
}