import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import TwoslashFloatingVue from "@shikijs/vitepress-twoslash/client";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { h } from "vue";

import "@shikijs/vitepress-twoslash/style.css";
import "./custom.css";
import Playground from "./Playground.vue";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "layout-top": () =>
        h("div", { class: "triplex-prerelease", role: "status" }, [
          "Pre-1.0 · new npm scope not published yet · use source checkout · ",
          h("a", { href: "/current-state" }, "current state"),
        ]),
    }),
  enhanceApp({ app }) {
    app.component("TriplexPlayground", Playground);
    app.use(TwoslashFloatingVue, {
      themes: {
        twoslash: {
          flip: true,
          triggers: ["hover", "click"],
          popperTriggers: ["hover"],
        },
      },
    });
  },
} satisfies Theme;
