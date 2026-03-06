import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  link: string;
}

function parseFrontmatter(filePath: string): { title: string | null; date: string | null } {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { title: null, date: null };
    const fm = match[1];
    const titleMatch = fm.match(/^title:\s*(.+)$/m);
    const dateMatch = fm.match(/^date:\s*(.+)$/m);
    const title = titleMatch
      ? titleMatch[1].trim().replace(/^["']|["']$/g, "")
      : null;
    const date = dateMatch ? dateMatch[1].trim() : null;
    return { title, date };
  } catch {
    return { title: null, date: null };
  }
}

export function getBlogPosts(): BlogPost[] {
  const postsDir = join(__dirname, "..", "blog", "posts");
  try {
    const files = readdirSync(postsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const slug = f.replace(/\.md$/, "");
        const filePath = join(postsDir, f);
        const { title, date } = parseFrontmatter(filePath);
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
