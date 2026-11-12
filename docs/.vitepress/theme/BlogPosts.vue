<script setup lang="ts">
import { computed } from "vue";
import { data } from "../posts.data.js";
import type { Post } from "../publishing.js";

const props = defineProps<{ series?: string }>();
const posts = computed(() =>
  (data as Post[]).filter((post) => !props.series || post.series === props.series),
);
</script>

<template>
  <p v-if="series">{{ posts.length }} of 12 published.</p>
  <ul class="blog-posts">
    <li v-for="post in posts" :key="post.url">
      <a :href="post.url">{{ post.title }}</a>
      <time :datetime="post.date">{{ post.date }}</time>
      <p>{{ post.description }}</p>
    </li>
  </ul>
</template>

<style scoped>
.blog-posts {
  list-style: none;
  padding: 0;
}
.blog-posts li {
  margin: 1.5rem 0;
}
.blog-posts a {
  font-size: 1.2rem;
}
.blog-posts time {
  display: block;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
}
.blog-posts p {
  margin-top: 0.25rem;
}
</style>
