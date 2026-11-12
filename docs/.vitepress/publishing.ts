export interface Post {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly date: string;
  readonly series: string;
}

interface Content {
  readonly url: string;
  readonly frontmatter: Record<string, unknown>;
}

/** Newest first, with a stable reading order for posts published on the same day. */
export const publishedPosts = (pages: Content[]): Post[] =>
  pages
    .filter((page) => !page.url.endsWith("/") && page.frontmatter.draft !== true)
    .map(({ url, frontmatter }) => {
      const date =
        frontmatter.date instanceof Date
          ? frontmatter.date.toISOString().slice(0, 10)
          : String(frontmatter.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
        throw new Error(`Blog post ${url} needs a YYYY-MM-DD date`);
      }
      if (!frontmatter.title || !frontmatter.description) {
        throw new Error(`Blog post ${url} needs a title and description`);
      }
      return {
        url,
        title: String(frontmatter.title),
        description: String(frontmatter.description),
        date,
        series: String(frontmatter.series ?? ""),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url));

const xml = (value: string) =>
  value.replace(/[<>&"']/g, (character) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]!;
  });

export const renderFeed = (posts: Post[]) => {
  if (posts.length === 0) throw new Error("The blog feed must contain published posts");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Triplex blog</title>
  <subtitle>The database that remembers why.</subtitle>
  <id>https://triplex.build/blog/</id>
  <link href="https://triplex.build/feed.xml" rel="self" />
  <link href="https://triplex.build/blog/" />
  <updated>${posts[0]!.date}T00:00:00Z</updated>
  <author><name>Ben Jacobson</name></author>
${posts
  .map(
    (post) => `  <entry>
    <title>${xml(post.title)}</title>
    <id>https://triplex.build${xml(post.url)}</id>
    <link href="https://triplex.build${xml(post.url)}" />
    <published>${post.date}T00:00:00Z</published>
    <updated>${post.date}T00:00:00Z</updated>
    <summary>${xml(post.description)}</summary>
  </entry>`,
  )
  .join("\n")}
</feed>
`;
};
