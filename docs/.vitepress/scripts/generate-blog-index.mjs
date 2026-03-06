import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getBlogPosts() {
  const postsDir = join(__dirname, "..", "..", "blog", "posts");
  try {
    const files = readdirSync(postsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const slug = f.replace(/\.md$/, "");
        const filePath = join(postsDir, f);
        const content = readFileSync(filePath, "utf-8");
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let title = null;
        let date = null;
        if (match) {
          const fm = match[1];
          const t = fm.match(/^title:\s*(.+)$/m);
          const d = fm.match(/^date:\s*(.+)$/m);
          title = t ? t[1].trim().replace(/^["']|["']$/g, "") : null;
          date = d ? d[1].trim() : null;
        }
        const fallbackTitle = slug
          .replace(/^\d{4}-\d{2}-\d{2}-/, "")
          .replace(/-/g, " ");
        const dateFromFilename = slug.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
        return {
          slug,
          title: title ?? fallbackTitle,
          date: date ?? dateFromFilename ?? "1970-01-01",
          link: `/blog/posts/${slug}`,
        };
      });
    return files.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

const indexPath = join(__dirname, "..", "..", "blog", "index.md");
let content = readFileSync(indexPath, "utf-8");

const posts = getBlogPosts();
const list = posts
  .map((p) => `- **${p.date}** — [${p.title}](${p.link})`)
  .join("\n");

const startMarker = "<!-- BLOG_POSTS -->";
const endMarker = "<!-- /BLOG_POSTS -->";
const regex = new RegExp(
  `${startMarker}[\\s\\S]*?${endMarker}`,
  "g"
);

const replacement = posts.length > 0
  ? `${startMarker}\n${list}\n${endMarker}`
  : `${startMarker}\n*No posts yet.*\n${endMarker}`;

content = content.replace(regex, replacement);
writeFileSync(indexPath, content);
