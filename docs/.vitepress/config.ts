import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/Yggdrasil/",
  title: "Yggdrasil",
  description: "Architecture guardrails your AI coding agent can't skip — policy-as-code for coding agents, enforced in the loop and re-checked free in CI. A drift gate for your architecture.",
  vite: {
    build: {
      // esbuild is force-upgraded to >= 0.28.1 via an npm `overrides` entry to patch two
      // security advisories. esbuild 0.28 refuses to down-level modern syntax (e.g.
      // destructuring) to Vite 5.4's default browser target (chrome87/es2020), failing the
      // build. Raise the target to es2022 so no down-level transform is attempted. Trade-off:
      // the generated docs site requires a reasonably modern browser (≈2022+).
      target: "es2022",
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "How It Works", link: "/how-it-works" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "GitHub", link: "https://github.com/krzysztofdudek/Yggdrasil" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "How It Works", link: "/how-it-works" },
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Core concepts",
        items: [
          { text: "Aspects", link: "/aspects" },
          { text: "Nodes", link: "/nodes" },
          { text: "Relations, Flows & Ports", link: "/relations-flows-ports" },
        ],
      },
      {
        text: "Author & operate",
        items: [
          { text: "The Portal", link: "/portal" },
          { text: "Reviewers", link: "/reviewers" },
          { text: "Model-Swap Protocol", link: "/model-swap-protocol" },
          { text: "Aspect Status", link: "/aspect-status" },
          { text: "Conditional Aspects", link: "/conditional-aspects" },
          { text: "Configuration", link: "/configuration" },
          { text: "CLI Reference", link: "/cli-reference" },
          { text: "Running in Parallel", link: "/concurrency" },
          { text: "Supported Platforms", link: "/platforms" },
        ],
      },
      {
        text: "Reference & deep dives",
        items: [
          { text: "The Lock", link: "/the-lock" },
          { text: "Meta-modeling", link: "/meta-modeling" },
          { text: "Dogfood Showcase", link: "/showcase" },
        ],
      },
    ],
  },
});
