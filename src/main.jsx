import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import App from "./App.jsx";

// Service worker is web-only — Capacitor native handles push natively
if ("serviceWorker" in navigator && !Capacitor.isNativePlatform()) {
  navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => {});
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
