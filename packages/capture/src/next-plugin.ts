import { createRequire } from "node:module";

interface NextConfigLike {
  webpack?: (config: Record<string, unknown>, options: { dev?: boolean }) => Record<string, unknown>;
  [key: string]: unknown;
}

export function withHeckle(config: NextConfigLike = {}): NextConfigLike {
  const require = createRequire(import.meta.url);
  return {
    ...config,
    webpack(webpackConfig, options) {
      const nextConfig = config.webpack ? config.webpack(webpackConfig, options) : webpackConfig;
      if (!options.dev) return nextConfig;
      const rules = ((nextConfig.module as { rules?: unknown[] } | undefined)?.rules ?? []);
      const moduleConfig = { ...(nextConfig.module as Record<string, unknown> | undefined), rules };
      rules.unshift({
        test: /\.[jt]sx$/,
        exclude: /node_modules/,
        enforce: "pre",
        use: [{ loader: require.resolve("./source-loader.cjs") }],
      });
      return { ...nextConfig, module: moduleConfig };
    },
  };
}

export default withHeckle;
