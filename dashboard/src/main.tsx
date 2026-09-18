/* Entry point. Routing only — every page is lazy so the first paint is small. */

import { Navigate, Route, Router, useLocation } from "@solidjs/router";
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Layout } from "./components/Layout";
import "./styles.css";
import { SNAPSHOT_MODE } from "./api/client";

/**
 * Cloudflare Web Analytics, public site only. The beacon is cookieless and the
 * token is per-hostname, so it is injected here rather than in index.html: the
 * same dist is served by the private viewer, which should report nothing.
 */
if (SNAPSHOT_MODE) {
  const beacon = document.createElement("script");
  beacon.type = "module";
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  beacon.dataset["cfBeacon"] = JSON.stringify({ token: "75492948b1e04489a2808cec401da6cb" });
  document.head.append(beacon);
}

const Home = lazy(() => import("./pages/Home"));
const Fleet = lazy(() => import("./pages/Fleet"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const Character = lazy(() => import("./pages/Character"));
const MapPage = lazy(() => import("./pages/MapPage"));
const Runs = lazy(() => import("./pages/Runs"));
const Ladder = lazy(() => import("./pages/Ladder"));
const About = lazy(() => import("./pages/About"));
const Models = lazy(() => import("./pages/Models"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
/* Operator-only; the page itself withholds on the public build. */
const Config = lazy(() => import("./pages/Config"));
const NotFound = lazy(() => import("./pages/NotFound"));

/** `/results` was renamed `/runs`. A redirect, so a bookmarked link still lands. */
function ResultsRedirect() {
  const location = useLocation();
  return <Navigate href={`/runs${location.search}`} />;
}

/** `/episodes` became `/about`, and its query — the series pin — comes along. */
function EpisodesRedirect() {
  const location = useLocation();
  return <Navigate href={`/about${location.search}`} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

render(
  () => (
    <Router root={Layout}>
      <Route path="/" component={Home} />
      <Route path="/fleet" component={Fleet} />
      <Route path="/run/:id" component={RunDetail} />
      {/* One character across its attempts. The id is any run in the chain. */}
      <Route path="/character/:id" component={Character} />
      <Route path="/map" component={MapPage} />
      <Route path="/runs" component={Runs} />
      {/* The results page became the runs page; old links keep their query. */}
      <Route path="/results" component={ResultsRedirect} />
      <Route path="/ladder" component={Ladder} />
      <Route path="/about" component={About} />
      {/* The episodes page became the about page; old links still land. */}
      <Route path="/episodes" component={EpisodesRedirect} />
      <Route path="/models" component={Models} />
      <Route path="/campaigns" component={Campaigns} />
      <Route path="/config" component={Config} />
      <Route path="*" component={NotFound} />
    </Router>
  ),
  root,
);
