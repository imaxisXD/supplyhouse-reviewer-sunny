import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../../config/logger.ts";
import { runCypher } from "../../db/memgraph.ts";
import type { ParsedFile } from "../parsers/base.ts";
import type { CodeSnippet } from "../embedding-generator.ts";
import { ALWAYS_EXCLUDE, MAX_FILE_SIZE, PARSEABLE_EXTENSIONS } from "../source-collector.ts";

const log = createLogger("ofbiz-indexing");

const COMPONENT_PREFIXES = ["applications", "hot-deploy", "framework", "specialpurpose"];

export interface OfbizFileSet {
  codeFiles: string[];
  ftlFiles: string[];
  jsFiles: string[];
  bshFiles: string[];
  componentFiles: string[];
  controllerFiles: string[];
  screenFiles: string[];
  formFiles: string[];
  serviceFiles: string[];
  entityFiles: string[];
}

export interface OfbizComponent {
  name: string;
  file: string;
  webapps: OfbizWebapp[];
  serviceResources: string[];
  entityResources: string[];
}

export interface OfbizWebapp {
  name: string;
  file: string;
  location?: string;
  contextRoot?: string;
  mountPoint?: string;
}

export interface OfbizController {
  name: string;
  file: string;
  requestMaps: OfbizRequestMap[];
  viewMaps: OfbizViewMap[];
}

export interface OfbizRequestMap {
  name: string;
  file: string;
  viewNames: string[];
}

export interface OfbizViewMap {
  name: string;
  file: string;
  page?: string;
  type?: string;
  resolvedPage?: string;
  screenName?: string;
}

export interface OfbizFormRef {
  name: string;
  file?: string;
}

export interface OfbizScreen {
  name: string;
  file: string;
  line: number;
  includeForms: OfbizFormRef[];
  includeTemplates: string[];
}

export interface OfbizForm {
  name: string;
  file: string;
  line: number;
  services: string[];
  entities: string[];
}

export interface OfbizService {
  name: string;
  file: string;
  line: number;
  engine?: string;
  location?: string;
  resolvedLocation?: string;
  invoke?: string;
  defaultEntity?: string;
}

export interface OfbizEntity {
  name: string;
  file: string;
  line: number;
}

export interface OfbizTemplate {
  path: string;
  file: string;
  includes: string[];
}

export interface OfbizBshScript {
  path: string;
  file: string;
}

export interface OfbizJsFile {
  path: string;
  file: string;
}

export interface OfbizData {
  components: OfbizComponent[];
  controllers: OfbizController[];
  screens: OfbizScreen[];
  forms: OfbizForm[];
  services: OfbizService[];
  entities: OfbizEntity[];
  templates: OfbizTemplate[];
  bshScripts: OfbizBshScript[];
  jsFiles: OfbizJsFile[];
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isCodeExtension(ext: string): boolean {
  return PARSEABLE_EXTENSIONS.has(ext);
}

function classifyXmlFile(filePath: string):
  | "component"
  | "controller"
  | "screen"
  | "form"
  | "service"
  | "entity"
  | null {
  const base = path.basename(filePath).toLowerCase();
  if (base === "ofbiz-component.xml") return "component";
  if (base === "controller.xml") return "controller";
  if (base.endsWith("screens.xml")) return "screen";
  if (base.endsWith("forms.xml")) return "form";
  if (base.startsWith("services") && base.endsWith(".xml")) return "service";
  if (base.includes("entitymodel") && base.endsWith(".xml")) return "entity";
  return null;
}

function shouldSkipDir(name: string, excludePatterns: Set<string>): boolean {
  return excludePatterns.has(name) || ALWAYS_EXCLUDE.has(name);
}

function addFile(set: OfbizFileSet, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xml") {
    const kind = classifyXmlFile(filePath);
    if (kind === "component") set.componentFiles.push(filePath);
    else if (kind === "controller") set.controllerFiles.push(filePath);
    else if (kind === "screen") set.screenFiles.push(filePath);
    else if (kind === "form") set.formFiles.push(filePath);
    else if (kind === "service") set.serviceFiles.push(filePath);
    else if (kind === "entity") set.entityFiles.push(filePath);
    return;
  }

  if (ext === ".bsh") {
    set.bshFiles.push(filePath);
    return;
  }

  if (ext === ".ftl") {
    set.ftlFiles.push(filePath);
  }

  if (ext === ".js") {
    set.jsFiles.push(filePath);
  }

  if (isCodeExtension(ext)) {
    set.codeFiles.push(filePath);
  }
}

function createFileSet(): OfbizFileSet {
  return {
    codeFiles: [],
    ftlFiles: [],
    jsFiles: [],
    bshFiles: [],
    componentFiles: [],
    controllerFiles: [],
    screenFiles: [],
    formFiles: [],
    serviceFiles: [],
    entityFiles: [],
  };
}

export function collectOfbizFiles(
  repoPath: string,
  excludePatterns: Set<string>,
  incremental: boolean,
  changedFiles?: string[],
): OfbizFileSet {
  if (incremental && changedFiles && changedFiles.length > 0) {
    const fileSet = createFileSet();
    for (const rel of changedFiles) {
      const relPath = toPosixPath(rel.trim());
      if (!relPath) continue;
      const abs = path.join(repoPath, relPath);
      if (!fs.existsSync(abs)) continue;
      addFile(fileSet, abs);
    }
    return fileSet;
  }

  const fileSet = createFileSet();
  const stack: string[] = [repoPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, excludePatterns)) continue;
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".xml" && ext !== ".bsh" && !isCodeExtension(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }
      addFile(fileSet, fullPath);
    }
  }

  return fileSet;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(tag))) {
    const key = match[1];
    const value = match[2] ?? "";
    if (key) attrs[key] = value;
  }
  const singleRegex = /([A-Za-z_][\w.-]*)\s*=\s*'([^']*)'/g;
  while ((match = singleRegex.exec(tag))) {
    const key = match[1];
    const value = match[2] ?? "";
    if (key) attrs[key] = value;
  }
  return attrs;
}

function findTagAttributes(content: string, tagName: string): Record<string, string>[] {
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const attrs: Record<string, string>[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(content))) {
    attrs.push(parseAttributes(match[0]));
  }
  return attrs;
}

function resolveComponentPath(repoPath: string, location: string): string {
  const trimmed = location.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith("component://")) {
    const withoutPrefix = trimmed.replace(/^component:\/\//, "");
    const parts = withoutPrefix.split("/").filter(Boolean);
    const componentName = parts.shift();
    const rest = parts.join("/");
    if (componentName) {
      for (const prefix of COMPONENT_PREFIXES) {
        const candidate = path.join(repoPath, prefix, componentName, rest);
        if (fs.existsSync(candidate)) {
          return toPosixPath(path.relative(repoPath, candidate));
        }
      }
      const fallback = path.join(componentName, rest);
      return toPosixPath(fallback);
    }
  }

  if (trimmed.startsWith("file:")) {
    const withoutPrefix = trimmed.replace(/^file:\/\/*/, "");
    const candidate = path.isAbsolute(withoutPrefix)
      ? withoutPrefix
      : path.join(repoPath, withoutPrefix);
    return toPosixPath(path.relative(repoPath, candidate));
  }

  if (trimmed.startsWith("/")) {
    const candidate = path.join(repoPath, trimmed.replace(/^\/+/, ""));
    return toPosixPath(path.relative(repoPath, candidate));
  }

  return toPosixPath(trimmed);
}

function resolveRelativePath(repoPath: string, baseFile: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("component://") || trimmed.startsWith("file:") || trimmed.startsWith("/")) {
    return resolveComponentPath(repoPath, trimmed);
  }
  const baseDir = path.dirname(path.join(repoPath, baseFile));
  const candidate = path.join(baseDir, trimmed);
  return toPosixPath(path.relative(repoPath, candidate));
}

function extractFirstAttr(attrs: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (attrs[key]) return attrs[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OFBiz XML parsing
// ---------------------------------------------------------------------------

export function parseOfbizFiles(repoPath: string, fileSet: OfbizFileSet): OfbizData {
  const components: OfbizComponent[] = [];
  const controllers: OfbizController[] = [];
  const screens: OfbizScreen[] = [];
  const forms: OfbizForm[] = [];
  const services: OfbizService[] = [];
  const entities: OfbizEntity[] = [];
  const templates: OfbizTemplate[] = [];
  const bshScripts: OfbizBshScript[] = [];
  const jsFiles: OfbizJsFile[] = [];

  const templateMap = new Map<string, OfbizTemplate>();

  for (const filePath of fileSet.bshFiles) {
    const rel = toPosixPath(path.relative(repoPath, filePath));
    bshScripts.push({ path: rel, file: rel });
  }

  for (const filePath of fileSet.jsFiles) {
    const rel = toPosixPath(path.relative(repoPath, filePath));
    jsFiles.push({ path: rel, file: rel });
  }

  for (const filePath of fileSet.componentFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const rootAttrs = findTagAttributes(content, "ofbiz-component")[0] ?? {};
    const componentName = rootAttrs.name ?? path.basename(path.dirname(filePath));
    const webapps: OfbizWebapp[] = [];
    const serviceResources: string[] = [];
    const entityResources: string[] = [];

    for (const attrs of findTagAttributes(content, "webapp")) {
      const name = attrs.name ?? attrs["webapp-name"] ?? "webapp";
      const location = attrs.location ? resolveComponentPath(repoPath, attrs.location) : undefined;
      webapps.push({
        name,
        file: rel,
        location,
        contextRoot: attrs["context-root"],
        mountPoint: attrs["mount-point"],
      });
    }

    for (const attrs of findTagAttributes(content, "service-resource")) {
      if (attrs.location) {
        serviceResources.push(resolveComponentPath(repoPath, attrs.location));
      }
    }

    for (const attrs of findTagAttributes(content, "entity-resource")) {
      if (attrs.location) {
        entityResources.push(resolveComponentPath(repoPath, attrs.location));
      }
    }

    components.push({
      name: componentName,
      file: rel,
      webapps,
      serviceResources,
      entityResources,
    });
  }

  for (const filePath of fileSet.controllerFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const controllerName = rel;
    const requestMaps: OfbizRequestMap[] = [];
    const viewMaps: OfbizViewMap[] = [];

    const requestBlockRegex = /<request-map\b[^>]*>[\s\S]*?<\/request-map>/gi;
    let blockMatch: RegExpExecArray | null = null;
    while ((blockMatch = requestBlockRegex.exec(content))) {
      const block = blockMatch[0];
      const openTag = block.match(/<request-map\b[^>]*>/i)?.[0] ?? "";
      const attrs = parseAttributes(openTag);
      const name = extractFirstAttr(attrs, ["uri", "name"]) ?? "request";
      const viewNames: string[] = [];
      const directView = attrs["view-map"] ?? attrs["view-map-name"];
      if (directView) viewNames.push(directView);
      const responseRegex = /<response\b[^>]*>/gi;
      let responseMatch: RegExpExecArray | null = null;
      while ((responseMatch = responseRegex.exec(block))) {
        const responseAttrs = parseAttributes(responseMatch[0]);
        if (responseAttrs.type && responseAttrs.type !== "view") continue;
        const value = responseAttrs.value ?? responseAttrs.name;
        if (value) viewNames.push(value);
      }
      requestMaps.push({ name, file: rel, viewNames });
    }

    const requestSelfRegex = /<request-map\b[^>]*\/>/gi;
    while ((blockMatch = requestSelfRegex.exec(content))) {
      const attrs = parseAttributes(blockMatch[0]);
      const name = extractFirstAttr(attrs, ["uri", "name"]);
      if (name) {
        const viewName = attrs["view-map"] ?? attrs["view-map-name"];
        const viewNames = viewName ? [viewName] : [];
        requestMaps.push({ name, file: rel, viewNames });
      }
    }

    for (const attrs of findTagAttributes(content, "view-map")) {
      const name = attrs.name ?? "view";
      const rawPage = attrs.page;
      let resolvedPage: string | undefined;
      let screenName: string | undefined;
      if (rawPage) {
        if (rawPage.includes("#")) {
          const [rawPath, screen] = rawPage.split("#");
          resolvedPage = resolveComponentPath(repoPath, rawPath);
          screenName = screen;
        } else if (rawPage.endsWith(".ftl") || rawPage.endsWith(".xml")) {
          resolvedPage = resolveComponentPath(repoPath, rawPage);
        }
      }
      viewMaps.push({
        name,
        file: rel,
        page: rawPage,
        type: attrs.type,
        resolvedPage,
        screenName,
      });
    }

    controllers.push({ name: controllerName, file: rel, requestMaps, viewMaps });
  }

  for (const filePath of fileSet.screenFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const lines = content.split(/\r?\n/);
    const screenStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("<screen ")) {
        const attrs = parseAttributes(line);
        const name = attrs.name;
        if (name) {
          screens.push({
            name,
            file: rel,
            line: i + 1,
            includeForms: [],
            includeTemplates: [],
          });
          screenStack.push(name);
        }
      }

      if (line.includes("</screen")) {
        screenStack.pop();
      }

      const currentScreen = screenStack[screenStack.length - 1];
      if (!currentScreen) continue;

      if (line.includes("include-form")) {
        const attrs = parseAttributes(line);
        const formName = attrs.name ?? attrs["form-name"];
        if (formName) {
          const target = screens.find((s) => s.name === currentScreen && s.file === rel);
          if (target) {
            const location = attrs.location ? resolveComponentPath(repoPath, attrs.location) : undefined;
            target.includeForms.push({ name: formName, file: location });
          }
        }
      }

      if (line.includes("include-template")) {
        const attrs = parseAttributes(line);
        const templatePath = attrs.location || attrs.name;
        if (templatePath) {
          const resolved = resolveRelativePath(repoPath, rel, templatePath);
          const target = screens.find((s) => s.name === currentScreen && s.file === rel);
          if (target) {
            target.includeTemplates.push(resolved);
          }
        }
      }
    }
  }

  for (const filePath of fileSet.formFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const lines = content.split(/\r?\n/);
    const formStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("<form ")) {
        const attrs = parseAttributes(line);
        const name = attrs.name;
        if (name) {
          forms.push({ name, file: rel, line: i + 1, services: [], entities: [] });
          formStack.push(name);
        }
      }

      if (line.includes("</form")) {
        formStack.pop();
      }

      const currentForm = formStack[formStack.length - 1];
      if (!currentForm) continue;

      if (line.includes("<service")) {
        const attrs = parseAttributes(line);
        const serviceName = attrs["service-name"] ?? attrs.name;
        if (serviceName) {
          const target = forms.find((f) => f.name === currentForm && f.file === rel);
          if (target) target.services.push(serviceName);
        }
      }

      if (line.includes("entity-name")) {
        const attrs = parseAttributes(line);
        const entityName = attrs["entity-name"];
        if (entityName) {
          const target = forms.find((f) => f.name === currentForm && f.file === rel);
          if (target) target.entities.push(entityName);
        }
      }
    }
  }

  for (const filePath of fileSet.serviceFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.includes("<service")) continue;
      const attrs = parseAttributes(line);
      const name = attrs.name ?? attrs["service-name"];
      if (!name) continue;
      const rawLocation = attrs.location;
      const resolvedLocation = rawLocation ? resolveComponentPath(repoPath, rawLocation) : undefined;
      services.push({
        name,
        file: rel,
        line: i + 1,
        engine: attrs.engine,
        location: rawLocation,
        resolvedLocation,
        invoke: attrs.invoke,
        defaultEntity: attrs["default-entity-name"] ?? attrs["entity-name"],
      });
    }
  }

  for (const filePath of fileSet.entityFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.includes("<entity")) continue;
      const attrs = parseAttributes(line);
      const name = attrs["entity-name"] ?? attrs.name;
      if (!name) continue;
      entities.push({ name, file: rel, line: i + 1 });
    }
  }

  for (const filePath of fileSet.ftlFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const rel = toPosixPath(path.relative(repoPath, filePath));
    const includeRegex = /<#(include|import)\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null = null;
    const includes: string[] = [];
    while ((match = includeRegex.exec(content))) {
      const raw = match[2] ?? "";
      if (!raw) continue;
      const resolved = resolveRelativePath(repoPath, rel, raw);
      includes.push(resolved);
    }
    const template: OfbizTemplate = { path: rel, file: rel, includes };
    templates.push(template);
    templateMap.set(rel, template);

    for (const inc of includes) {
      if (!templateMap.has(inc)) {
        templateMap.set(inc, { path: inc, file: inc, includes: [] });
      }
    }
  }

  for (const template of templateMap.values()) {
    if (!templates.find((t) => t.path === template.path)) {
      templates.push(template);
    }
  }

  return {
    components,
    controllers,
    screens,
    forms,
    services,
    entities,
    templates,
    bshScripts,
    jsFiles,
  };
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

const BATCH_SIZE = 200;

async function safeRunCypher(query: string): Promise<void> {
  try {
    await runCypher(query);
  } catch {
    // ignore
  }
}

async function batchMerge(query: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await runCypher(query, { batch });
  }
}

export async function buildOfbizGraph(repoId: string, data: OfbizData): Promise<void> {
  await safeRunCypher("CREATE INDEX ON :Component(name)");
  await safeRunCypher("CREATE INDEX ON :Webapp(name)");
  await safeRunCypher("CREATE INDEX ON :Controller(name)");
  await safeRunCypher("CREATE INDEX ON :RequestMap(name)");
  await safeRunCypher("CREATE INDEX ON :ViewMap(name)");
  await safeRunCypher("CREATE INDEX ON :Screen(name)");
  await safeRunCypher("CREATE INDEX ON :Form(name)");
  await safeRunCypher("CREATE INDEX ON :Service(name)");
  await safeRunCypher("CREATE INDEX ON :Entity(name)");
  await safeRunCypher("CREATE INDEX ON :TemplateFTL(path)");
  await safeRunCypher("CREATE INDEX ON :BshScript(path)");
  await safeRunCypher("CREATE INDEX ON :JSFile(path)");

  const componentRows = data.components.map((c) => ({
    name: c.name,
    file: c.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (c:Component {name: row.name, file: row.file, repoId: row.repoId})`,
    componentRows,
  );

  const webappRows = data.components.flatMap((c) =>
    c.webapps.map((w) => ({
      name: w.name,
      file: w.file,
      repoId,
      location: w.location,
      contextRoot: w.contextRoot,
      mountPoint: w.mountPoint,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (w:Webapp {name: row.name, file: row.file, repoId: row.repoId})
     SET w.location = row.location,
         w.contextRoot = row.contextRoot,
         w.mountPoint = row.mountPoint`,
    webappRows,
  );

  const controllerRows = data.controllers.map((c) => ({
    name: c.name,
    file: c.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (c:Controller {name: row.name, file: row.file, repoId: row.repoId})`,
    controllerRows,
  );

  const requestRows = data.controllers.flatMap((c) =>
    c.requestMaps.map((r) => ({
      name: r.name,
      file: r.file,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (r:RequestMap {name: row.name, file: row.file, repoId: row.repoId})`,
    requestRows,
  );

  const viewRows = data.controllers.flatMap((c) =>
    c.viewMaps.map((v) => ({
      name: v.name,
      file: v.file,
      repoId,
      page: v.page,
      viewType: v.type,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (v:ViewMap {name: row.name, file: row.file, repoId: row.repoId})
     SET v.page = row.page,
         v.viewType = row.viewType`,
    viewRows,
  );

  const screenRows = data.screens.map((s) => ({
    name: s.name,
    file: s.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (s:Screen {name: row.name, file: row.file, repoId: row.repoId})`,
    screenRows,
  );

  const formRows = data.forms.map((f) => ({
    name: f.name,
    file: f.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (f:Form {name: row.name, file: row.file, repoId: row.repoId})`,
    formRows,
  );

  const serviceRows = data.services.map((s) => ({
    name: s.name,
    file: s.file,
    repoId,
    engine: s.engine,
    location: s.location,
    invoke: s.invoke,
    defaultEntity: s.defaultEntity,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (s:Service {name: row.name, file: row.file, repoId: row.repoId})
     SET s.engine = row.engine,
         s.location = row.location,
         s.invoke = row.invoke,
         s.defaultEntity = row.defaultEntity`,
    serviceRows,
  );

  const entityRows = data.entities.map((e) => ({
    name: e.name,
    file: e.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (e:Entity {name: row.name, file: row.file, repoId: row.repoId})`,
    entityRows,
  );

  const templateRows = data.templates.map((t) => ({
    path: t.path,
    file: t.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (t:TemplateFTL {path: row.path, repoId: row.repoId})
     SET t.file = row.file`,
    templateRows,
  );

  const bshRows = data.bshScripts.map((b) => ({
    path: b.path,
    file: b.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (b:BshScript {path: row.path, repoId: row.repoId})
     SET b.file = row.file`,
    bshRows,
  );

  const jsRows = data.jsFiles.map((j) => ({
    path: j.path,
    file: j.file,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (j:JSFile {path: row.path, repoId: row.repoId})
     SET j.file = row.file`,
    jsRows,
  );

  // Component -> Webapp
  const componentWebappEdges = data.components.flatMap((c) =>
    c.webapps.map((w) => ({
      componentName: c.name,
      componentFile: c.file,
      webappName: w.name,
      webappFile: w.file,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Component {name: row.componentName, file: row.componentFile, repoId: row.repoId})
     MATCH (w:Webapp {name: row.webappName, file: row.webappFile, repoId: row.repoId})
     MERGE (c)-[:DECLARES]->(w)`,
    componentWebappEdges,
  );

  // Component -> Service / Entity via resource files
  const servicesByFile = new Map<string, string[]>();
  for (const service of data.services) {
    const list = servicesByFile.get(service.file) ?? [];
    list.push(service.name);
    servicesByFile.set(service.file, list);
  }
  const entitiesByFile = new Map<string, string[]>();
  for (const entity of data.entities) {
    const list = entitiesByFile.get(entity.file) ?? [];
    list.push(entity.name);
    entitiesByFile.set(entity.file, list);
  }

  const componentServiceEdges: Record<string, unknown>[] = [];
  const componentEntityEdges: Record<string, unknown>[] = [];

  for (const component of data.components) {
    for (const serviceFile of component.serviceResources) {
      const servicesInFile = servicesByFile.get(serviceFile) ?? [];
      for (const serviceName of servicesInFile) {
        componentServiceEdges.push({
          componentName: component.name,
          componentFile: component.file,
          serviceName,
          serviceFile,
          repoId,
        });
      }
    }
    for (const entityFile of component.entityResources) {
      const entitiesInFile = entitiesByFile.get(entityFile) ?? [];
      for (const entityName of entitiesInFile) {
        componentEntityEdges.push({
          componentName: component.name,
          componentFile: component.file,
          entityName,
          entityFile,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Component {name: row.componentName, file: row.componentFile, repoId: row.repoId})
     MATCH (s:Service {name: row.serviceName, file: row.serviceFile, repoId: row.repoId})
     MERGE (c)-[:DECLARES]->(s)`,
    componentServiceEdges,
  );

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Component {name: row.componentName, file: row.componentFile, repoId: row.repoId})
     MATCH (e:Entity {name: row.entityName, file: row.entityFile, repoId: row.repoId})
     MERGE (c)-[:DECLARES]->(e)`,
    componentEntityEdges,
  );

  // Webapp -> Controller (match controller path under webapp location)
  const webappControllerEdges: Record<string, unknown>[] = [];
  for (const component of data.components) {
    for (const webapp of component.webapps) {
      if (!webapp.location) continue;
      const location = webapp.location;
      for (const controller of data.controllers) {
        if (controller.file.startsWith(location)) {
          webappControllerEdges.push({
            webappName: webapp.name,
            webappFile: webapp.file,
            controllerName: controller.name,
            controllerFile: controller.file,
            repoId,
          });
        }
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (w:Webapp {name: row.webappName, file: row.webappFile, repoId: row.repoId})
     MATCH (c:Controller {name: row.controllerName, file: row.controllerFile, repoId: row.repoId})
     MERGE (w)-[:HAS]->(c)`,
    webappControllerEdges,
  );

  // Controller -> RequestMap
  const controllerRequestEdges = data.controllers.flatMap((c) =>
    c.requestMaps.map((r) => ({
      controllerName: c.name,
      controllerFile: c.file,
      requestName: r.name,
      requestFile: r.file,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Controller {name: row.controllerName, file: row.controllerFile, repoId: row.repoId})
     MATCH (r:RequestMap {name: row.requestName, file: row.requestFile, repoId: row.repoId})
     MERGE (c)-[:HAS]->(r)`,
    controllerRequestEdges,
  );

  // RequestMap -> ViewMap
  const requestViewEdges: Record<string, unknown>[] = [];
  for (const controller of data.controllers) {
    for (const request of controller.requestMaps) {
      for (const viewName of request.viewNames) {
        requestViewEdges.push({
          requestName: request.name,
          requestFile: request.file,
          viewName,
          viewFile: controller.file,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (r:RequestMap {name: row.requestName, file: row.requestFile, repoId: row.repoId})
     MATCH (v:ViewMap {name: row.viewName, file: row.viewFile, repoId: row.repoId})
     MERGE (r)-[:ROUTES_TO]->(v)`,
    requestViewEdges,
  );

  // ViewMap -> Screen / Template
  const viewScreenEdges: Record<string, unknown>[] = [];
  const viewTemplateEdges: Record<string, unknown>[] = [];
  for (const controller of data.controllers) {
    for (const view of controller.viewMaps) {
      if (view.screenName && view.resolvedPage) {
        viewScreenEdges.push({
          viewName: view.name,
          viewFile: view.file,
          screenName: view.screenName,
          screenFile: view.resolvedPage,
          repoId,
        });
      } else if (view.resolvedPage && view.resolvedPage.endsWith(".ftl")) {
        viewTemplateEdges.push({
          viewName: view.name,
          viewFile: view.file,
          templatePath: view.resolvedPage,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (v:ViewMap {name: row.viewName, file: row.viewFile, repoId: row.repoId})
     MATCH (s:Screen {name: row.screenName, repoId: row.repoId})
     WHERE s.file = row.screenFile OR row.screenFile = ""
     MERGE (v)-[:RENDERS]->(s)`,
    viewScreenEdges,
  );

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (v:ViewMap {name: row.viewName, file: row.viewFile, repoId: row.repoId})
     MATCH (t:TemplateFTL {path: row.templatePath, repoId: row.repoId})
     MERGE (v)-[:RENDERS]->(t)`,
    viewTemplateEdges,
  );

  // Screen -> Form / Template
  const screenFormEdges: Record<string, unknown>[] = [];
  const screenTemplateEdges: Record<string, unknown>[] = [];
  for (const screen of data.screens) {
    for (const formRef of screen.includeForms) {
      screenFormEdges.push({
        screenName: screen.name,
        screenFile: screen.file,
        formName: formRef.name,
        formFile: formRef.file ?? "",
        repoId,
      });
    }
    for (const templatePath of screen.includeTemplates) {
      screenTemplateEdges.push({
        screenName: screen.name,
        screenFile: screen.file,
        templatePath,
        repoId,
      });
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (s:Screen {name: row.screenName, file: row.screenFile, repoId: row.repoId})
     MATCH (f:Form {name: row.formName, repoId: row.repoId})
     WHERE row.formFile = "" OR f.file = row.formFile
     MERGE (s)-[:INCLUDES_FORM]->(f)`,
    screenFormEdges,
  );

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (s:Screen {name: row.screenName, file: row.screenFile, repoId: row.repoId})
     MATCH (t:TemplateFTL {path: row.templatePath, repoId: row.repoId})
     MERGE (s)-[:INCLUDES_TEMPLATE]->(t)`,
    screenTemplateEdges,
  );

  // Form -> Service / Entity
  const formServiceEdges = data.forms.flatMap((f) =>
    f.services.map((serviceName) => ({
      formName: f.name,
      formFile: f.file,
      serviceName,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (f:Form {name: row.formName, file: row.formFile, repoId: row.repoId})
     MATCH (s:Service {name: row.serviceName, repoId: row.repoId})
     MERGE (f)-[:CALLS_SERVICE]->(s)`,
    formServiceEdges,
  );

  const formEntityEdges = data.forms.flatMap((f) =>
    f.entities.map((entityName) => ({
      formName: f.name,
      formFile: f.file,
      entityName,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (f:Form {name: row.formName, file: row.formFile, repoId: row.repoId})
     MATCH (e:Entity {name: row.entityName, repoId: row.repoId})
     MERGE (f)-[:USES_ENTITY]->(e)`,
    formEntityEdges,
  );

  // Service -> Entity
  const serviceEntityEdges = data.services
    .filter((s) => s.defaultEntity)
    .map((s) => ({
      serviceName: s.name,
      serviceFile: s.file,
      entityName: s.defaultEntity ?? "",
      repoId,
    }));
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (s:Service {name: row.serviceName, file: row.serviceFile, repoId: row.repoId})
     MATCH (e:Entity {name: row.entityName, repoId: row.repoId})
     MERGE (s)-[:USES_ENTITY]->(e)`,
    serviceEntityEdges,
  );

  // Service -> JavaMethod / BshScript
  const serviceJavaEdges: Record<string, unknown>[] = [];
  const serviceBshEdges: Record<string, unknown>[] = [];

  for (const service of data.services) {
    const engine = service.engine?.toLowerCase();
    const location = service.resolvedLocation ?? "";
    if (engine === "java" && service.invoke && location) {
      const className = path.basename(location).replace(/\.java$/i, "");
      if (className) {
        serviceJavaEdges.push({
          serviceName: service.name,
          serviceFile: service.file,
          methodName: `${className}.${service.invoke}`,
          repoId,
        });
      }
    }
    if (engine === "bsh" || (service.location && service.location.endsWith(".bsh"))) {
      const scriptPath = location || "";
      if (scriptPath) {
        serviceBshEdges.push({
          serviceName: service.name,
          serviceFile: service.file,
          scriptPath,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (s:Service {name: row.serviceName, file: row.serviceFile, repoId: row.repoId})
     MATCH (m:Function {name: row.methodName, repoId: row.repoId})
     MERGE (s)-[:IMPLEMENTED_BY]->(m)`,
    serviceJavaEdges,
  );

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (s:Service {name: row.serviceName, file: row.serviceFile, repoId: row.repoId})
     MATCH (b:BshScript {path: row.scriptPath, repoId: row.repoId})
     MERGE (s)-[:IMPLEMENTED_BY]->(b)`,
    serviceBshEdges,
  );

  // Template includes
  const templateEdges = data.templates.flatMap((t) =>
    t.includes.map((inc) => ({
      templatePath: t.path,
      includePath: inc,
      repoId,
    })),
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (t:TemplateFTL {path: row.templatePath, repoId: row.repoId})
     MATCH (i:TemplateFTL {path: row.includePath, repoId: row.repoId})
     MERGE (t)-[:INCLUDES]->(i)`,
    templateEdges,
  );

  log.info({ repoId }, "OFBiz graph built");
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

export function extractOfbizSnippets(repoPath: string, data: OfbizData): CodeSnippet[] {
  const snippets: CodeSnippet[] = [];

  for (const service of data.services) {
    const lines = [
      `service ${service.name}`,
      service.engine ? `engine: ${service.engine}` : "",
      service.location ? `location: ${service.location}` : "",
      service.invoke ? `invoke: ${service.invoke}` : "",
      service.defaultEntity ? `entity: ${service.defaultEntity}` : "",
    ].filter(Boolean);
    snippets.push({
      name: `service:${service.name}`,
      code: lines.join("\n"),
      file: service.file,
      startLine: service.line,
      endLine: service.line,
    });
  }

  for (const screen of data.screens) {
    const forms = screen.includeForms.map((f) => f.name).join(", ");
    const templates = screen.includeTemplates.join(", ");
    const lines = [
      `screen ${screen.name}`,
      forms ? `forms: ${forms}` : "",
      templates ? `templates: ${templates}` : "",
    ].filter(Boolean);
    snippets.push({
      name: `screen:${screen.name}`,
      code: lines.join("\n"),
      file: screen.file,
      startLine: screen.line,
      endLine: screen.line,
    });
  }

  for (const form of data.forms) {
    const services = form.services.join(", ");
    const entities = form.entities.join(", ");
    const lines = [
      `form ${form.name}`,
      services ? `services: ${services}` : "",
      entities ? `entities: ${entities}` : "",
    ].filter(Boolean);
    snippets.push({
      name: `form:${form.name}`,
      code: lines.join("\n"),
      file: form.file,
      startLine: form.line,
      endLine: form.line,
    });
  }

  for (const template of data.templates) {
    const filePath = path.join(repoPath, template.path);
    const content = readFileSafe(filePath);
    const includes = template.includes.length > 0 ? `includes: ${template.includes.join(", ")}` : "";
    const text = [
      `template ${path.basename(template.path)}`,
      includes,
      content.slice(0, 4000),
    ].filter(Boolean).join("\n");
    snippets.push({
      name: `template:${path.basename(template.path)}`,
      code: text,
      file: template.file,
      startLine: 1,
      endLine: Math.max(1, content.split(/\r?\n/).length),
    });
  }

  for (const script of data.bshScripts) {
    const filePath = path.join(repoPath, script.path);
    const content = readFileSafe(filePath);
    snippets.push({
      name: `bsh:${path.basename(script.path)}`,
      code: content.slice(0, 8000),
      file: script.file,
      startLine: 1,
      endLine: Math.max(1, content.split(/\r?\n/).length),
    });
  }

  return snippets;
}

export async function tagJavaNodes(repoId: string, parsedFiles: ParsedFile[]): Promise<void> {
  const classRows: Record<string, unknown>[] = [];
  const methodRows: Record<string, unknown>[] = [];

  for (const file of parsedFiles) {
    if (file.language !== "java") continue;
    for (const cls of file.classes) {
      classRows.push({ name: cls.name, file: file.filePath, repoId });
      for (const method of cls.methods) {
        methodRows.push({
          name: `${cls.name}.${method.name}`,
          file: file.filePath,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Class {name: row.name, file: row.file, repoId: row.repoId})
     SET c:JavaClass`,
    classRows,
  );

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (f:Function {name: row.name, file: row.file, repoId: row.repoId})
     SET f:JavaMethod`,
    methodRows,
  );
}

export function buildOfbizSnippets(repoPath: string, data: OfbizData): CodeSnippet[] {
  return extractOfbizSnippets(repoPath, data);
}

export function isOfbizRepo(repoId: string): boolean {
  return repoId.toLowerCase().includes("supplyhouse");
}
