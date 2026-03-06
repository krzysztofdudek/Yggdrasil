<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useData } from "vitepress";
import { withBase } from "vitepress";
import VPImage from "vitepress/dist/client/theme-default/components/VPImage.vue";
import VPSwitchAppearance from "vitepress/dist/client/theme-default/components/VPSwitchAppearance.vue";

const { site, theme } = useData();
const scrolled = ref(false);

const SCROLL_THRESHOLD = 80;

function onScroll() {
  scrolled.value = window.scrollY > SCROLL_THRESHOLD;
}

onMounted(() => {
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
});

onUnmounted(() => {
  window.removeEventListener("scroll", onScroll);
});
</script>

<template>
  <header class="EssayArticleHeader" :class="{ 'is-scrolled': scrolled }">
    <a class="logo-link" :href="withBase('/')">
      <VPImage
        v-if="theme.logo"
        class="logo"
        :image="theme.logo"
        :alt="site.title"
      />
      <span v-else class="site-title">{{ site.title }}</span>
    </a>
    <div
      v-if="
        site.appearance &&
        site.appearance !== 'force-dark' &&
        site.appearance !== 'force-auto'
      "
      class="appearance"
    >
      <VPSwitchAppearance />
    </div>
  </header>
</template>

<style scoped>
.EssayArticleHeader {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--vp-z-index-nav);
  min-height: calc(var(--vp-nav-logo-height) * 5 + 1rem);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  background-color: color-mix(in srgb, var(--vp-nav-bg-color) 20%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--vp-c-divider) 20%, transparent);
  backdrop-filter: blur(8px);
  transition: min-height 0.25s ease, padding 0.25s ease;
}

.EssayArticleHeader.is-scrolled {
  min-height: var(--vp-nav-height);
  padding: 0 1rem;
}

.logo-link {
  display: flex;
  align-items: center;
  text-decoration: none;
  color: var(--vp-c-text-1);
  padding: 0.5rem 0;
  transition: padding 0.25s ease;
}

.EssayArticleHeader.is-scrolled .logo-link {
  padding: 0.15rem 0;
}

.logo-link:hover {
  opacity: 0.8;
}

:deep(.logo) {
  height: calc(var(--vp-nav-logo-height) * 5);
  transition: height 0.25s ease;
}

.EssayArticleHeader.is-scrolled :deep(.logo) {
  height: calc(var(--vp-nav-logo-height) * 1.35);
}

.site-title {
  font-size: 16px;
  font-weight: 600;
}

.appearance {
  position: absolute;
  right: 1rem;
  display: flex;
  align-items: center;
}
</style>
