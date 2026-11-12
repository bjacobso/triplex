import "@fontsource/ibm-plex-mono/400.css";
import { type Theme, useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { defineComponent, h } from "vue";

import "./custom.css";
import "./home.css";
import "./blueprint.css";
import BlogPosts from "./BlogPosts.vue";
import Playground from "./Playground.vue";
import TriplexExplorer from "./TriplexExplorer.vue";
import DecisionTrace from "./DecisionTrace.vue";
import StackMap from "./StackMap.vue";

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    setup() {
      const { frontmatter } = useData();
      return () =>
        h(DefaultTheme.Layout, null, {
          "doc-before": () =>
            frontmatter.value.date
              ? h("p", { class: "post-date" }, [
                  h("time", { datetime: frontmatter.value.date }, frontmatter.value.date),
                ])
              : null,
          "layout-top": () =>
            frontmatter.value.pageClass === "triplex-index"
              ? h("p", { class: "worldvm-banner" }, [
                  "Triplex is an incubation project within ",
                  h("a", { href: "https://worldvm.com/" }, "WorldVM"),
                  ".",
                ])
              : null,
        });
    },
  }),
  enhanceApp({ app }) {
    app.component("BlogPosts", BlogPosts);
    app.component("DecisionTrace", DecisionTrace);
    app.component("StackMap", StackMap);
    app.component("TriplexPlayground", Playground);
    app.component("TriplexExplorer", TriplexExplorer);
  },
} satisfies Theme;
