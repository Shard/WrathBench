import { describe, expect, test } from "bun:test";
import { redirectTarget, screenInlineLinks, stripWikitext } from "../src/strip";
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

  test("links become their labels; file, image and category links are dropped whole", () => {
    expect(stripWikitext("See [[Example Zone Beta]].")).toBe("See Example Zone Beta.");
    expect(stripWikitext("See [[Example Zone Beta|the beta zone]].")).toBe("See the beta zone.");
    expect(stripWikitext("See [[Example Zone Beta#Section|there]].")).toBe("See there.");
    expect(stripWikitext("A [[:Example Page]] link.")).toBe("A Example Page link.");
    expect(stripWikitext("[[File:Example.jpg|thumb|A caption]]Lorem.")).toBe("Lorem.");
    expect(stripWikitext("[[Image:Example.png|20px]]Lorem.")).toBe("Lorem.");
    expect(stripWikitext("Lorem.[[Category:Example Category]]")).toBe("Lorem.");
    expect(stripWikitext("[[File:E.jpg|thumb|see [[Example Page Gamma]] here]]Lorem.")).toBe("Lorem.");
  });

  test("comments, refs and html tags go, and entities left in the wikitext are decoded", () => {
    expect(stripWikitext("Lorem<!-- hidden note -->ipsum.")).toBe("Loremipsum.");
    expect(stripWikitext("Lorem<ref name=x>a citation</ref> ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("Lorem<br />ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("Lorem<!-- unterminated")).toBe("Lorem");
    expect(stripWikitext("Lorem&nbsp;ipsum &amp; dolor &#65;.")).toBe("Lorem ipsum & dolor A.");
  });

  test("external links keep their label only", () => {
    expect(stripWikitext("See [https://example.invalid/x the docs].")).toBe("See the docs.");
    expect(stripWikitext("See [https://example.invalid/x].")).toBe("See .");
  });

  test("is deterministic and never throws on hostile input", () => {
    const nasty = "{{{{{[[[[|||}}}}<ref><<>>{|" + "x".repeat(1000) + "]]]}}";
    const once = stripWikitext(nasty);
    expect(stripWikitext(nasty)).toBe(once);
    expect(typeof once).toBe("string");
  });

  test("a repeated named ref is self-closing, not an opening tag", () => {
    // `<ref name="x" />` cites a footnote a second time. Reading it as an
    // opening tag ate everything to the next `</ref>` — including the `}}`
    // that closed the infobox, which then swallowed the whole page.
    const wt = `{{infobox place
| name = Example Hold Alpha
| people = {{Race|Widgetkin}} (1,200)<ref name="Src">''[[Example Source Beta]]'', pg 12</ref>
| ruler = Example Person Gamma<ref name="Src" />
| language = [[Widgetish]]
}}
Lorem ipsum dolor sit amet.`;
    expect(stripWikitext(wt)).toBe("Lorem ipsum dolor sit amet.");
  });

  test("a brace run is a run, not two-character pairs", () => {
    // `{{{name|default}}}` is a template parameter. Read two characters at a
    // time, its third brace opens a `{|` table that nothing ever closes.
    expect(stripWikitext("{{box|a={{{1|Alpha}}}|b=y}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("{{box|a={{{mode|}}}|b=y}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("{{{{Example Template Delta}}}}Lorem ipsum.")).toBe("Lorem ipsum.");
    // The mirror case: over-closing used to leak the template's own fields out
    // as if they were prose.
    expect(stripWikitext("{{box\n|criteria=\n* Collect 5 [[Example Item Delta]]\n|mode={{{m|}}}\n}}")).toBe("");
  });

  test("a closer matches its own kind", () => {
    // A `{|` written inside a template argument must not eat the template's
    // `}}`, and `|}}` is a last argument's pipe, not a table closer.
    expect(stripWikitext("{{box|a=x{|y\n}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("{{box|a=x|}}Lorem ipsum.")).toBe("Lorem ipsum.");
    expect(stripWikitext("{|\n| {{tpl|x}}\n|}\nLorem ipsum.")).toBe("Lorem ipsum.");
  });

  test("an unclosed opener costs its paragraph, not the page", () => {
    const wt = "{{infobox place\n| name = Example Hold Alpha\n\nLorem ipsum dolor sit amet.";
    expect(stripWikitext(wt)).toBe("Lorem ipsum dolor sit amet.");
    // Prose before the unclosed opener is kept, as it always was.
    expect(stripWikitext("Before.\n\n{{unclosed\n\nAfter.")).toBe("Before.\nAfter.");
    // No blank line after it: the tail goes with the opener.
    expect(stripWikitext("Before.\n\n{{unclosed lorem")).toBe("Before.");
  });

  test("inline link templates leave the name they link to, never a display override", () => {
    // Each shape is the template's own slot order: the name is the link target.
    expect(stripWikitext("Sold by {{npc|Alliance|Example Person Gamma|Lorem Seller}} in Example Town.")).toBe(
      "Sold by Example Person Gamma in Example Town.",
    );
    expect(stripWikitext("A reward from {{quest|Example Quest Alpha}}.")).toBe(
      "A reward from Example Quest Alpha.",
    );
    expect(stripWikitext("* {{questlong|Horde|12|Example Quest Alpha}} starts here")).toBe(
      "Example Quest Alpha starts here",
    );
    expect(stripWikitext("It drops {{loot|epic|Example Item Delta}}.")).toBe("It drops Example Item Delta.");
    expect(stripWikitext("Ask {{npclong|Neutral|30|Example Person Gamma|Lorem}} nearby.")).toBe(
      "Ask Example Person Gamma nearby.",
    );
    expect(stripWikitext("From {{quest|Example Quest Alpha|(Lorem)}}.")).toBe("From Example Quest Alpha.");
    expect(stripWikitext("From {{loot|rare|Example Item Delta|s}}.")).toBe("From Example Item Delta.");
  });

  test("an inline link template is matched the way the wiki matched it", () => {
    expect(stripWikitext("By {{NPC||Example Person Gamma}}.")).toBe("By Example Person Gamma.");
    expect(stripWikitext("By {{Template:Quest|Example Quest Alpha}}.")).toBe("By Example Quest Alpha.");
    expect(stripWikitext("By {{quest\n|Example Quest Alpha\n}}.")).toBe("By Example Quest Alpha.");
    // `2=` names the slot outright; a named argument is never positional.
    expect(stripWikitext("By {{npc|smallicon=Lorem.png|Horde|2=Example Person Gamma}}.")).toBe(
      "By Example Person Gamma.",
    );
    // A pipe inside a link is not an argument separator.
    expect(stripWikitext("By {{item|[[Example Item Delta|Delta]]}}.")).toBe("By Delta.");
  });

  test("an empty name slot leaves nothing, as before", () => {
    expect(stripWikitext("Sold by {{npc|Alliance}} here.")).toBe("Sold by here.");
    expect(stripWikitext("Sold by {{npc|Alliance||Lorem Seller}} here.")).toBe("Sold by here.");
    expect(stripWikitext("A {{quest}} here.")).toBe("A here.");
  });

  test("every other template still goes, a link template nested in one included, and one nested in a name slot follows the rule", () => {
    expect(stripWikitext("Costs {{cost|1|50|0}} and sits at {{coords|48.2|42.1|Example Zone Beta}}.")).toBe(
      "Costs and sits at .",
    );
    expect(stripWikitext("{{questbox\n| name = Example Quest Alpha\n| start = {{npc||Example Person Gamma}}\n}}Lorem.")).toBe(
      "Lorem.",
    );
    expect(stripWikitext("{{box|a={{quest|Example Quest Alpha}}}}Lorem.")).toBe("Lorem.");
    expect(stripWikitext("{|\n| {{loot|epic|Example Item Delta}}\n|}\nLorem.")).toBe("Lorem.");
    expect(stripWikitext("{{{quest|Example Quest Alpha}}}Lorem.")).toBe("Lorem.");
    expect(stripWikitext("By {{quest|{{item|Example Item Delta}}}}.")).toBe("By Example Item Delta.");
    expect(stripWikitext("By {{quest|{{lorem}}}}.")).toBe("By .");
  });

  test("the strip counts the link templates it wrote and the ones it screened", () => {
    const counts = { inlineLinks: 0, screenedByQualifier: 0, screenedByEra: 0 };
    stripWikitext(
      "{{npc||Example Person Gamma}} and {{quest|Example Quest Alpha}}; {{cost|1}} {{npc|Horde}} " +
        "{{quest|Example Quest Beta (Cataclysm)}} " +
        screenInlineLinks("{{item|Example Item Delta}} {{item|}}"),
      { counts },
    );
    expect(counts).toEqual({ inlineLinks: 2, screenedByQualifier: 1, screenedByEra: 1 });
  });

  test("a name with a later-world qualifier leaves the hole it always left", () => {
    // The qualifier lists are the title rules' own: an expansion, a later zone.
    expect(stripWikitext("From {{quest|Example Quest Alpha (Cataclysm)}}.")).toBe("From .");
    expect(stripWikitext("From {{quest|Example Quest Alpha (Shimmering Expanse)}}.")).toBe("From .");
    expect(stripWikitext("By {{npc||Example Person Gamma (Gilneas)}}.")).toBe("By .");
    // A qualifier of this world, or one that only mentions a place, still renders.
    expect(stripWikitext("By {{npc||Example Person Gamma (Alliance)}}.")).toBe("By Example Person Gamma (Alliance).");
    expect(stripWikitext("By {{npc||Example Person Gamma (Gilneas Example Hold)}}.")).toBe(
      "By Example Person Gamma (Gilneas Example Hold).",
    );
    // `(Worgen)` is the worgen starting zone's version of a thing; a bare
    // worgen in a name is this world's.
    expect(stripWikitext("From {{quest|Example Quest Alpha (Worgen)}}.")).toBe("From .");
    expect(stripWikitext("Slay {{mob|Example Worgen Eta}}.")).toBe("Slay Example Worgen Eta.");
  });

  test("a screened call strips exactly as it did before link templates rendered", () => {
    const wt = "* {{quest|Example Quest Alpha}} from {{NPC|Horde|Example Person Gamma}}\n* {{ Template:Loot |epic|Example Item Delta}}";
    expect(stripWikitext(screenInlineLinks(wt))).toBe(stripWikitext(wt, { inlineLinks: false }));
    expect(stripWikitext(screenInlineLinks(wt))).toBe("from");
    // Other templates are untouched by the mark.
    expect(screenInlineLinks("{{cost|1}}{{questbox|x}}")).toBe("{{cost|1}}{{questbox|x}}");
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
  test("recognises redirects in several shapes, and only at the start of a page", () => {
    expect(redirectTarget("#REDIRECT [[Example New Name]]")).toBe("Example New Name");
    expect(redirectTarget("#redirect[[Example New Name]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example_New_Name]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example New Name#Section]]")).toBe("Example New Name");
    expect(redirectTarget("#REDIRECT [[Example New Name|label]]")).toBe("Example New Name");
    expect(redirectTarget("\n  #REDIRECT [[Example New Name]]\n[[Category:X]]")).toBe(
      "Example New Name",
    );
    expect(redirectTarget("Lorem ipsum with a [[Example New Name]] link.")).toBeNull();
    expect(redirectTarget("Lorem #REDIRECT [[Example New Name]] mid-article.")).toBeNull();
  });
});

describe("decodeEntities", () => {
  test("decodes in a single pass and leaves unknown entities alone", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&lt;tag&gt; &quot;q&quot; &apos;a&apos;")).toBe(`<tag> "q" 'a'`);
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&thinsp;&notanentity;")).toBe("&thinsp;&notanentity;");
  });
});
