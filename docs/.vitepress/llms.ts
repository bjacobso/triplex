/**
 * Machine-readable documentation for coding agents (https://llmstxt.org).
 *
 * - `/llms.txt` indexes every guide in sidebar order with a one-line summary.
 * - `/llms-full.txt` concatenates every guide into one Markdown document.
 * - `/<page>.md` serves each page as plain Markdown, with code includes resolved.
 *
 * The same renderer backs the production build and the dev server, so links on
 * the homepage work in both.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

import type { DefaultTheme } from "vitepress";

export const siteUrl = "https://triplex.build";

const summary =
  "The database that remembers why: an embedded fact database for TypeScript back-office " +
  "systems. Every write records who made it, which versioned rules governed it, and when it was " +
  "true, so audit questions and open work become queries. Triplex is pre-1.0; install with " +
  "`npm install @triplex-build/triplex effect@4.1.1`.";

const keyFacts = `Triplex requires Effect 4 (\`effect@4.1.1\`; Effect 3 is not compatible), is ESM-only, and targets
Node.js 22+ plus modern browsers and edge runtimes for the core. In-memory and SQLite storage are
supported, PostgreSQL is a production candidate, and Cloudflare and FoundationDB are experimental
and frozen.

Coding agents modeling a back-office domain should read the modeling guide first and write through
the schema-bound \`Database\` client (\`@triplex-build/triplex/database\`), which pins and
enforces the live release on every command. Every page is
available as Markdown by appending \`.md\` to its URL. Code on the homepage and in the modeling
guide is type-checked and executed in CI.`;

interface Page {
  readonly route: string;
  readonly file: string;
  readonly title: string;
  readonly description: string;
  readonly markdown: string;
}

const routeOf = (file: string) => {
  const route = `/${file.replace(/\.md$/, "")}`;
  return route === "/index" ? "/" : route;
};

const markdownUrl = (route: string) => `${siteUrl}${route === "/" ? "/index" : route}.md`;

const frontmatter = (source: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) return { data: {} as Record<string, string>, body: source };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const field = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined) data[field[1]] = (field[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return { data, body: source.slice(match[0].length) };
};

const languageOf = (path: string) => {
  const extension = extname(path).slice(1);
  return extension === "mts" || extension === "cts" ? "ts" : extension;
};

const regionOf = (source: string, region: string | undefined) => {
  const lines = source.split("\n");
  const marker = /^\s*\/\/ #(?:end)?region\b/;
  if (region === undefined) return lines.filter((line) => !marker.test(line)).join("\n");
  const start = lines.findIndex((line) => line.trim() === `// #region ${region}`);
  const end = lines.findIndex((line) => line.trim() === `// #endregion ${region}`);
  if (start === -1 || end === -1) throw new Error(`Missing snippet region "${region}"`);
  return lines
    .slice(start + 1, end)
    .filter((line) => !marker.test(line))
    .join("\n");
};

/** Converts the small, controlled HTML vocabulary used by the homepage into Markdown. */
const htmlToMarkdown = (html: string) =>
  html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level: string, text: string) => {
      return `\n${"#".repeat(Number(level))} ${text.trim()}\n`;
    })
    .replace(/<li>([\s\S]*?)<\/li>/g, "- $1")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, "\n$1\n")
    .replace(/<br\s*\/?>/g, "; ")
    .replace(/<span[^>]*><\/span>/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");

const renderMarkdown = async (srcDir: string, file: string, body: string) => {
  const path = join(srcDir, file);
  let markdown = body;

  // `<!--@include: ./relative.md-->`
  for (const match of markdown.matchAll(/<!--@include:\s*([^>]+?)\s*-->/g)) {
    const included = await readFile(resolve(dirname(path), match[1] ?? ""), "utf8");
    markdown = markdown.replace(match[0], () => included.trim());
  }

  // `<<< @/snippets/file.ts#region` code imports, where `@` is the docs source root.
  for (const match of markdown.matchAll(/^<<< @\/([^\s#{]+)(?:#([\w-]+))?.*$/gm)) {
    const snippetPath = join(srcDir, match[1] ?? "");
    const code = regionOf(await readFile(snippetPath, "utf8"), match[2]).trim();
    markdown = markdown.replace(
      match[0],
      () => `\`\`\`${languageOf(snippetPath)}\n${code}\n\`\`\``,
    );
  }

  markdown = markdown.replace(/^```(ts|typescript)\s+check\s*$/gm, "```$1");
  if (/<(div|section|header|article|aside|nav)\b/.test(markdown)) {
    markdown = htmlToMarkdown(markdown);
  }
  // VitePress custom containers are not standard Markdown.
  markdown = markdown.replace(/^::: ?(\w+)(.*)$/gm, (_, kind: string, title: string) => {
    return `> **${(title.trim() || kind).replace(/^\w/, (c) => c.toUpperCase())}**`;
  });
  markdown = markdown.replace(/^:::$/gm, "");
  return `${markdown.trim()}\n`;
};

const firstParagraph = (markdown: string) => {
  const paragraphs = markdown
    .replace(/^#.*$/gm, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => /^[A-Z`*[]/.test(paragraph) && !paragraph.startsWith("```"));
  const text = paragraphs[0] ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
};

const loadPages = async (srcDir: string): Promise<Page[]> => {
  const files = (await readdir(srcDir, { recursive: true }))
    .filter(
      (file) =>
        file.endsWith(".md") &&
        !file.startsWith("snippets/") &&
        !file.startsWith("rfcs/") &&
        !file.startsWith("."),
    )
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const { data, body } = frontmatter(await readFile(join(srcDir, file), "utf8"));
      const markdown = await renderMarkdown(srcDir, file, body);
      const heading = /^# (.+)$/m.exec(markdown)?.[1]?.trim();
      return {
        route: routeOf(file),
        file,
        title: heading ?? data["title"] ?? file,
        description: data["description"] ?? firstParagraph(markdown),
        markdown,
      };
    }),
  );
};

const sidebarGroups = (sidebar: DefaultTheme.SidebarItem[]) =>
  sidebar.map((group) => ({
    text: group.text ?? "Guides",
    routes: (group.items ?? [])
      .map((item) => item.link)
      .filter((link): link is string => link !== undefined && link.startsWith("/")),
  }));

export const renderLlmsFiles = async (
  srcDir: string,
  sidebar: DefaultTheme.SidebarItem[],
): Promise<Map<string, string>> => {
  const pages = await loadPages(srcDir);
  const byRoute = new Map(pages.map((page) => [page.route, page]));
  const groups = sidebarGroups(sidebar);
  const listed = new Set(groups.flatMap((group) => group.routes));
  const unlisted = pages.filter((page) => page.route !== "/" && !listed.has(page.route));

  const entry = (page: Page) =>
    `- [${page.title}](${markdownUrl(page.route)})${page.description ? `: ${page.description}` : ""}`;

  const index = [`# Triplex`, "", `> ${summary}`, "", keyFacts, ""];
  const home = byRoute.get("/");
  if (home) index.push("## Overview", "", entry({ ...home, title: "Homepage" }), "");
  for (const group of groups) {
    const entries = group.routes.flatMap((route) => {
      const page = byRoute.get(route);
      return page ? [entry(page)] : [];
    });
    if (entries.length > 0) index.push(`## ${group.text}`, "", ...entries, "");
  }
  if (unlisted.length > 0) index.push("## Optional", "", ...unlisted.map(entry), "");

  const ordered = [
    ...(home ? [home] : []),
    ...groups.flatMap((group) => group.routes.flatMap((route) => byRoute.get(route) ?? [])),
    ...unlisted,
  ];
  const full = [
    `# Triplex documentation\n\n> ${summary}\n\n${keyFacts}\n`,
    ...[...new Map(ordered.map((page) => [page.route, page])).values()].map(
      (page) => `<!-- Source: ${siteUrl}${page.route} -->\n\n${page.markdown}`,
    ),
  ].join("\n---\n\n");

  const files = new Map<string, string>([
    ["llms.txt", `${index.join("\n").trim()}\n`],
    ["llms-full.txt", full],
  ]);
  for (const page of pages) files.set(page.file, page.markdown);
  return files;
};

/** Writes the agent-readable files next to the built HTML. */
export const writeLlmsFiles = async (
  srcDir: string,
  outDir: string,
  sidebar: DefaultTheme.SidebarItem[],
) => {
  const files = await renderLlmsFiles(srcDir, sidebar);
  await Promise.all(
    [...files].map(async ([name, content]) => {
      const path = join(outDir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }),
  );
  console.log(`Wrote llms.txt, llms-full.txt, and ${files.size - 2} Markdown pages.`);
};

/** The slice of Vite's dev server this plugin uses; `vite` is not a direct dependency. */
interface DevServer {
  readonly middlewares: {
    use(
      handler: (
        request: IncomingMessage,
        response: ServerResponse,
        next: (error?: unknown) => void,
      ) => void,
    ): void;
  };
}

/** Serves the same files from the dev server. */
export const llmsDevServer = (srcDir: string, sidebar: DefaultTheme.SidebarItem[]) => ({
  name: "triplex:llms",
  apply: "serve" as const,
  configureServer(server: DevServer) {
    server.middlewares.use((request, response, next) => {
      const [pathname = "", query] = (request.url ?? "").split("?");
      const path = decodeURIComponent(pathname).replace(/^\//, "");
      const isLlms = /^llms(-full)?\.txt$/.test(path);
      // The dev client imports pages as `/<page>.md` modules; only answer plain fetches.
      const isPageMarkdown =
        /^(?:[\w-]+\/)*[\w-]+\.md$/.test(path) &&
        query === undefined &&
        request.headers["sec-fetch-dest"] !== "script";
      if (!isLlms && !isPageMarkdown) return next();
      renderLlmsFiles(srcDir, sidebar)
        .then((files) => {
          const content = files.get(path);
          if (content === undefined) return next();
          response.setHeader(
            "Content-Type",
            `${path.endsWith(".md") ? "text/markdown" : "text/plain"}; charset=utf-8`,
          );
          response.end(content);
        })
        .catch(next);
    });
  },
});
