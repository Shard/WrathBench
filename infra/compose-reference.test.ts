/**
 * The reference compose (infra/compose.reference.yml, infra/README.md "Play
 * and watch"): the quickstart's game services and the viewer-only file's
 * viewer, joined. Read as raw YAML, the way compose reads it, so a rename in
 * either base file or a port that leaves loopback fails here rather than at
 * a newcomer's first `up`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Volume = string | { source?: string; target?: string; read_only?: boolean };
type Service = {
  extends?: { file: string; service: string };
  environment?: Record<string, string | null>;
  ports?: string[];
  volumes?: Volume[];
  networks?: string[];
};
type Compose = { name?: string; services: Record<string, Service> };

const load = (file: string): Compose => Bun.YAML.parse(readFileSync(join(import.meta.dir, file), "utf8")) as Compose;
const reference = load("compose.reference.yml");
const viewerEnv = reference.services["viewer"]!.environment!;

/** A volume's container path and whether it is read-only, from either syntax. */
function mount(v: Volume): { target: string; readOnly: boolean } {
  if (typeof v !== "string") return { target: v.target ?? "", readOnly: v.read_only === true };
  const [, target = "", mode = ""] = v.split(":");
  return { target, readOnly: mode === "ro" };
}

/** A service's ports and volumes as compose merges them: the base's, then this file's. */
function merged(name: string): Required<Pick<Service, "ports" | "volumes">> {
  const own = reference.services[name]!;
  const base = own.extends === undefined ? {} : load(own.extends.file).services[own.extends.service]!;
  return { ports: [...(base.ports ?? []), ...(own.ports ?? [])], volumes: [...(base.volumes ?? []), ...(own.volumes ?? [])] };
}

describe("the reference compose", () => {
  test("is the game services and the viewer, nothing of the runner's, under a project of its own", () => {
    expect(Object.keys(reference.services).sort()).toEqual(["authserver", "bootstrap", "db", "db-import", "viewer", "worldserver"]);
    expect(reference.name).toBe("wrathbench-reference");
    expect(reference.name).not.toBe(load("compose.yml").name);
    expect(reference.name).not.toBe(load("compose.viewer.yml").name);
  });

  test("every service extends one that exists, of the same name, and restates nothing else it need not", () => {
    for (const [name, svc] of Object.entries(reference.services)) {
      expect(svc.extends, name).toBeDefined();
      expect(svc.extends!.service, name).toBe(name);
      expect(load(svc.extends!.file).services[name], `${svc.extends!.file} has ${name}`).toBeDefined();
      for (const key of Object.keys(svc)) expect(["extends", "ports", "environment", "volumes", "networks", "depends_on"], `${name}.${key}`).toContain(key);
    }
  });

  test("publishes every port on the host's loopback and nowhere else, the module's included", () => {
    for (const name of Object.keys(reference.services)) {
      for (const p of merged(name).ports) expect(p.startsWith("127.0.0.1:"), `${name} ${p}`).toBe(true);
    }
    const module = load("compose.yml").services["worldserver"]!.environment!["AC_WRATH_BENCH_PORT"];
    expect(merged("worldserver").ports).toContain(`127.0.0.1:${module}:${module}`);
  });

  test("gives the viewer the module's URL and secret, on the worldserver's network", () => {
    const worldserver = load("compose.yml").services["worldserver"]!;
    expect(viewerEnv["WRATHBENCH_MODULE_URL"]).toBe(`http://worldserver:${worldserver.environment!["AC_WRATH_BENCH_PORT"]}`);
    expect(viewerEnv["WRATHBENCH_MODULE_SECRET"]).toStartWith("${WRATHBENCH_MODULE_SECRET:?");
    expect(worldserver.environment!["AC_WRATH_BENCH_SECRET"]).toStartWith("${WRATHBENCH_MODULE_SECRET:");
    for (const n of reference.services["viewer"]!.networks!) expect(worldserver.networks).toContain(n);
  });

  test("turns the admin switch on, with the config store on a writable mount", () => {
    expect(viewerEnv["WRATHBENCH_ADMIN"]).toBe("1");
    const db = viewerEnv["WRATHBENCH_CONFIG_DB"]!;
    const dir = db.slice(0, db.lastIndexOf("/"));
    const mounts = merged("viewer").volumes.map(mount);
    expect(mounts).toContainEqual({ target: dir, readOnly: false });
  });

  test("still mounts the session store read-only", () => {
    expect(merged("viewer").volumes.map(mount)).toContainEqual({ target: "/sessions", readOnly: true });
  });
});
