/**
 * Which paths a `.dockerignore` leaves out of a build context, for the tests
 * that read the ignore files and the build context (dockerignore.test.ts,
 * image-context.test.ts). No docker is involved.
 *
 * The rules are moby/patternmatcher's, which BuildKit uses for .dockerignore:
 * `**` spans any number of directories, `*` stays within one, a pattern that
 * matches a parent directory excludes everything under it, and a later `!`
 * pattern re-includes. This is that algorithm (compile to a regexp, then test
 * the path and each parent prefix), checked against a real `docker build` with
 * the same sample paths when it was written.
 */
import { readFileSync } from "node:fs";

export interface Pattern {
  re: RegExp;
  exclusion: boolean;
}

function compile(raw: string): RegExp {
  let re = "^";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "*") {
      if (raw[i + 1] === "*") {
        i++;
        if (raw[i + 1] === "/") i++;
        re += i + 1 >= raw.length ? ".*" : "(.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+()|{}$^".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`${re}$`);
}

/** The patterns of an ignore file, in order. */
export function parseDockerignore(path: string): Pattern[] {
  const out: Pattern[] = [];
  for (let line of readFileSync(path, "utf8").split("\n")) {
    line = line.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exclusion = line.startsWith("!");
    let p = exclusion ? line.slice(1).trim() : line;
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");
    out.push({ re: compile(p), exclusion });
  }
  return out;
}

/** True when the path (relative to the context root) is left out of the context. */
export function ignored(patterns: Pattern[], path: string): boolean {
  const parents = path.split("/").slice(0, -1);
  let matched = false;
  for (const pat of patterns) {
    if (pat.exclusion !== matched) continue;
    let m = pat.re.test(path);
    for (let i = 0; !m && i < parents.length; i++) m = pat.re.test(parents.slice(0, i + 1).join("/"));
    if (m) matched = !pat.exclusion;
  }
  return matched;
}
