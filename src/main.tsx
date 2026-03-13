import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");

const appRoot = createRoot(root);

function renderApp() {
  appRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

renderApp();

if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", () => {
    window.dispatchEvent(new Event("ceramic:force-renderer-reinit"));
  });

  import.meta.hot.on("vite:beforeFullReload", () => {
    window.dispatchEvent(new Event("ceramic:force-renderer-reinit"));
  });

  import.meta.hot.dispose(() => {
    appRoot.unmount();
  });
}
