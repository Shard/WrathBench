/* Entry point. Routing only — every page is lazy so the first paint is small. */

import { Navigate, Route, Router, useLocation } from "@solidjs/router";
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Layout } from "./components/Layout";
import "./styles.css";

const Fleet = lazy(() => import("./pages/Fleet"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const MapPage = lazy(() => import("./pages/MapPage"));
const Runs = lazy(() => import("./pages/Runs"));
const Ladder = lazy(() => import("./pages/Ladder"));
const Episodes = lazy(() => import("./pages/Episodes"));
const Models = lazy(() => import("./pages/Models"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const NotFound = lazy(() => import("./pages/NotFound"));

/** `/results` was renamed `/runs`. A redirect, so a bookmarked link still lands. */
function ResultsRedirect() {
  const location = useLocation();
  return <Navigate href={`/runs${location.search}`} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

render(
  () => (
    <Router root={Layout}>
      <Route path="/" component={Fleet} />
      <Route path="/run/:id" component={RunDetail} />
      <Route path="/map" component={MapPage} />
      <Route path="/runs" component={Runs} />
      {/* The results page became the runs page; old links keep their query. */}
      <Route path="/results" component={ResultsRedirect} />
      <Route path="/ladder" component={Ladder} />
      <Route path="/episodes" component={Episodes} />
      <Route path="/models" component={Models} />
      <Route path="/campaigns" component={Campaigns} />
      <Route path="*" component={NotFound} />
    </Router>
  ),
  root,
);
