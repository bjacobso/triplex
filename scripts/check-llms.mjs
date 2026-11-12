import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const siteUrl = new URL("https://triplex.build");
const index = await readFile(resolve(outDir, "llms.txt"), "utf8");

assert.match(index, /^# Triplex\n\n> \S[^\n]+\n/, "llms.txt needs an H1 and summary");
const summary = index.split("\n")[2];
assert.match(summary, /pre-1\.0/, "The summary must state maturity");
assert.match(
  summary,
  /npm install @triplex-build\/triplex/,
  "The summary must explain installation",
);
assert.doesNotMatch(index, /<!doctype|<html\b/i, "llms.txt must not be an HTML app shell");

const sections = index.split(/^## .+$/m).slice(1);
assert.ok(sections.length > 0, "llms.txt needs sections");
for (const section of sections) {
  const entries = section.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(entries.length > 0, "Each section needs documentation links");
  for (const entry of entries) {
    assert.match(entry, /^- \[[^\]]+\]\([^)]+\): \S/, "Links need titles and notes");
  }
}

let localLinks = 0;
for (const [, href] of index.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const url = new URL(href);
  assert.equal(url.protocol, "https:", `Use absolute HTTPS links: ${href}`);
  if (url.origin !== siteUrl.origin) continue;

  const pathname = decodeURIComponent(url.pathname);
  const file = resolve(outDir, `.${pathname}`);
  assert.ok(file.startsWith(`${outDir}${sep}`), `Link leaves the docs output: ${href}`);
  assert.ok((await stat(file)).isFile(), `Missing built page: ${href}`);
  // Check the actual asset, so an HTTP fallback cannot mask a missing page.
  if (/\.(md|txt)$/.test(pathname)) {
    const content = await readFile(file, "utf8");
    assert.ok(content.trim().length > 0, `Empty documentation: ${href}`);
    assert.doesNotMatch(content, /<!doctype|<html\b/i, `HTML fallback at ${href}`);
  }
  localLinks++;
}
assert.ok(localLinks > 0, "llms.txt must link to local documentation");
console.log(`Verified llms.txt structure and ${localLinks} local documentation links.`);

// Verify actual generated artifacts, rather than accepting a host's HTML fallback.
const feed = await readFile(resolve(outDir, "feed.xml"), "utf8");
assert.match(feed, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
const sourcePosts = (await readdir(resolve(outDir, "blog"), { recursive: true })).filter(
  (file) => file.endsWith(".html") && !file.endsWith("index.html"),
);
assert.equal((feed.match(/<entry>/g) ?? []).length, sourcePosts.length, "Feed needs every post");
assert.ok(sourcePosts.length > 0, "Feed must not be empty");
for (const file of sourcePosts) {
  const html = await readFile(resolve(outDir, "blog", file), "utf8");
  assert.match(
    html,
    /<time\b[^>]*datetime="\d{4}-\d{2}-\d{2}"/,
    `${file}: visible publication date`,
  );
}
for (const file of ["blog/index.html", "blog/remembers-why/index.html"]) {
  const html = await readFile(resolve(outDir, file), "utf8");
  assert.match(html, /class="blog-posts"/, `${file}: server-rendered post list`);
  assert.match(html, /<time\b[^>]*datetime="\d{4}-\d{2}-\d{2}"/, `${file}: generated dates`);
}

assert.doesNotMatch(feed, /href="\//, "Feed URLs must be absolute");
const sitemap = await readFile(resolve(outDir, "sitemap.xml"), "utf8");
assert.match(sitemap, /<urlset\b/);
assert.match(sitemap, /<loc>https:\/\/triplex.build\//);
assert.doesNotMatch(sitemap, /\/rfcs\//);
const robots = await readFile(resolve(outDir, "robots.txt"), "utf8");
assert.match(robots, /^Sitemap: https:\/\/triplex.build\/sitemap.xml$/m);
const png = await readFile(resolve(outDir, "share.png"));
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Share image must be PNG");
assert.equal(png.readUInt32BE(16), 1200);
assert.equal(png.readUInt32BE(20), 630);
const files = await readdir(outDir, { recursive: true });
assert.ok(!files.some((file) => file.startsWith("rfcs/")), "RFCs must not be published");
assert.doesNotMatch(index, /https:\/\/triplex.build\/rfcs\//);
const full = await readFile(resolve(outDir, "llms-full.txt"), "utf8");
assert.doesNotMatch(full, /<!-- Source: https:\/\/triplex.build\/rfcs\//);
for (const file of files.filter((file) => file.endsWith(".html"))) {
  const html = await readFile(resolve(outDir, file), "utf8");
  for (const property of ["og:title", "og:description", "og:image"]) {
    assert.match(
      html,
      new RegExp(`<meta property="${property}" content="[^"]+"`),
      `${file}: ${property}`,
    );
  }
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/, file);
}
console.log("Verified feed, sitemap, robots, share image, social metadata and RFC exclusion.");
