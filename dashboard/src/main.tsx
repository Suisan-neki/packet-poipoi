import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./app.css";
import "./balance-fix.css";

// 技育博の展示画面は、実機の計測状態と結果を一画面で見せる。
const root = document.getElementById("root");

if (!root) {
  throw new Error("#root was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
