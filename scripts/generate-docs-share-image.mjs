// Requires librsvg's rsvg-convert. The PNG is checked in; ordinary builds need no renderer.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

execFileSync(
  "rsvg-convert",
  [
    "--width",
    "1200",
    "--height",
    "630",
    "--output",
    fileURLToPath(new URL("../docs/public/share.png", import.meta.url)),
    fileURLToPath(new URL("../docs/public/share.svg", import.meta.url)),
  ],
  { stdio: "inherit" },
);
