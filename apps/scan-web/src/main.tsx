import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/m-plus-1/japanese-400.css";
import "@fontsource/m-plus-1/japanese-700.css";
import "@fontsource/m-plus-1/latin-400.css";
import "@fontsource/m-plus-1/latin-700.css";
import { ScanWebApp } from "./app/ScanWebApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("scan web root is missing");

createRoot(root).render(
  <StrictMode>
    <ScanWebApp />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
