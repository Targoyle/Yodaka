import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./index.css";

const app = <App />;
const rootElement = document.getElementById("root")!;
const root = ReactDOM.createRoot(rootElement);

root.render(
  import.meta.env.DEV ? app : <React.StrictMode>{app}</React.StrictMode>,
);
