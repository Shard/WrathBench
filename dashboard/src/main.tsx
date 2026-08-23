/* Entry point. Routing only — every page is lazy so the first paint is small. */

import { Route, Router } from "@solidjs/router";
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Layout } from "./components/Layout";
import "./styles.css";

const Fleet = lazy(() => import("./pages/Fleet"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const MapPage = lazy(() => import("./pages/MapPage"));
const Eval = lazy(() => import("./pages/Eval"));
const Ladder = lazy(() => import("./pages/Ladder"));
const Episodes = lazy(() => import("./pages/Episodes"));
const NotFound = lazy(() => import("./pages/NotFound"));

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

render(
  () => (
    <Router root={Layout}>
      <Route path="/" component={Fleet} />
      <Route path="/run/:id" component={RunDetail} />
      <Route path="/map" component={MapPage} />
      <Route path="/eval" component={Eval} />
      <Route path="/ladder" component={Ladder} />
      <Route path="/episodes" component={Episodes} />
      <Route path="*" component={NotFound} />
    </Router>
  ),
  root,
);
