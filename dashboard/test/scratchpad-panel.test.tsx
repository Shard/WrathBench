/**
 * The run page's scratchpad panel against a hostile pad.
 *
 * The pad is model-written and published as written, so whatever a model can
 * type is what this panel is handed: a script tag, an image with an error
 * handler, a `javascript:` link in markdown or HTML, a stray `</pre>`, and one
 * line long enough to push a phone layout sideways. The contract is that it
 * all arrives as text — no element is made out of it, no attribute, no link —
 * and that the panel's box bounds it.
 *
 * happy-dom executes no script by default, so "nothing ran" would be vacuous
 * here; what is asserted instead is the structure that makes running anything
 * impossible, beside a control that shows the same string parsed as markup
 * would have produced every one of the elements the panel must not. The
 * real-browser check (the payload's canary, page width at 360 px) is run in
 * Chromium against the built dashboard, not in this suite. Layout is not
 * computed by happy-dom either, so the bound is asserted on the stylesheet
 * rule the panel's class carries.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type PanelModule = typeof import("../src/components/Scratchpad");

async function loadPanel(): Promise<PanelModule> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/src/components/Scratchpad.tsx")) as PanelModule;
  } finally {
    await server.close();
  }
}

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "HTMLTemplateElement",
  "Document",
  "Event",
  "CustomEvent",
  "navigator",
] as const;
const priorGlobals = new Map<string, { present: boolean; value: unknown }>();

function installDom(): { document: Document; restore: () => void } {
  const window = new Window();
  const values: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document as unknown as Document,
    Node: window.Node,
    Text: window.Text,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    SVGSVGElement: window.SVGSVGElement,
    HTMLTemplateElement: window.HTMLTemplateElement,
    Document: window.Document,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
  };
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return {
    document: window.document as unknown as Document,
    restore: () => {
      for (const name of DOM_GLOBALS) {
        const prior = priorGlobals.get(name)!;
        if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
        else delete (globalThis as Record<string, unknown>)[name];
      }
      priorGlobals.clear();
    },
  };
}

afterEach(() => {
  if (priorGlobals.size > 0) {
    for (const [name, prior] of priorGlobals) {
      if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
      else delete (globalThis as Record<string, unknown>)[name];
    }
    priorGlobals.clear();
  }
});

/** One unbroken line, longer than the runner's 32k cap ever lets a pad be. */
const HUGE_LINE = "x".repeat(40_000);

const HOSTILE = [
  "# Plan <script>window.__xss = 1</script>",
  '<img src="x" onerror="window.__xss = 2">',
  "[open the map](javascript:window.__xss=3)",
  '<a href="javascript:window.__xss=4">trainer</a>',
  '<iframe src="javascript:window.__xss=5"></iframe>',
  '<svg onload="window.__xss=6"><circle r="1"/></svg>',
  "</pre></section><style>body { display: none }</style>",
  "- [ ] **sell** greys at `Grundel` & <b>train</b>",
  HUGE_LINE,
].join("\n");

/** What the panel may be built from: its own markup, and nothing the pad could add. */
const MARKUP_TAGS = /^(script|img|a|iframe|svg|object|embed|style|link|form|input|b)$/;

describe("the scratchpad panel against a hostile pad", () => {
  test("every byte of the pad is text: no element, attribute or link is made from it", async () => {
    const { document, restore } = installDom();
    try {
      const { ScratchpadPanel } = await loadPanel();
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(() => createComponent(ScratchpadPanel, { text: HOSTILE }), mount);

      const pre = mount.querySelector("pre.scratchpad");
      expect(pre).not.toBeNull();
      // The pad is the pre's one child, and that child is a text node.
      expect(pre!.childNodes.length).toBe(1);
      expect(pre!.firstChild!.nodeType).toBe(3);
      expect(pre!.textContent).toBe(HOSTILE);

      // Nothing the pad spelled became an element, anywhere in the panel.
      expect(mount.querySelector("script, img, a, iframe, svg, object, embed, style, link, b")).toBeNull();
      const tags = [...mount.querySelectorAll("*")].map((el) => el.tagName.toLowerCase());
      expect(tags.filter((t) => MARKUP_TAGS.test(t))).toEqual([]);
      // No handler, no URL attribute: the panel's own attributes are all there are.
      const attrs = [...mount.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.name));
      expect(attrs.filter((a) => a.startsWith("on") || a === "href" || a === "src")).toEqual([]);
      expect((globalThis as Record<string, unknown>).__xss).toBeUndefined();

      // The control: the same string parsed as markup makes every one of
      // them, so the assertions above would see a panel that rendered it.
      const control = document.createElement("div");
      control.innerHTML = HOSTILE;
      expect(control.querySelector("script")).not.toBeNull();
      expect(control.querySelector("img[onerror]")).not.toBeNull();
      expect(control.querySelector('a[href^="javascript:"]')).not.toBeNull();
      expect(control.querySelector("iframe")).not.toBeNull();

      dispose();
    } finally {
      restore();
    }
  });

  test("a re-read pad updates the same box in place, so a reader's scroll survives it", async () => {
    const { document, restore } = installDom();
    try {
      const { ScratchpadPanel } = await loadPanel();
      const [text, setText] = createSignal("# Plan\n- [ ] train at level 4");
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(
        () =>
          createComponent(ScratchpadPanel, {
            get text() {
              return text();
            },
          }),
        mount,
      );
      const pre = mount.querySelector("pre.scratchpad");
      setText("# Plan\n- [x] train at level 4");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(mount.querySelector("pre.scratchpad")).toBe(pre);
      expect(pre!.textContent).toBe("# Plan\n- [x] train at level 4");
      dispose();
    } finally {
      restore();
    }
  });

  test("the panel's box bounds a long pad and wraps an unbroken line", () => {
    // happy-dom does no layout, so the bound is the rule the class carries.
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rule = /pre\.block\.scratchpad\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    expect(body).toMatch(/max-height:\s*\d+vh/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});
