// Plain object so the config loads without importing vitest/config.
export default {
  test: { environment: "node", include: ["test/**/*.test.ts"] },
};
