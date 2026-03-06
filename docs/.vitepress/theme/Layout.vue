<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import EssayArticleHeader from "./EssayArticleHeader.vue";

const route = useRoute();
const isEssay = computed(() =>
  route.path.includes("blog/posts")
);

const DefaultLayout = DefaultTheme.Layout;
</script>

<template>
  <template v-if="isEssay">
    <div class="Layout Layout--essay">
      <EssayArticleHeader />
      <main class="VPContent VPContent--essay">
        <div class="vp-doc container">
          <Content />
        </div>
      </main>
    </div>
  </template>
  <DefaultLayout v-else />
</template>

<style scoped>
.Layout--essay {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.VPContent--essay {
  flex-grow: 1;
  margin-top: calc(var(--vp-nav-logo-height) * 5 + 1rem);
  padding-top: 0;
}

.VPContent--essay .container {
  margin: auto;
  width: 100%;
  max-width: 1280px;
  padding: 0 24px 4rem;
}

@media (min-width: 640px) {
  .VPContent--essay .container {
    padding: 0 48px 5rem;
  }
}

@media (min-width: 960px) {
  .VPContent--essay .container {
    padding: 0 64px 6rem;
  }
}
</style>
