import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/Yggdrasil/",
  title: "Yggdrasil",
  description: "Continuous architecture enforcement for AI-assisted development",
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "GitHub", link: "https://github.com/krzysztofdudek/Yggdrasil" },
    ],
    sidebar: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "Core Concepts", link: "/core-concepts" },
      { text: "Supported Platforms", link: "/platforms" },
      { text: "CLI Reference", link: "/cli-reference" },
      { text: "Configuration", link: "/configuration" },
    ],
  },
});
