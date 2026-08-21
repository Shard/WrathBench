import { describe, expect, test } from "bun:test";
import { redirectTarget, stripWikitext } from "../src/strip";
import { decodeEntities } from "../src/entities";

describe("stripWikitext", () => {
  test("templates go, including nested ones", () => {
    expect(stripWikitext("{{Stub}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("{{box|a={{inner|x}}|b=y}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("before {{a}} after")).toBe("before after");
    expect(stripWikitext("{{unclosed lorem")).toBe("");
  });

  test("tables go", () => {
    const wt = `Lorem before.
{| class="example"
! Header
|-
| cell one || cell two
|}
Lorem after.`;
    expect(stripWikitext(wt)).toBe("Lorem before.\nLorem after.");
  });

  test("links become their labels", () => {
    expect(stripWikitext("See [[Example Zone Beta]].")).toBe("See Example Zone Beta.");
    expect(stripWikitext("See [[Example Zone Beta|the beta zone]].")).toBe("See the beta zone.");
    expect(stripWikitext("See [[Example Zone Beta#Section|there]].")).toBe("See there.");
    expect(stripWikitext("A [[:Example Page]] link.")).toBe("A Example Page link.");
  });

  test("file, image and category links are dropped whole", () => {
    expect(stripWikitext("[[File:Example.jpg|thumb|A caption]]Lorem.")).toBe("Lorem.");
    expect(stripWikitext("[[Image:Example.png|20px]]Lorem.")).toBe("Lorem.");
    expect(stripWikitext("Lorem.[[Category:Example Category]]")).toBe("Lorem.");
    expect(stripWikitext("[[File:E.jpg|thumb|see [[Example Page Gamma]] here]]Lorem.")).toBe("Lorem.");
  });

  test("comments, refs and html tags go", () => {
    expect(stripWikitext("Lorem<!-- hidden note -->ipsum.")).toBe("Loremipsum.");
    expect(stripWikitext("Lorem<ref name=x>a citation</ref> ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("Lorem<br />ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("Lorem<!-- unterminated")).toBe("Lorem");
  });

  test("headings become plain lines and formatting marks go", () => {
    expect(stripWikitext("== Example Section ==\nLorem.")).toBe("Example Section\nLorem.");
    expect(stripWikitext("===Deeper===\nLorem.")).toBe("Deeper\nLorem.");
    expect(stripWikitext("'''Bold''' and ''italic''.")).toBe("Bold and italic.");
  });

  test("list markers go, list text stays", () => {
    expect(stripWikitext("* one\n* two\n** nested\n# numbered\n: indented")).toBe(
      "one\ntwo\nnested\nnumbered\nindented",
    );
  });

  test("external links keep their label only", () => {
    expect(stripWikitext("See [https://example.invalid/x the docs].")).toBe("See the docs.");
    expect(stripWikitext("See [https://example.invalid/x].")).toBe("See .");
  });

  test("whitespace is collapsed and empty lines dropped", () => {
    expect(stripWikitext("Lorem   ipsum\n\n\n\nDolor  sit\n\n")).toBe("Lorem ipsum\nDolor sit");
  });

  test("html entities left in the wikitext are decoded", () => {
    expect(stripWikitext("Lorem&nbsp;ipsum &amp; dolor &#65;.")).toBe("Lorem ipsum & dolor A.");
  });

  test("is deterministic and never throws on hostile input", () => {
    const nasty = "{{{{{[[[[|||}}}}<ref><<>>{|" + "x".repeat(1000) + "]]]}}";
    const once = stripWikitext(nasty);
    expect(stripWikitext(nasty)).toBe(once);
    expect(typeof once).toBe("string");
  });

  test("a realistic synthetic article reduces to prose", () => {
    const wt = `{{questbox
 | name = Example Quest Alpha
 | level = 5
 | zone = [[Example Zone Beta]]
}}
'''Example Quest Alpha''' is the first quest of the [[Example Zone Beta|beta zone]].<!-- todo -->

== Objectives ==
* Speak to [[Example Person Gamma]].
* Collect 5 [[Example Item Delta]].

== Description ==
Lorem ipsum dolor sit amet, says the quest giver.

[[Category:Example Category]]`;
    expect(stripWikitext(wt)).toBe(
      [
        "Example Quest Alpha is the first quest of the beta zone.",
        "Objectives",
        "Speak to Example Person Gamma.",
        "Collect 5 Example Item Delta.",
        "Description",
        "Lorem ipsum dolor sit amet, says the quest giver.",
      ].join("\n"),
    );
  });
});

describe("redirectTarget", () => {
  test("recognises redirects in several shapes", () => {
    expect(redirectTarget("#REDIRECT [[Example New Name]]")).toBe("Example New Name");
    expect(redirectTarget("#redirect[[Example New Name]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example_New_Name]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example New Name#Section]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example New Name|label]]")).toBe("Example New Name");
    expect(redirectTarget("\n  #REDIRECT [[Example New Name]]\n[[Category:X]]")).toBe(
      "Example New Name",
    );
  });

  test("returns null for ordinary articles", () => {
    expect(redirectTarget("Lorem ipsum with a [[Example New Name]] link.")).toBeNull();
    expect(redirectTarget("Lorem #REDIRECT [[Example New Name]] mid-article.")).toBeNull();
    expect(redirectTarget("")).toBeNull();
  });
});

describe("decodeEntities", () => {
  test("decodes in a single pass", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&lt;tag&gt; &quot;q&quot; &apos;a&apos;")).toBe(`<tag> "q" 'a'`);
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  test("leaves unknown entities alone", () => {
    expect(decodeEntities("&thinsp;&notanentity;")).toBe("&thinsp;&notanentity;");
  });
});
