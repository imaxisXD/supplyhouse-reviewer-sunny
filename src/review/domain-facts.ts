import type { DiffFile } from "../types/bitbucket.ts";
import { runCypher } from "../db/memgraph.ts";
import { createLogger } from "../config/logger.ts";
import type { RepoStrategyProfile } from "../utils/repo-meta.ts";

export interface FileDomainFacts {
  entities?: string[];
  services?: string[];
  templates?: string[];
  scripts?: string[];
  relations?: string[];
}

export interface PrDomainFacts extends FileDomainFacts {}

export interface DomainFactsIndex {
  byFile: Map<string, FileDomainFacts>;
  prFacts: PrDomainFacts;
}

type OfbizFileKind =
  | "entity"
  | "service"
  | "controller"
  | "screen"
  | "form"
  | "template"
  | "bsh";

const log = createLogger("domain-facts");

async function safeRunCypher(query: string, params: Record<string, unknown>): Promise<ReturnType<typeof runCypher>> {
  try {
    return await runCypher(query, params);
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "Domain facts query failed");
    return [];
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isOfbizProfile(profile?: RepoStrategyProfile | null): boolean {
  if (!profile) return false;
  if (profile.strategyId === "ofbiz-supplyhouse") return true;
  return profile.frameworkSignals?.includes("ofbiz") ?? false;
}

function classifyOfbizFile(filePath: string): OfbizFileKind | null {
  const lower = normalizePath(filePath).toLowerCase();
  if (lower.endsWith(".bsh")) return "bsh";
  if (lower.endsWith(".ftl")) return "template";
  if (lower.endsWith("entitymodel.xml")) return "entity";
  if (lower.endsWith("services.xml") || lower.endsWith("service.xml")) return "service";
  if (lower.endsWith("controller.xml")) return "controller";
  if (lower.endsWith("screens.xml") || lower.endsWith("screen.xml")) return "screen";
  if (lower.endsWith("forms.xml") || lower.endsWith("form.xml")) return "form";
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string") as string[];
  }
  if (typeof value === "string") return [value];
  return [];
}

function addAll(target: Set<string>, values: string[] | undefined): void {
  if (!values) return;
  for (const value of values) {
    if (value.trim().length === 0) continue;
    target.add(value);
  }
}

function toSorted(set: Set<string>): string[] {
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function buildRelations(
  relations: Set<string>,
  entries: Array<{ service?: string; entity?: string; script?: string }>,
): void {
  for (const entry of entries) {
    const service = entry.service;
    const entity = entry.entity;
    const script = entry.script;
    if (service && entity && script) {
      relations.add(`Service ${service} uses Entity ${entity} and is implemented by ${script}`);
    } else if (service && entity) {
      relations.add(`Service ${service} uses Entity ${entity}`);
    } else if (service && script) {
      relations.add(`Service ${service} is implemented by ${script}`);
    }
  }
}

export async function getFileDomainFacts(
  repoId: string,
  filePath: string,
  profile?: RepoStrategyProfile | null,
): Promise<FileDomainFacts> {
  if (!isOfbizProfile(profile)) return {};
  const kind = classifyOfbizFile(filePath);
  if (!kind) return {};
  const file = normalizePath(filePath);

  switch (kind) {
    case "entity": {
      const records = await safeRunCypher(
        `MATCH (e:Entity {repoId: $repoId, file: $file})
         OPTIONAL MATCH (s:Service {repoId: $repoId})-[:USES_ENTITY]->(e)
         OPTIONAL MATCH (f:Form {repoId: $repoId})-[:USES_ENTITY]->(e)
         RETURN e.name AS entity,
                collect(distinct s.name) AS services,
                collect(distinct f.name) AS forms`,
        { repoId, file },
      );
      const entities = new Set<string>();
      const services = new Set<string>();
      const relations = new Set<string>();
      for (const record of records) {
        const entity = record.get("entity") as string | undefined;
        if (entity) entities.add(entity);
        addAll(services, toStringArray(record.get("services")));
        const forms = toStringArray(record.get("forms"));
        for (const form of forms) {
          if (entity) relations.add(`Form ${form} uses Entity ${entity}`);
        }
        for (const service of toStringArray(record.get("services"))) {
          if (entity) relations.add(`Service ${service} uses Entity ${entity}`);
        }
      }
      return {
        entities: entities.size ? toSorted(entities) : undefined,
        services: services.size ? toSorted(services) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "service": {
      const records = await safeRunCypher(
        `MATCH (s:Service {repoId: $repoId, file: $file})
         OPTIONAL MATCH (s)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
         OPTIONAL MATCH (s)-[:IMPLEMENTED_BY]->(b:BshScript {repoId: $repoId})
         RETURN s.name AS service,
                collect(distinct e.name) AS entities,
                collect(distinct b.path) AS scripts`,
        { repoId, file },
      );
      const services = new Set<string>();
      const entities = new Set<string>();
      const scripts = new Set<string>();
      const relations = new Set<string>();
      const entries: Array<{ service?: string; entity?: string; script?: string }> = [];
      for (const record of records) {
        const service = record.get("service") as string | undefined;
        if (service) services.add(service);
        const entitiesArr = toStringArray(record.get("entities"));
        const scriptsArr = toStringArray(record.get("scripts"));
        addAll(entities, entitiesArr);
        addAll(scripts, scriptsArr);
        if (service) {
          if (entitiesArr.length === 0 && scriptsArr.length === 0) {
            entries.push({ service });
          }
          for (const entity of entitiesArr) {
            entries.push({ service, entity });
          }
          for (const script of scriptsArr) {
            entries.push({ service, script });
          }
        }
      }
      buildRelations(relations, entries);
      return {
        services: services.size ? toSorted(services) : undefined,
        entities: entities.size ? toSorted(entities) : undefined,
        scripts: scripts.size ? toSorted(scripts) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "bsh": {
      const records = await safeRunCypher(
        `MATCH (b:BshScript {repoId: $repoId, file: $file})
         OPTIONAL MATCH (s:Service {repoId: $repoId})-[:IMPLEMENTED_BY]->(b)
         OPTIONAL MATCH (s)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
         RETURN b.path AS script,
                collect(distinct s.name) AS services,
                collect(distinct e.name) AS entities`,
        { repoId, file },
      );
      const scripts = new Set<string>();
      const services = new Set<string>();
      const entities = new Set<string>();
      const relations = new Set<string>();
      const entries: Array<{ service?: string; entity?: string; script?: string }> = [];
      for (const record of records) {
        const script = record.get("script") as string | undefined;
        if (script) scripts.add(script);
        const servicesArr = toStringArray(record.get("services"));
        const entitiesArr = toStringArray(record.get("entities"));
        addAll(services, servicesArr);
        addAll(entities, entitiesArr);
        for (const service of servicesArr) {
          entries.push({ service, script });
          for (const entity of entitiesArr) {
            entries.push({ service, entity, script });
          }
        }
      }
      buildRelations(relations, entries);
      return {
        scripts: scripts.size ? toSorted(scripts) : undefined,
        services: services.size ? toSorted(services) : undefined,
        entities: entities.size ? toSorted(entities) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "template": {
      const records = await safeRunCypher(
        `MATCH (t:TemplateFTL {repoId: $repoId, file: $file})
         OPTIONAL MATCH (t)-[:INCLUDES]->(inc:TemplateFTL {repoId: $repoId})
         OPTIONAL MATCH (s:Screen {repoId: $repoId})-[:INCLUDES_TEMPLATE]->(t)
         OPTIONAL MATCH (v:ViewMap {repoId: $repoId})-[:RENDERS]->(t)
         RETURN t.path AS template,
                collect(distinct inc.path) AS includes,
                collect(distinct s.name) AS screens,
                collect(distinct v.name) AS views`,
        { repoId, file },
      );
      const templates = new Set<string>();
      const relations = new Set<string>();
      for (const record of records) {
        const template = record.get("template") as string | undefined;
        if (template) templates.add(template);
        const includes = toStringArray(record.get("includes"));
        const screens = toStringArray(record.get("screens"));
        const views = toStringArray(record.get("views"));
        for (const inc of includes) {
          if (template) relations.add(`Template ${template} includes ${inc}`);
        }
        for (const screen of screens) {
          if (template) relations.add(`Screen ${screen} includes template ${template}`);
        }
        for (const view of views) {
          if (template) relations.add(`ViewMap ${view} renders template ${template}`);
        }
      }
      return {
        templates: templates.size ? toSorted(templates) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "controller": {
      const records = await safeRunCypher(
        `MATCH (c:Controller {repoId: $repoId, file: $file})
         OPTIONAL MATCH (c)-[:HAS]->(r:RequestMap)
         OPTIONAL MATCH (r)-[:ROUTES_TO]->(v:ViewMap)
         OPTIONAL MATCH (v)-[:RENDERS]->(t:TemplateFTL)
         OPTIONAL MATCH (v)-[:RENDERS]->(s:Screen)
         RETURN c.name AS controller,
                collect(distinct r.name) AS requests,
                collect(distinct v.name) AS views,
                collect(distinct t.path) AS templates,
                collect(distinct s.name) AS screens`,
        { repoId, file },
      );
      const relations = new Set<string>();
      const templates = new Set<string>();
      for (const record of records) {
        const requests = toStringArray(record.get("requests"));
        const views = toStringArray(record.get("views"));
        const templatesArr = toStringArray(record.get("templates"));
        const screens = toStringArray(record.get("screens"));
        addAll(templates, templatesArr);
        for (const req of requests) {
          for (const view of views) {
            relations.add(`RequestMap ${req} routes to ViewMap ${view}`);
          }
        }
        for (const view of views) {
          for (const template of templatesArr) {
            relations.add(`ViewMap ${view} renders template ${template}`);
          }
          for (const screen of screens) {
            relations.add(`ViewMap ${view} renders screen ${screen}`);
          }
        }
      }
      return {
        templates: templates.size ? toSorted(templates) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "screen": {
      const records = await safeRunCypher(
        `MATCH (s:Screen {repoId: $repoId, file: $file})
         OPTIONAL MATCH (s)-[:INCLUDES_FORM]->(f:Form {repoId: $repoId})
         OPTIONAL MATCH (s)-[:INCLUDES_TEMPLATE]->(t:TemplateFTL {repoId: $repoId})
         RETURN s.name AS screen,
                collect(distinct f.name) AS forms,
                collect(distinct t.path) AS templates`,
        { repoId, file },
      );
      const relations = new Set<string>();
      const templates = new Set<string>();
      for (const record of records) {
        const screen = record.get("screen") as string | undefined;
        const forms = toStringArray(record.get("forms"));
        const templatesArr = toStringArray(record.get("templates"));
        addAll(templates, templatesArr);
        if (screen) {
          for (const form of forms) {
            relations.add(`Screen ${screen} includes form ${form}`);
          }
          for (const template of templatesArr) {
            relations.add(`Screen ${screen} includes template ${template}`);
          }
        }
      }
      return {
        templates: templates.size ? toSorted(templates) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    case "form": {
      const records = await safeRunCypher(
        `MATCH (f:Form {repoId: $repoId, file: $file})
         OPTIONAL MATCH (f)-[:CALLS_SERVICE]->(s:Service {repoId: $repoId})
         OPTIONAL MATCH (f)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
         RETURN f.name AS form,
                collect(distinct s.name) AS services,
                collect(distinct e.name) AS entities`,
        { repoId, file },
      );
      const services = new Set<string>();
      const entities = new Set<string>();
      const relations = new Set<string>();
      for (const record of records) {
        const form = record.get("form") as string | undefined;
        const servicesArr = toStringArray(record.get("services"));
        const entitiesArr = toStringArray(record.get("entities"));
        addAll(services, servicesArr);
        addAll(entities, entitiesArr);
        if (form) {
          for (const service of servicesArr) {
            relations.add(`Form ${form} calls Service ${service}`);
          }
          for (const entity of entitiesArr) {
            relations.add(`Form ${form} uses Entity ${entity}`);
          }
        }
      }
      return {
        services: services.size ? toSorted(services) : undefined,
        entities: entities.size ? toSorted(entities) : undefined,
        relations: relations.size ? toSorted(relations) : undefined,
      };
    }
    default:
      return {};
  }
}

function aggregateFacts(byFile: Map<string, FileDomainFacts>): PrDomainFacts {
  const entities = new Set<string>();
  const services = new Set<string>();
  const templates = new Set<string>();
  const scripts = new Set<string>();
  const relations = new Set<string>();

  for (const facts of byFile.values()) {
    addAll(entities, facts.entities);
    addAll(services, facts.services);
    addAll(templates, facts.templates);
    addAll(scripts, facts.scripts);
    addAll(relations, facts.relations);
  }

  const output: PrDomainFacts = {};
  if (entities.size) output.entities = toSorted(entities);
  if (services.size) output.services = toSorted(services);
  if (templates.size) output.templates = toSorted(templates);
  if (scripts.size) output.scripts = toSorted(scripts);
  if (relations.size) output.relations = toSorted(relations);
  return output;
}

async function buildCrossRelations(
  repoId: string,
  facts: PrDomainFacts,
): Promise<string[]> {
  const services = facts.services ?? [];
  const entities = facts.entities ?? [];
  const scripts = facts.scripts ?? [];
  if (services.length === 0 && entities.length === 0 && scripts.length === 0) {
    return [];
  }

  const records = await safeRunCypher(
    `MATCH (s:Service {repoId: $repoId})
     OPTIONAL MATCH (s)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
     OPTIONAL MATCH (s)-[:IMPLEMENTED_BY]->(b:BshScript {repoId: $repoId})
     WHERE (s.name IN $services OR e.name IN $entities OR b.path IN $scripts)
     RETURN s.name AS service,
            collect(distinct e.name) AS entities,
            collect(distinct b.path) AS scripts`,
    { repoId, services, entities, scripts },
  );

  const relations = new Set<string>();
  for (const record of records) {
    const service = record.get("service") as string | undefined;
    const entitiesArr = toStringArray(record.get("entities"));
    const scriptsArr = toStringArray(record.get("scripts"));
    if (!service) continue;
    if (entitiesArr.length === 0 && scriptsArr.length === 0) {
      continue;
    }
    for (const entity of entitiesArr.length ? entitiesArr : [undefined]) {
      for (const script of scriptsArr.length ? scriptsArr : [undefined]) {
        if (entity && script) {
          relations.add(`Service ${service} uses Entity ${entity} and is implemented by ${script}`);
        } else if (entity) {
          relations.add(`Service ${service} uses Entity ${entity}`);
        } else if (script) {
          relations.add(`Service ${service} is implemented by ${script}`);
        }
      }
    }
  }

  return toSorted(relations);
}

export async function buildDomainFactsIndex(
  repoId: string,
  diffFiles: DiffFile[],
  profile?: RepoStrategyProfile | null,
  options?: { skipGraph?: boolean },
): Promise<DomainFactsIndex> {
  if (options?.skipGraph || !isOfbizProfile(profile)) {
    return { byFile: new Map(), prFacts: {} };
  }

  const byFile = new Map<string, FileDomainFacts>();
  for (const diffFile of diffFiles) {
    const facts = await getFileDomainFacts(repoId, diffFile.path, profile);
    if (facts.entities || facts.services || facts.templates || facts.scripts || facts.relations) {
      byFile.set(diffFile.path, facts);
    }
  }

  const prFacts = aggregateFacts(byFile);
  const crossRelations = await buildCrossRelations(repoId, prFacts);
  if (crossRelations.length > 0) {
    prFacts.relations = prFacts.relations
      ? toSorted(new Set([...prFacts.relations, ...crossRelations]))
      : crossRelations;
  }

  return { byFile, prFacts };
}

export async function getPrDomainFacts(
  repoId: string,
  diffFiles: DiffFile[],
  profile?: RepoStrategyProfile | null,
  options?: { skipGraph?: boolean },
): Promise<PrDomainFacts> {
  const index = await buildDomainFactsIndex(repoId, diffFiles, profile, options);
  return index.prFacts;
}
