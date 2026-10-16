import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { JudgeApp } from "./simple/JudgeApp";
import { SimpleApp } from "./simple/SimpleApp";

/** `npx agentshield-hooks setup` runs the server in local mode: one simple page. The public link keeps the full console. */
function Root() {
  const [local, setLocal] = useState<boolean | null>(/[?&]t=/.test(window.location.hash) ? true : null);
  useEffect(() => {
    if (local !== null) return;
    api.info().then((i) => setLocal(Boolean(i.local)), () => setLocal(false));
  }, [local]);
  if (local === null) return null;
  return local ? <SimpleApp /> : <JudgeApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
