import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import TwoslashFloatingVue from "@shikijs/vitepress-twoslash/client";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { h } from "vue";

import "@shikijs/vitepress-twoslash/style.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "layout-top": () =>
        h("div", { class: "triplex-prerelease", role: "status" }, [
          "Pre-1.0 canary · install with @next · requires effect@4.0.0-rc.112 · ",
          h("a", { href: "/current-state" }, "current state"),
        ]),
    }),
  enhanceApp({ app }) {
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
