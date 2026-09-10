import { dirname, resolve } from "node:path";

import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import ts from "typescript";
import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "Triplex",
  titleTemplate: ":title · Triplex",
  description: "A temporal fact database for TypeScript, built on Effect.",
  cleanUrls: true,
  lastUpdated: true,
  outDir: resolve(import.meta.dirname, "../../dist"),
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/mark.svg" }],
    ["meta", { name: "theme-color", content: "#0b1020" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Triplex" }],
  ],
  markdown: {
    theme: { light: "tokyo-night", dark: "tokyo-night" },
    languages: ["js", "json", "sh", "sql", "ts"],
    codeTransformers: [
      transformerTwoslash({
        throws: true,
        twoslashOptions: {
          tsModule: ts,
          tsLibDirectory: dirname(ts.getDefaultLibFilePath({})),
          vfsRoot: resolve(import.meta.dirname, "../snippets/home"),
          cache: process.env.NODE_ENV === "production",
          fsCache: process.env.NODE_ENV === "production",
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            allowImportingTsExtensions: true,
            noEmit: true,
            strict: true,
            baseUrl: resolve(import.meta.dirname, "../.."),
            paths: {
              "@triplex-build/triplex": ["packages/core/src/index.ts"],
              "@triplex-build/triplex/config": ["packages/core/src/config/index.ts"],
            },
          },
        },
      }),
    ],
  },
  themeConfig: {
    logo: { src: "/mark.svg", alt: "Triplex" },
    siteTitle: "Triplex",
    nav: [
      { text: "Current state", link: "/current-state" },
      { text: "Datalog", link: "/datalog" },
      { text: "Configuration", link: "/configuration" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Current state", link: "/current-state" },
          {
            text: "Architecture",
            link: "https://github.com/bjacobso/triplex/blob/main/ARCHITECTURE.md",
          },
        ],
      },
      {
        text: "Core",
        items: [
          { text: "Datalog", link: "/datalog" },
          { text: "Configuration", link: "/configuration" },
          { text: "Derivations", link: "/derivations" },
          { text: "Provenance", link: "/provenance" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Operational primitives", link: "/operational-primitives" },
          { text: "Host integration", link: "/host-integration" },
          { text: "Configuration HTTP API", link: "/http-api" },
          { text: "Performance", link: "/performance" },
          { text: "Releasing", link: "/releasing" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
    ],
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
