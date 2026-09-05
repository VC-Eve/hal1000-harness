import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { currentRoute } from "./route";

// Black before React, and outside it.
//
// The broadcast surface's background has to survive the one moment it matters
// most — React unmounting the tree on a render throw — and a class React
// manages is removed by its own cleanup at exactly that point. Set here, on the
// root element, it outlives the app. It is also why the document's own --bg
// (#050505, a lifted near-black) is left alone: /live keeps the appearance it
// has, and only this surface gets the true black its letterbox bars need.
if (currentRoute() === "broadcast") document.documentElement.classList.add("broadcast");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
