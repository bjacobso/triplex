import { createContentLoader } from "vitepress";
import { type Post, publishedPosts } from "./publishing.js";

export declare const data: Post[];

export default createContentLoader("blog/**/*.md", { transform: publishedPosts });
