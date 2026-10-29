import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { type DefaultTheme, defineConfig } from "vitepress";

import { workspaceAliases } from "../../vitest.workspace-aliases.js";
import { llmsDevServer, writeLlmsFiles } from "./llms.js";

const srcDir = resolve(import.meta.dirname, "..");

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "Start",
    items: [
      { text: "Getting started", link: "/getting-started" },
      { text: "Modeling a back-office domain", link: "/agents" },
      { text: "Playground", link: "/playground" },
      { text: "Core concepts", link: "/concepts" },
      { text: "Current state", link: "/current-state" },
    ],
  },
  {
    text: "Learn",
    items: [
      { text: "Datalog", link: "/datalog" },
      { text: "Configuration walkthrough", link: "/configuration-versioning" },
      { text: "Derivations", link: "/derivations" },
      { text: "Provenance", link: "/provenance" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Configuration", link: "/configuration" },
      { text: "Operational primitives", link: "/operational-primitives" },
      { text: "Import segments", link: "/segments" },
      { text: "Configuration HTTP API", link: "/http-api" },
      { text: "Performance", link: "/performance" },
      {
        text: "Architecture",
        link: "https://github.com/bjacobso/triplex/blob/main/ARCHITECTURE.md",
      },
    ],
  },
  {
    text: "Operate",
    items: [
      { text: "CLI and dashboard", link: "/tools" },
      { text: "Data explorer", link: "/explorer" },
      { text: "Host integration", link: "/host-integration" },
      { text: "Troubleshooting and FAQ", link: "/troubleshooting" },
      { text: "Releasing", link: "/releasing" },
    ],
  },
  {
    text: "Backend blueprints",
    items: [
      { text: "Overview", link: "/backends" },
      { text: "SQLite · supported", link: "/sqlite" },
      { text: "FoundationDB · experimental", link: "/foundationdb" },
      { text: "Datomic · proposed", link: "/datomic" },
      { text: "XTDB · proposed", link: "/xtdb" },
    ],
  },
  {
    text: "Project",
    items: [
      { text: "Custom runtimes", link: "/custom-runtimes" },
      { text: "Roadmap", link: "/roadmap" },
    ],
  },
];

export default defineConfig({
  lang: "en-US",
  title: "Triplex",
  titleTemplate: ":title · Triplex",
  description:
    "The database that remembers why: an embedded fact database for TypeScript back-office systems, built on Effect.",
  cleanUrls: true,
  // Snippet outputs are included into pages, never published as pages themselves.
  srcExclude: ["snippets/**"],
  lastUpdated: true,
  outDir: resolve(import.meta.dirname, "../../dist"),
  buildEnd: (site) => writeLlmsFiles(srcDir, site.outDir, sidebar),
  vite: {
    plugins: [tailwindcss(), llmsDevServer(srcDir, sidebar)],
    resolve: { alias: workspaceAliases() },
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/mark.svg" }],
    ["meta", { name: "theme-color", content: "#0b1020" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Triplex" }],
    // Machine-readable entry points for coding agents: https://llmstxt.org
    ["link", { rel: "alternate", type: "text/plain", href: "/llms.txt", title: "llms.txt" }],
    [
      "link",
      { rel: "alternate", type: "text/plain", href: "/llms-full.txt", title: "llms-full.txt" },
    ],
  ],
  markdown: {
    theme: { light: "tokyo-night", dark: "tokyo-night" },
    languages: ["js", "json", "sh", "sql", "ts"],
  },
  themeConfig: {
    logo: { src: "/mark.svg", alt: "Triplex" },
    siteTitle: "Triplex",
    nav: [
      { text: "Get started", link: "/getting-started" },
      { text: "Modeling guide", link: "/agents" },
      { text: "Playground", link: "/playground" },
      { text: "Concepts", link: "/concepts" },
      {
        text: "Reference",
        items: [
          { text: "Datalog", link: "/datalog" },
          { text: "Configuration", link: "/configuration" },
          { text: "Operational primitives", link: "/operational-primitives" },
          { text: "HTTP API", link: "/http-api" },
          { text: "Backend blueprints", link: "/backends" },
        ],
      },
      { text: "Operate", link: "/tools" },
    ],
    sidebar,
    search: {
      provider: "local",
      options: { detailedView: true },
    },
    outline: { level: [2, 3], label: "On this page" },
    socialLinks: [{ icon: "github", link: "https://github.com/bjacobso/triplex" }],
    editLink: {
      pattern: "https://github.com/bjacobso/triplex/edit/main/docs/:path",
      text: "Edit this page",
    },
    lastUpdated: { text: "Last updated" },
    docFooter: { prev: "Previous", next: "Continue" },
    externalLinkIcon: true,
    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2026 Ben Jacobson",
    },
  },
});
