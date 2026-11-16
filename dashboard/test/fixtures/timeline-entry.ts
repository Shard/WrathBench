/**
 * One module graph for the timeline's render test: the bar and the store it
 * reads, loaded through the same Vite module runner, so the signals the test
 * writes are the ones the component tracks.
 */
export { Timeline } from "../../src/components/Timeline";
export { createTimeline } from "../../src/lib/timelinestore";
export { createRoot, createSignal } from "solid-js";
