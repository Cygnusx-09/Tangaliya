import { useState } from "react";
import { DotArtTool } from "./components/DotArtTool";

// Home shows on cold opens (new tab/window) but not on same-session reloads.
// sessionStorage is per-tab and dies with the tab, unlike localStorage, so a
// fresh tab always starts with no flag (Home), while reloading mid-session
// keeps it (straight to the resumed canvas) — the flag is set on the FIRST
// Home dismissal of the session, not at boot, so staying on Home across a
// reload is also possible (you never entered the editor).
const SESSION_KEY = "tangaliya-session-alive";

export default function App() {
  const [showHome, setShowHome] = useState<boolean>(() => {
    try { return sessionStorage.getItem(SESSION_KEY) === null; } catch { return false; }
  });
  const hideHome = () => {
    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* private mode — degrades to no Home gate */ }
    setShowHome(false);
  };
  return (
    <DotArtTool
      showHome={showHome}
      onShowHome={() => setShowHome(true)}
      onHideHome={hideHome}
    />
  );
}
