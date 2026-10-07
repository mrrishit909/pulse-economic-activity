import type { NextConfig } from "next";

// Static export: the public sandbox is plain files (GitHub Pages under /projects/pulse-economic-activity/demo, or nginx in Docker).
// Built with webpack (`next build --webpack`): Turbopack hung on this monorepo during the template build.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const config: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@pulse/domain", "@pulse/motion", "@pulse/telemetry", "@pulse/sdk"],
  typescript: { ignoreBuildErrors: true }, // type-checked separately by `npm run typecheck`
  productionBrowserSourceMaps: false,
};
export default config;
