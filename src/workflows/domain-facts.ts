import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { runCypher } from "../db/memgraph.ts";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "../tools/repo-context.ts";
import { getRepoStrategyProfile } from "../utils/repo-meta.ts";
import { getFileDomainFacts, type FileDomainFacts } from "../review/domain-facts.ts";

const DomainFactsInput = z.object({
  repoId: z.string().optional(),
  filePath: z.string().optional(),
  entityName: z.string().optional(),
  serviceName: z.string().optional(),
  templatePath: z.string().optional(),
  scriptPath: z.string().optional(),
});

const DomainFactsOutput = z.object({
  summary: z.string(),
  facts: z.object({
    entities: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    templates: z.array(z.string()).optional(),
    scripts: z.array(z.string()).optional(),
    relations: z.array(z.string()).optional(),
  }).optional(),
});

const log = createLogger("workflow:domain-facts");

async function safeRunCypher(query: string, params: Record<string, unknown>): Promise<ReturnType<typeof runCypher>> {
  try {
    return await runCypher(query, params);
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "Domain facts workflow query failed");
    return [];
  }
}

function formatFactsSummary(facts?: FileDomainFacts): string {
  if (!facts) return "No domain facts available.";
  const lines: string[] = [];
  if (facts.entities?.length) lines.push(`Entities: ${facts.entities.join(", ")}`);
  if (facts.services?.length) lines.push(`Services: ${facts.services.join(", ")}`);
  if (facts.templates?.length) lines.push(`Templates: ${facts.templates.join(", ")}`);
  if (facts.scripts?.length) lines.push(`Scripts: ${facts.scripts.join(", ")}`);
  if (facts.relations?.length) {
    for (const rel of facts.relations) {
      lines.push(`Relation: ${rel}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No domain facts available.";
}

async function fetchEntityFacts(repoId: string, entityName: string): Promise<FileDomainFacts> {
  const records = await safeRunCypher(
    `MATCH (e:Entity {repoId: $repoId, name: $name})
     OPTIONAL MATCH (s:Service {repoId: $repoId})-[:USES_ENTITY]->(e)
     OPTIONAL MATCH (f:Form {repoId: $repoId})-[:USES_ENTITY]->(e)
     RETURN e.name AS entity,
            collect(distinct s.name) AS services,
            collect(distinct f.name) AS forms`,
    { repoId, name: entityName },
  );
  const services = new Set<string>();
  const relations = new Set<string>();
  for (const record of records) {
    const entity = record.get("entity") as string | undefined;
    const serviceList = record.get("services");
    const formList = record.get("forms");
    const servicesArr = Array.isArray(serviceList) ? serviceList.filter((v) => typeof v === "string") as string[] : [];
    const formsArr = Array.isArray(formList) ? formList.filter((v) => typeof v === "string") as string[] : [];
    for (const service of servicesArr) {
      services.add(service);
      if (entity) relations.add(`Service ${service} uses Entity ${entity}`);
    }
    for (const form of formsArr) {
      if (entity) relations.add(`Form ${form} uses Entity ${entity}`);
    }
  }
  return {
    entities: [entityName],
    services: services.size ? Array.from(services).sort() : undefined,
    relations: relations.size ? Array.from(relations).sort() : undefined,
  };
}

async function fetchServiceFacts(repoId: string, serviceName: string): Promise<FileDomainFacts> {
  const records = await safeRunCypher(
    `MATCH (s:Service {repoId: $repoId, name: $name})
     OPTIONAL MATCH (s)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
     OPTIONAL MATCH (s)-[:IMPLEMENTED_BY]->(b:BshScript {repoId: $repoId})
     RETURN s.name AS service,
            collect(distinct e.name) AS entities,
            collect(distinct b.path) AS scripts`,
    { repoId, name: serviceName },
  );
  const entities = new Set<string>();
  const scripts = new Set<string>();
  const relations = new Set<string>();
  for (const record of records) {
    const service = record.get("service") as string | undefined;
    const entitiesArr = Array.isArray(record.get("entities")) ? record.get("entities") as string[] : [];
    const scriptsArr = Array.isArray(record.get("scripts")) ? record.get("scripts") as string[] : [];
    for (const entity of entitiesArr) {
      if (entity) entities.add(entity);
      if (service && entity) relations.add(`Service ${service} uses Entity ${entity}`);
    }
    for (const script of scriptsArr) {
      if (script) scripts.add(script);
      if (service && script) relations.add(`Service ${service} is implemented by ${script}`);
    }
  }
  return {
    services: [serviceName],
    entities: entities.size ? Array.from(entities).sort() : undefined,
    scripts: scripts.size ? Array.from(scripts).sort() : undefined,
    relations: relations.size ? Array.from(relations).sort() : undefined,
  };
}

async function fetchTemplateFacts(repoId: string, templatePath: string): Promise<FileDomainFacts> {
  const records = await safeRunCypher(
    `MATCH (t:TemplateFTL {repoId: $repoId, path: $path})
     OPTIONAL MATCH (t)-[:INCLUDES]->(inc:TemplateFTL {repoId: $repoId})
     OPTIONAL MATCH (s:Screen {repoId: $repoId})-[:INCLUDES_TEMPLATE]->(t)
     OPTIONAL MATCH (v:ViewMap {repoId: $repoId})-[:RENDERS]->(t)
     RETURN t.path AS template,
            collect(distinct inc.path) AS includes,
            collect(distinct s.name) AS screens,
            collect(distinct v.name) AS views`,
    { repoId, path: templatePath },
  );
  const relations = new Set<string>();
  for (const record of records) {
    const template = record.get("template") as string | undefined;
    const includesArr = Array.isArray(record.get("includes")) ? record.get("includes") as string[] : [];
    const screensArr = Array.isArray(record.get("screens")) ? record.get("screens") as string[] : [];
    const viewsArr = Array.isArray(record.get("views")) ? record.get("views") as string[] : [];
    for (const inc of includesArr) {
      if (template && inc) relations.add(`Template ${template} includes ${inc}`);
    }
    for (const screen of screensArr) {
      if (template && screen) relations.add(`Screen ${screen} includes template ${template}`);
    }
    for (const view of viewsArr) {
      if (template && view) relations.add(`ViewMap ${view} renders template ${template}`);
    }
  }
  return {
    templates: [templatePath],
    relations: relations.size ? Array.from(relations).sort() : undefined,
  };
}

async function fetchScriptFacts(repoId: string, scriptPath: string): Promise<FileDomainFacts> {
  const records = await safeRunCypher(
    `MATCH (b:BshScript {repoId: $repoId, path: $path})
     OPTIONAL MATCH (s:Service {repoId: $repoId})-[:IMPLEMENTED_BY]->(b)
     OPTIONAL MATCH (s)-[:USES_ENTITY]->(e:Entity {repoId: $repoId})
     RETURN b.path AS script,
            collect(distinct s.name) AS services,
            collect(distinct e.name) AS entities`,
    { repoId, path: scriptPath },
  );
  const services = new Set<string>();
  const entities = new Set<string>();
  const relations = new Set<string>();
  for (const record of records) {
    const script = record.get("script") as string | undefined;
    const servicesArr = Array.isArray(record.get("services")) ? record.get("services") as string[] : [];
    const entitiesArr = Array.isArray(record.get("entities")) ? record.get("entities") as string[] : [];
    for (const service of servicesArr) {
      if (service) services.add(service);
      if (script) relations.add(`Service ${service} is implemented by ${script}`);
      for (const entity of entitiesArr) {
        if (entity && script) relations.add(`Service ${service} uses Entity ${entity} and is implemented by ${script}`);
      }
    }
    for (const entity of entitiesArr) {
      if (entity) entities.add(entity);
    }
  }
  return {
    scripts: [scriptPath],
    services: services.size ? Array.from(services).sort() : undefined,
    entities: entities.size ? Array.from(entities).sort() : undefined,
    relations: relations.size ? Array.from(relations).sort() : undefined,
  };
}

const domainFactsStep = createStep({
  id: "domain_facts_step",
  description: "Fetches OFBiz domain facts from the code graph for a file or entity/service name.",
  inputSchema: DomainFactsInput,
  outputSchema: DomainFactsOutput,
  execute: async ({ inputData }) => {
    const repoId = inputData?.repoId ?? getRepoContext()?.repoId;
    if (!repoId) {
      return { summary: "repoId not available for domain facts lookup." };
    }

    const profile = await getRepoStrategyProfile(repoId);
    if (!profile || profile.strategyId !== "ofbiz-supplyhouse") {
      return { summary: "No OFBiz domain facts available for this repository." };
    }

    let facts: FileDomainFacts | undefined;
    if (inputData?.filePath) {
      facts = await getFileDomainFacts(repoId, inputData.filePath, profile);
    } else if (inputData?.entityName) {
      facts = await fetchEntityFacts(repoId, inputData.entityName);
    } else if (inputData?.serviceName) {
      facts = await fetchServiceFacts(repoId, inputData.serviceName);
    } else if (inputData?.templatePath) {
      facts = await fetchTemplateFacts(repoId, inputData.templatePath);
    } else if (inputData?.scriptPath) {
      facts = await fetchScriptFacts(repoId, inputData.scriptPath);
    }

    return {
      summary: formatFactsSummary(facts),
      facts,
    };
  },
});

export const domainFactsWorkflow = createWorkflow({
  id: "get_domain_facts",
  inputSchema: DomainFactsInput,
  outputSchema: DomainFactsOutput,
})
  .then(domainFactsStep)
  .commit();
