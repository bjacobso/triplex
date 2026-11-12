import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publishedPosts, renderFeed } from "../docs/.vitepress/publishing.js";
import { renderLlmsFiles } from "../docs/.vitepress/llms.js";

test("published posts exclude indexes and drafts and sort by date then URL", () => {
  const post = (url: string, date: string, draft = false) => ({
    url,
    frontmatter: { title: "Facts & rules", description: "A < B", date, draft },
  });
  const posts = publishedPosts([
    post("/blog/", "2026-11-08"),
    post("/blog/old", "2026-11-07"),
    post("/blog/draft", "2026-11-09", true),
    post("/blog/b", "2026-11-08"),
    post("/blog/a", "2026-11-08"),
  ]);
  assert.deepEqual(
    posts.map((post) => post.url),
    ["/blog/a", "/blog/b", "/blog/old"],
  );
  assert.equal(
    publishedPosts([
      {
        url: "/blog/yaml-date",
        frontmatter: {
          title: "YAML date",
          description: "Unquoted YAML dates",
          date: new Date("2026-11-08T00:00:00Z"),
        },
      },
    ])[0]!.date,
    "2026-11-08",
  );
  const feed = renderFeed(posts);
  assert.equal((feed.match(/<entry>/g) ?? []).length, 3);
  assert.match(feed, /https:\/\/triplex.build\/blog\/a/);
  assert.match(feed, /Facts &amp; rules/);
  assert.match(feed, /A &lt; B/);
  assert.match(feed, /2026-11-08T00:00:00Z/);
  assert.throws(() => publishedPosts([post("/blog/invalid", "yesterday")]));
});

test("RFCs and snippets never enter the public agent documentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "triplex-docs-"));
  try {
    await mkdir(join(root, "rfcs"));
    await mkdir(join(root, "snippets"));
    await writeFile(join(root, "index.md"), "# Triplex\n\nPublic guide.");
    await writeFile(join(root, "rfcs/private.md"), "# Internal design secret");
    await writeFile(join(root, "snippets/output.md"), "# Snippet secret");
    const files = await renderLlmsFiles(root, []);
    assert.deepEqual([...files.keys()].sort(), ["index.md", "llms-full.txt", "llms.txt"]);
    assert.doesNotMatch(files.get("llms-full.txt")!, /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
