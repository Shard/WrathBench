import { A } from "@solidjs/router";

/**
 * The 404. A dead end with no way out of it is the one page a reader cannot
 * act on, so it carries the way back that every other page's chrome gives.
 */
export default function NotFound() {
  return (
    <div class="page">
      <h1>no such page</h1>
      <p class="dim">
        Nothing is served at this address. The <A href="/">homepage</A> explains what WrathBench is;{" "}
        <A href="/runs">runs</A> is every recorded run.
      </p>
    </div>
  );
}
